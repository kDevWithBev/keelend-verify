// Proof-of-reserves tests with an in-code fixture. Run from the verifier folder: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PINNED, dueRaw } from "../audit.mjs";
import { computeReserves, liqPrice, readBalances, renderHtml, replayLoans } from "../reserves.mjs";

const H = PINNED.house;
const t0 = Date.parse("2026-10-13T00:00:00Z");
const at = (s) => new Date(t0 + s * 1000).toISOString();
const NOW = t0 + 30 * 86400 * 1000;
const KTA = 10n ** 18n;

function fixture() {
  let seq = 0;
  const r = (s, event, fields) => ({ v: 1, seq: seq++, at: at(s), event, hash: "h" + seq, prevHash: "p", ...fields });
  const records = [
    r(0, "genesis", { logKey: "keeta_logkey" }),
    // funded, $10, 300 KTA in vault, $1 repaid
    r(10, "open_quote", { loanId: "ln_f", borrower: "keeta_b_f", vault: "keeta_v_f", principalRaw: "10000000", maxLtv: "0.4", sizingMode: "float", holdUntil: at(910) }),
    r(20, "fund_intent", { loanId: "ln_f", borrower: "keeta_b_f", sendBlockHash: "F" }),
    r(40, "fund", { loanId: "ln_f", borrower: "keeta_b_f", blocks: ["F"] }),
    r(5000, "repayment_received", { loanId: "ln_f", borrower: "keeta_b_f", amountRaw: "1000000", totalReceivedRaw: "1000000" }),
    // waiting, not expired at NOW? holdUntil in the future
    r(30 * 86400 - 60, "open_quote", { loanId: "ln_w", borrower: "keeta_b_w", vault: "keeta_v_w", principalRaw: "2000000", maxLtv: "0.25", sizingMode: "float", holdUntil: at(30 * 86400 + 840) }),
    // stuck send
    r(100, "open_quote", { loanId: "ln_s", borrower: "keeta_b_s", vault: "keeta_v_s", principalRaw: "3000000", maxLtv: "0.25", sizingMode: "exact", holdUntil: at(1000) }),
    r(110, "fund_intent", { loanId: "ln_s", borrower: "keeta_b_s", sendBlockHash: "S" }),
    r(240, "stuck_send", { loanId: "ln_s", borrower: "keeta_b_s", sendBlockHash: "S", reason: "not found" }),
    // expired by time, not yet refunded in the log: no reservation
    r(200, "open_quote", { loanId: "ln_x", borrower: "keeta_b_x", vault: "keeta_v_x", principalRaw: "4000000", maxLtv: "0.25", holdUntil: at(1100) }),
    // closed with an overpayment of 0.5 USDC not yet refunded
    r(300, "open_quote", { loanId: "ln_c", borrower: "keeta_b_c", vault: "keeta_v_c", principalRaw: "1000000", maxLtv: "0.25", holdUntil: at(1200) }),
    r(310, "fund_intent", { loanId: "ln_c", borrower: "keeta_b_c", sendBlockHash: "C" }),
    r(320, "fund", { loanId: "ln_c", borrower: "keeta_b_c", blocks: ["C"] }),
    r(900, "close", { loanId: "ln_c", borrower: "keeta_b_c", totalReceivedRaw: "1500000", dueRaw: "1000000", ktaReturnedRaw: "1" }),
  ];
  const balances = {
    [H.inventory]: { [PINNED.usdc]: "39000000", [PINNED.kta]: String(3n * KTA) },
    [H.servicing]: { [PINNED.usdc]: "1000000" },
    [PINNED.treasury]: { [PINNED.usdc]: "70000" },
    keeta_v_f: { [PINNED.kta]: String(300n * KTA) },
    keeta_v_w: { [PINNED.kta]: String(10n * KTA) },
    keeta_v_s: { [PINNED.kta]: String(200n * KTA) },
  };
  return { records, balances };
}

test("lendable = inventory − reservations for waiting, sending and stuck vaults (expired ones release)", () => {
  const { records, balances } = fixture();
  const r = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW });
  assert.equal(r.reservedUsdcRaw, String(2_000_000 + 3_000_000));
  assert.equal(r.lendableUsdcRaw, String(39_000_000 - 5_000_000));
  assert.equal(r.collected.servicingUsdcRaw, "1000000");
  assert.equal(r.collected.treasuryUsdcRaw, "70000");
  const statuses = Object.fromEntries(r.loans.map((l) => [l.id, l.status]));
  assert.deepEqual(statuses, { ln_f: "funded", ln_w: "awaiting-kta", ln_s: "stuck-send" });
  assert.equal(replayLoans(records, NOW).find((l) => l.id === "ln_x").status, "expired");
});

test("outstanding principal, interest and per-loan debt use the keeper's interest function", () => {
  const { records, balances } = fixture();
  const r = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW });
  const due = dueRaw(10_000_000n, t0 + 20_000, NOW);
  assert.equal(r.outstanding.principalRaw, "10000000");
  assert.equal(r.outstanding.interestRaw, String(due - 10_000_000n));
  const f = r.loans.find((l) => l.id === "ln_f");
  assert.equal(f.debtRaw, String(due)); // full amount due, like the keeper's liquidation check
  assert.equal(f.paidSoFarRaw, "1000000");
  assert.equal(r.outstanding.paidSoFarRaw, "1000000");
  assert.equal(f.sizingMode, "float");
  assert.equal(r.loans.find((l) => l.id === "ln_s").sizingMode, "exact");
  const expectedLtv = Number(due) / 1e6 / (300 * 0.068);
  assert.ok(Math.abs(f.ltv - expectedLtv) < 1e-12);
  assert.ok(Math.abs(f.liquidationPrice - Number(due) / 1e6 / (0.52 * 300)) < 1e-9);
});

