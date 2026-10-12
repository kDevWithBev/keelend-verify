// Verifier tests with an in-code fixture (buildFixture below). Run from the verifier folder: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { audit, canonical, fetchHistory, verifyLog } from "../verify.mjs";
import { PINNED, dueRaw, exactNeed, floatNeed, replayOldLoan, seizeRaw } from "../audit.mjs";

// ---- Fixture: a two-loan log (repaid with refund; liquidated and settled) plus matching ledger history.
function buildFixture() {

  const H = PINNED.house;
  const B1 = "keeta_borrower_one", B2 = "keeta_borrower_two", V1 = "keeta_vault_one", V2 = "keeta_vault_two";
  const ANCHOR = "keeta_anchor_fx";
  const t0 = Date.parse("2026-10-13T00:00:00Z");
  const iso = (s) => new Date(t0 + s * 1000).toISOString();

  const records = [];
  let prev = "0".repeat(64);
  function rec(at, event, fields) {
    const r = { v: 1, seq: records.length, at: iso(at), event, prevHash: prev, ...fields };
    r.hash = createHash("sha256").update(canonical(r)).digest("hex");
    prev = r.hash;
    records.push(r);
    return r;
  }
  const history = {};
  function send(at, hash, from, to, token, amount, external) {
    const row = { $timestamp: iso(at), voteStaple: { blocks: [{ $hash: hash, account: from, date: iso(at), operations: [{ type: 0, to, token, amount: String(amount), ...(external ? { external } : {}) }] }] } };
    for (const a of new Set([from, to])) (history[a] ||= []).unshift(row);
  }

  rec(0, "genesis", { spec: "trust-log-and-reserves v4", house: H, treasury: PINNED.treasury, gas: PINNED.gas, usdc: PINNED.usdc, kta: PINNED.kta, anchors: [ANCHOR] });

  // Loan 1: open, fund, repay with overpayment, refund, close.
  const p1 = 3_640_000n, ltv1 = 0.25, spot1 = 0.0677, twap1 = 0.068;
  const q1 = floatNeed(p1, ltv1, spot1);
  rec(10, "open_quote", { loanId: "ln_one", borrower: B1, vault: V1, principalRaw: String(p1), maxLtv: "0.25", kycTier: "open", sizingMode: "float", quotedKtaRaw: String(q1), openSpot: String(spot1), openTwap: String(twap1), openPx: String(Math.min(spot1, twap1)), priceUsd: String(spot1), holdUntil: iso(10 + 900) });
  const need1 = floatNeed(p1, ltv1, spot1);
  rec(40, "kta_received", { loanId: "ln_one", borrower: B1, vault: V1, vaultBalanceRaw: String(need1 + 5n), requiredKtaRaw: String(need1) });
  rec(60, "fund_intent", { loanId: "ln_one", borrower: B1, principalRaw: String(p1), requiredKtaRaw: String(need1), inventoryBeforeRaw: "39000000", sendBlockHash: "FUND1", external: "keelend:ln_one" });
  send(61, "FUND1", H.inventory, B1, PINNED.usdc, p1, "keelend:ln_one");
  rec(80, "fund", { loanId: "ln_one", borrower: B1, principalRaw: String(p1), requiredKtaRaw: String(need1), fundSpot: String(spot1), fundTwap: String(twap1), fundPx: String(spot1), sizingMode: "float", inventoryBeforeRaw: "39000000", blocks: ["FUND1"], from: H.inventory });
  send(5000, "PAY1", B1, H.servicing, PINNED.usdc, 3_700_000n);
  rec(5010, "repayment_received", { loanId: "ln_one", borrower: B1, amountRaw: "3700000", totalReceivedRaw: "3700000", blocks: ["PAY1"] });
  const due1 = dueRaw(p1, t0 + 60_000, t0 + 5_020_000);
  const extra = 3_700_000n - due1;
  send(5020, "REFUND1", H.servicing, B1, PINNED.usdc, extra);
  rec(5021, "overpay_refund", { loanId: "ln_one", borrower: B1, refundRaw: String(extra), totalReceivedRaw: "3700000", dueRaw: String(due1), blocks: ["REFUND1"] });
  send(5030, "RETURN1", V1, B1, PINNED.kta, need1 + 5n);
  rec(5031, "close", { loanId: "ln_one", borrower: B1, principalRaw: String(p1), totalReceivedRaw: "3700000", dueRaw: String(due1), vaultBalanceRaw: String(need1 + 5n), ktaReturnedRaw: String(need1 + 5n), blocks: ["RETURN1"] });

  // Loan 2: open, fund, liquidate, sale, settle, gas sweep.
  const p2 = 10_000_000n, spot2 = 0.068;
  const q2 = floatNeed(p2, 0.4, spot2);
  rec(100, "open_quote", { loanId: "ln_two", borrower: B2, vault: V2, principalRaw: String(p2), maxLtv: "0.4", kycTier: "kyc", sizingMode: "float", quotedKtaRaw: String(q2), openSpot: String(spot2), openTwap: String(spot2), openPx: String(spot2), priceUsd: String(spot2), holdUntil: iso(1000) });
  rec(150, "fund_intent", { loanId: "ln_two", borrower: B2, principalRaw: String(p2), requiredKtaRaw: String(q2), inventoryBeforeRaw: "35360000", sendBlockHash: "FUND2", external: "keelend:ln_two" });
  send(151, "FUND2", H.inventory, B2, PINNED.usdc, p2, "keelend:ln_two");
  rec(170, "fund", { loanId: "ln_two", borrower: B2, principalRaw: String(p2), requiredKtaRaw: String(q2), fundSpot: String(spot2), fundTwap: String(spot2), fundPx: String(spot2), sizingMode: "float", blocks: ["FUND2"], from: H.inventory });
  const vault2 = q2, liqSpot = 0.04, debt = 10_000_100n, remainPrincipal = 10_000_000n;
  const liqDue = BigInt(Math.round(Number(debt) * 1.05));
  const seize = seizeRaw(liqDue, vault2, liqSpot);
  const rest = vault2 - seize;
  send(9000, "SEIZE2", V2, H.desk, PINNED.kta, seize);
  send(9001, "BACK2", V2, B2, PINNED.kta, rest);
  rec(9002, "liquidation", { loanId: "ln_two", borrower: B2, principalRaw: String(p2), debtRaw: String(debt), paidRaw: "0", liqDueRaw: String(liqDue), remainPrincipalRaw: String(remainPrincipal), seizeKtaRaw: String(seize), returnedKtaRaw: String(rest), vaultAtSeizeRaw: String(vault2), vaultAtCheckRaw: String(vault2), liqSpot: String(liqSpot), markSpot: String(liqSpot), markTwap: String(liqSpot), deskAccount: H.desk, forced: "false" });
  send(9100, "SALE2", H.desk, ANCHOR, PINNED.kta, seize - 3n * 10n ** 18n);
  const sale = liqDue + 250_000n;
  send(9101, "SALEIN2", ANCHOR, H.desk, PINNED.usdc, sale);
  send(9200, "SETP2", H.desk, H.inventory, PINNED.usdc, remainPrincipal);
  send(9201, "SETF2", H.desk, PINNED.treasury, PINNED.usdc, liqDue - remainPrincipal);
  send(9202, "SETS2", H.desk, B2, PINNED.usdc, 250_000n);
  rec(9203, "liquidation_settle", { loanId: "ln_two", borrower: B2, saleUsdcRaw: String(sale), coveredRaw: String(liqDue), principalToInventoryRaw: String(remainPrincipal), feeToTreasuryRaw: String(liqDue - remainPrincipal), usdcSurplusRaw: "250000", blocks: { principalToInventory: ["SETP2"], feeToTreasury: ["SETF2"], surplusToBorrower: ["SETS2"] } });
  send(9300, "SWEEP2", H.desk, PINNED.gas, PINNED.kta, 3n * 10n ** 18n);
  rec(9301, "gas_sweep", { loanId: "ln_two", borrower: B2, gasSweepKtaRaw: String(3n * 10n ** 18n), leftKtaRaw: "0", blocks: ["SWEEP2"] });

  // Gas top-up.
  send(9400, "TOPUP", PINNED.gas, H.checker, PINNED.kta, 2n * 10n ** 18n);
  rec(9401, "gas_topup", { to: H.checker, account: "checker", amountRaw: String(2n * 10n ** 18n), blocks: ["TOPUP"] });


  return { records, history };
}

const FIXTURE = buildFixture();
const LOG = FIXTURE.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const HISTORY = FIXTURE.history;
const records = () => LOG.trim().split("\n").map((line) => JSON.parse(line));
const history = () => new Map(Object.entries(structuredClone(HISTORY)));
const codes = (report, level = "FAIL") => report.items.filter((i) => i.level === level).map((i) => i.code);
const H = PINNED.house;

function addSend(map, hash, from, to, token, amount, at = "2026-10-13T05:00:00.000Z", external) {
  const row = { $timestamp: at, voteStaple: { blocks: [{ $hash: hash, account: from, date: at, operations: [{ type: 0, to, token, amount: String(amount), ...(external ? { external } : {}) }] }] } };
  for (const a of new Set([from, to])) map.set(a, [row, ...(map.get(a) || [])]);
}

test("happy path: chain OK, rules OK, every send reconciled; the unlogged anchor sale is only a WARN", () => {
  assert.equal(verifyLog(LOG, { allowUnsigned: true }).ok, true);
  const { report, stats } = audit(records(), history());
  assert.deepEqual(codes(report), []);
  assert.deepEqual(codes(report, "WARN"), ["UNLOGGED SEND"]);
  assert.equal(stats.sends, 12);
});

test("DOUBLE SEND: a second inventory -> borrower principal send fails", () => {
  const h = history();
  addSend(h, "FUND1B", H.inventory, "keeta_borrower_one", PINNED.usdc, 3_640_000n, "2026-10-13T00:01:30.000Z", "keelend:ln_one");
  const c = codes(audit(records(), h).report);
  assert.ok(c.includes("DOUBLE SEND"));
  assert.ok(c.includes("UNLOGGED SEND"));
});