test("a partial payment does not lower LTV; it is shown as paid so far", () => {
  const { records, balances } = fixture();
  const without = records.filter((x) => x.event !== "repayment_received");
  const a = computeReserves({ records: without, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW }).loans.find((l) => l.id === "ln_f");
  const b = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW }).loans.find((l) => l.id === "ln_f");
  assert.equal(a.ltv, b.ltv);
  assert.equal(a.liquidationPrice, b.liquidationPrice);
  assert.equal(a.paidSoFarRaw, "0");
  assert.equal(b.paidSoFarRaw, "1000000");
  assert.match(renderHtml(computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW })), /<th>Paid so far<\/th>/);
});

test("settled price uses min(spot, twap); unsettled shows LTV at both and no single LTV", () => {
  const { records, balances } = fixture();
  const settled = computeReserves({ records, balances, prices: { spot: 0.07, twap: 0.069 }, now: NOW });
  assert.equal(settled.price.status, "settled");
  assert.equal(settled.price.px, 0.069);
  const unsettled = computeReserves({ records, balances, prices: { spot: 0.08, twap: 0.068 }, now: NOW });
  assert.equal(unsettled.price.status, "price unsettled");
  const f = unsettled.loans.find((l) => l.id === "ln_f");
  assert.equal(f.ltv, null);
  assert.ok(f.ltvAtSpot < f.ltvAtTwap);
  const html = renderHtml(unsettled);
  assert.match(html, /Price unsettled/);
  assert.match(html, /spot \/ .* avg/);
  const missing = computeReserves({ records, balances, prices: { spot: 0.07, twap: null }, now: NOW });
  assert.equal(missing.price.status, "price unsettled");
});

test("price unavailable: no LTV, and the $0.10 preview is never used", () => {
  const { records, balances } = fixture();
  const r = computeReserves({ records, balances, prices: { error: "price unavailable" }, now: NOW });
  assert.equal(r.price.status, "price unavailable");
  assert.ok(r.loans.every((l) => l.ltv == null && l.ltvAtSpot == null && l.ltvAtTwap == null));
  assert.doesNotMatch(JSON.stringify(r) + renderHtml(r), /0\.1(?!\d)|\$0\.10/);
});

test("refunds owed vs servicing: red banner when short", () => {
  const { records, balances } = fixture();
  const ok = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW });
  assert.equal(ok.refunds.owedRaw, "500000");
  assert.equal(ok.refunds.short, false);
  assert.doesNotMatch(renderHtml(ok), /class="red"/);
  balances[H.servicing][PINNED.usdc] = "100000";
  const short = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW });
  assert.equal(short.refunds.short, true);
  assert.match(renderHtml(short), /<div class="red">Refunds owed/);
  records.push({ v: 1, seq: 99, at: at(950), event: "overpay_refund", loanId: "ln_c", borrower: "keeta_b_c", refundRaw: "500000", hash: "h", prevHash: "p" });
  assert.equal(computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW }).refunds.owedRaw, "0");
});

test("collateral vs debt, stuck-send highlighted, log head and verifier link; no external scripts", () => {
  const { records, balances } = fixture();
  const r = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW, signature: "verified" });
  assert.equal(r.collateral.ktaRaw, String(300n * KTA));
  const html = renderHtml(r, { verifierUrl: "https://example.test/verify" });
  assert.match(html, /<td class="hot">stuck-send<\/td>/);
  assert.match(html, /seq 13/);
  assert.match(html, /Signature: <b class="">verified<\/b>/);
  assert.match(html, /href="https:\/\/example.test\/verify"/);
  const noLink = renderHtml(r);
  assert.doesNotMatch(noLink, /Verify it yourself|keelend-verify|href=/);
  assert.doesNotMatch(html, /<script|<link|src=/i);
});

test("liquidation price: debt / (0.52 × KTA)", () => {
  assert.equal(liqPrice(5_200_000n, 100n * KTA), 0.1);
  assert.equal(liqPrice(1n, 0n), null);
});

test("balance reads are GET-only", async () => {
  const calls = [];
  const b = await readBalances("keeta_x", { api: "https://api.test", fetchImpl: async (url, init) => {
    calls.push(init?.method || "GET");
    return { ok: true, json: async () => ({ balances: [{ token: PINNED.usdc, balance: "0x10" }] }) };
  } });
  assert.deepEqual(calls, ["GET"]);
  assert.equal(b[PINNED.usdc], "16");
});

test("CLI writes reserves.json and reserves.html from a fixture", () => {
  const { records, balances } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "res-"));
  writeFileSync(join(dir, "log.jsonl"), records.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "fx.json"), JSON.stringify({ balances, prices: { spot: 0.068, twap: 0.068 } }));
  const script = fileURLToPath(new URL("../reserves.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script, join(dir, "log.jsonl"), "--out", dir, "--fixture", join(dir, "fx.json"), "--allow-unsigned", "--now", new Date(NOW).toISOString()], { encoding: "utf8" });
  assert.match(out, /lendable \$34\.000000/);
  assert.equal(JSON.parse(readFileSync(join(dir, "reserves.json"), "utf8")).loans.length, 3);
  assert.match(readFileSync(join(dir, "reserves.html"), "utf8"), /KeeLend proof of reserves/);
});