test("funding block hash must match fund_intent; balance drops are never evidence", () => {
  const recs = records();
  recs.find((r) => r.event === "fund" && r.loanId === "ln_one").blocks = ["SOMETHING_ELSE"];
  const c = codes(audit(recs, history()).report);
  assert.ok(c.includes("FUND HASH"));
  assert.ok(c.includes("PHANTOM LOG ENTRY"));
  assert.ok(c.includes("UNLOGGED SEND")); // the real FUND1 send is now unlogged
});

test("PHANTOM LOG ENTRY: a logged block missing on-chain, or with a different amount", () => {
  const h = history();
  for (const [a, rows] of h) h.set(a, rows.filter((row) => row.voteStaple.blocks[0].$hash !== "REFUND1"));
  assert.ok(codes(audit(records(), h).report).includes("PHANTOM LOG ENTRY"));
  const recs = records();
  recs.find((r) => r.event === "gas_topup").amountRaw = "3000000000000000000";
  assert.ok(codes(audit(recs, history()).report).includes("PHANTOM LOG ENTRY"));
});

test("settlement split: principal, fee = remainLiq − remainPrincipal, surplus", () => {
  const recs = records();
  const settle = recs.find((r) => r.event === "liquidation_settle");
  settle.feeToTreasuryRaw = String(BigInt(settle.feeToTreasuryRaw) + 1n);
  assert.ok(codes(audit(recs, history()).report).includes("SETTLE"));
});

test("UNEXPECTED FLOW: servicing -> inventory restock, gas top-up of the wrong size, desk -> unknown", () => {
  const h = history();
  addSend(h, "MANUAL", H.servicing, H.inventory, PINNED.usdc, 1_000_000n);
  addSend(h, "BIGTOP", PINNED.gas, H.desk, PINNED.kta, 5n * 10n ** 18n);
  addSend(h, "ODD", H.desk, "keeta_stranger", PINNED.kta, 1n);
  const items = audit(records(), h).report.items.filter((i) => i.code === "UNEXPECTED FLOW").map((i) => i.block);
  assert.deepEqual(items.sort(), ["BIGTOP", "MANUAL", "ODD"]);
});

test("anchor counterparties come from genesis or --anchor; unknown ones are flagged", () => {
  const recs = records();
  delete recs[0].anchors;
  assert.ok(codes(audit(recs, history()).report).includes("UNEXPECTED FLOW"));
  assert.ok(!codes(audit(recs, history(), { anchors: ["keeta_anchor_fx"] }).report).includes("UNEXPECTED FLOW"));
});

test("pinned USDC: a wrong genesis token or a send in another token fails", () => {
  const recs = records();
  recs[0].usdc = "keeta_fake_usdc";
  assert.ok(codes(audit(recs, history()).report).includes("USDC TOKEN"));
  const h = history();
  addSend(h, "FAKEUSDC", H.inventory, "keeta_borrower_one", "keeta_fake_usdc", 3_640_000n);
  assert.ok(codes(audit(records(), h).report).includes("USDC TOKEN"));
});

test("gas sweep above 20 KTA fails", () => {
  const recs = records();
  recs.find((r) => r.event === "gas_sweep").gasSweepKtaRaw = String(21n * 10n ** 18n);
  assert.ok(codes(audit(recs, history()).report).includes("GAS SWEEP"));
});

test("rule replay: wrong quote size, fund* price not the min, liquidation seize", () => {
  const recs = records();
  recs.find((r) => r.event === "open_quote").quotedKtaRaw = "1";
  recs.find((r) => r.event === "fund" && r.loanId === "ln_one").fundPx = "0.068";
  recs.find((r) => r.event === "liquidation").seizeKtaRaw = "5";
  const c = codes(audit(recs, null).report);
  for (const code of ["OPEN SIZE", "FUND PRICE", "LIQ SEIZE"]) assert.ok(c.includes(code), code);
});

test("old-loan replay rule (§A5a)", () => {
  const base = { principalRaw: "3640000", maxLtv: "0.25", priceUsd: "0.0677" };
  assert.equal(replayOldLoan({ ...base, quotedKtaRaw: "217217134416543580160" }).level, "OK");
  assert.equal(replayOldLoan({ ...base, quotedKtaRaw: "217217134416543574594" }).level, "FAIL");
  assert.equal(replayOldLoan({ ...base, requiredKtaRaw: "217217134416543580160", openedAt: 1 }).level, "OK");
  assert.equal(replayOldLoan({ ...base, requiredKtaRaw: "1", openedAt: 1, pricedAt: 1 }).level, "FAIL");
  assert.equal(replayOldLoan({ ...base, requiredKtaRaw: "1", openedAt: 1, pricedAt: 2 }).level, "REPORT");
});

test("published sizing functions reproduce the real pairs", () => {
  assert.equal(floatNeed(3_640_000n, 0.25, 0.0677), 217217134416543580160n);
  assert.equal(exactNeed(3_640_000n, 0.25, 0.0677), 217217134416543574594n);
  assert.equal(floatNeed(550_000n, 0.25, 0.05), 44440000000000008192n);
  assert.equal(exactNeed(10_000_000n, 0.25, 0.068) - floatNeed(10_000_000n, 0.25, 0.068), 115652n);
});

test("fetchHistory is GET-only and pages with nextKey until older than since", async () => {
  const calls = [];
  const pages = [
    { history: [{ $timestamp: "2026-10-13T02:00:00Z" }], nextKey: "k1" },
    { history: [{ $timestamp: "2026-10-12T23:00:00Z" }], nextKey: "k2" },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    return { ok: true, json: async () => pages[calls.length - 1] || { history: [] } };
  };
  const rows = await fetchHistory("keeta_x", { api: "https://api.test", since: Date.parse("2026-10-13T00:00:00Z"), fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.match(calls[1].url, /start=k1/);
});

test("review fix 1: hashes compare case-insensitively (ledger $hash vs block.hash.toString())", () => {
  const h = history();
  for (const rows of h.values()) for (const row of rows) for (const block of row.voteStaple.blocks) block.$hash = block.$hash.toLowerCase();
  const { report } = audit(records(), h);
  assert.deepEqual(codes(report), []);
  const recs = records();
  const fund = recs.find((r) => r.event === "fund" && r.loanId === "ln_one");
  fund.blocks = ["fund1"]; // logged lower-case, intent upper-case
  assert.ok(!codes(audit(recs, history()).report).includes("FUND HASH"));
});

test("review fix 2: a repeat loan of the same size to the same address is not a double send", () => {
  const recs = records();
  const last = recs.at(-1);
  let seq = last.seq;
  const add = (event, fields) => recs.push({ v: 1, seq: ++seq, at: "2026-10-14T00:00:00.000Z", event, prevHash: "x", hash: "y", loanId: "ln_one_again", borrower: "keeta_borrower_one", ...fields });
  add("open_quote", { vault: "keeta_vault_one", principalRaw: "3640000", maxLtv: "0.25", kycTier: "open", sizingMode: "float", quotedKtaRaw: String(floatNeed(3_640_000n, 0.25, 0.0677)), openSpot: "0.0677", openTwap: "0.068", openPx: "0.0677", priceUsd: "0.0677" });
  add("fund_intent", { sendBlockHash: "FUND1AGAIN", principalRaw: "3640000" });
  add("fund", { principalRaw: "3640000", blocks: ["FUND1AGAIN"] });
  const h = history();
  addSend(h, "FUND1AGAIN", H.inventory, "keeta_borrower_one", PINNED.usdc, 3_640_000n, "2026-10-14T00:00:01.000Z", "keelend:ln_one_again");
  const c = codes(audit(recs, h).report);
  assert.ok(!c.includes("DOUBLE SEND"), c.join());
  assert.ok(!c.includes("PHANTOM LOG ENTRY"), c.join());
});

test("review fix 2: an untagged same-amount inventory payment is neither this loan's funding nor a double send", () => {
  const recs = records();
  recs.find((r) => r.event === "fund" && r.loanId === "ln_one").blocks = undefined; // no hash: tag match only
  const h = history();
  addSend(h, "MANUALSAME", H.inventory, "keeta_borrower_one", PINNED.usdc, 3_640_000n, "2026-10-13T00:00:30.000Z");
  const { report } = audit(recs, h);
  const c = codes(report);
  assert.ok(!c.includes("DOUBLE SEND"));
  const unlogged = report.items.filter((i) => i.code === "UNLOGGED SEND").map((i) => i.block);
  assert.deepEqual(unlogged.filter((b) => b !== "SALE2"), ["MANUALSAME"]); // the tagged FUND1 matched the fund record
});

test("review fix 3: principal above $10 is a WARN until the keeper enforces it; below $0.40 still fails", () => {
  const recs = records();
  const open = recs.find((r) => r.event === "open_quote" && r.loanId === "ln_two");
  open.principalRaw = "12000000";
  open.quotedKtaRaw = String(floatNeed(12_000_000n, 0.4, 0.068));
  const { report } = audit(recs, null);
  assert.ok(!codes(report).includes("OPEN SIZE"));
  assert.ok(codes(report, "WARN").includes("OPEN CAP"));
  open.principalRaw = "390000";
  open.quotedKtaRaw = String(floatNeed(390_000n, 0.4, 0.068));
  assert.ok(codes(audit(recs, null).report).includes("OPEN SIZE"));
});
