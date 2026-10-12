// LTV alert tests. Run from the verifier folder: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PINNED } from "../audit.mjs";
import { computeReserves } from "../reserves.mjs";
import { ALERT_LTV, buildAlerts, notifyOwner } from "../alerts.mjs";

const t0 = Date.parse("2026-10-13T00:00:00Z");
const at = (s) => new Date(t0 + s * 1000).toISOString();
const NOW = t0 + 3600 * 1000;
const KTA = 10n ** 18n;

// Three funded $10 loans: low (400 KTA), hot (300 KTA), borderline only at the average (290 KTA); one stuck-send.
function fixture() {
  let seq = 0;
  const r = (s, event, f) => ({ v: 1, seq: seq++, at: at(s), event, hash: "h" + seq, prevHash: "p", ...f });
  const records = [r(0, "genesis", {})];
  for (const [id, vault] of [["ln_low", "v_low"], ["ln_hot", "v_hot"], ["ln_mid", "v_mid"]]) {
    records.push(r(10, "open_quote", { loanId: id, borrower: "b_" + id, vault, principalRaw: "10000000", maxLtv: "0.4", sizingMode: "float", holdUntil: at(910) }));
    records.push(r(20, "fund_intent", { loanId: id, borrower: "b_" + id, sendBlockHash: "F" + id }));
    records.push(r(30, "fund", { loanId: id, borrower: "b_" + id, blocks: ["F" + id] }));
  }
  records.push(r(40, "open_quote", { loanId: "ln_stuck", borrower: "b_s", vault: "v_s", principalRaw: "3000000", maxLtv: "0.25", holdUntil: at(940) }));
  records.push(r(50, "fund_intent", { loanId: "ln_stuck", borrower: "b_s", sendBlockHash: "S" }));
  records.push(r(200, "stuck_send", { loanId: "ln_stuck", borrower: "b_s", sendBlockHash: "S" }));
  const balances = {
    [PINNED.house.inventory]: { [PINNED.usdc]: "20000000" },
    v_low: { [PINNED.kta]: String(400n * KTA) },
    v_hot: { [PINNED.kta]: String(300n * KTA) },
    v_mid: { [PINNED.kta]: String(330n * KTA) },
    v_s: { [PINNED.kta]: String(100n * KTA) },
  };
  return { records, balances };
}
const alertsAt = (prices) => {
  const { records, balances } = fixture();
  return buildAlerts(computeReserves({ records, balances, prices, now: NOW }));
};

test("settled price: lists funded loans at LTV >= 48% at the price used, plus stuck-send", () => {
  // $10 / (300 KTA × $0.068) = 49.0%  hot; 330 KTA = 44.6%; 400 KTA = 36.8%
  const doc = alertsAt({ spot: 0.068, twap: 0.068 });
  const ids = doc.alerts.map((a) => `${a.loanId}:${a.reason}`).sort();
  assert.deepEqual(ids, ["ln_hot:ltv", "ln_stuck:stuck-send"]);
  const hot = doc.alerts.find((a) => a.loanId === "ln_hot");
  assert.ok(hot.ltv >= ALERT_LTV && hot.ltv < 0.52);
  assert.equal(hot.price, 0.068);
  assert.equal(hot.borrower, "b_ln_hot");
  assert.equal(hot.status, "funded");
  assert.ok(Math.abs(hot.liquidationPrice - 10.000001 / (0.52 * 300)) < 1e-4);
});

test("price unsettled: both LTVs shown, listed if either is >= 48%", () => {
  // spot 0.07, average 0.0625 (11% apart): 330 KTA is 43% at spot, 48.5% at average
  const doc = alertsAt({ spot: 0.07, twap: 0.0625 });
  assert.equal(doc.price.status, "price unsettled");
  const mid = doc.alerts.find((a) => a.loanId === "ln_mid");
  assert.ok(mid, "listed on the average");
  assert.equal(mid.ltv, null);
  assert.ok(mid.ltvAtSpot < ALERT_LTV && mid.ltvAtTwap >= ALERT_LTV);
  assert.equal(mid.spot, 0.07);
  assert.equal(mid.twap, 0.0625);
});

test("alerts use the same full-due LTV: a partial payment does not drop a hot loan", () => {
  const { records, balances } = fixture();
  records.push({ v: 1, seq: 99, at: at(60), event: "repayment_received", loanId: "ln_hot", borrower: "b_ln_hot", amountRaw: "5000000", totalReceivedRaw: "5000000", hash: "h", prevHash: "p" });
  const report = computeReserves({ records, balances, prices: { spot: 0.068, twap: 0.068 }, now: NOW });
  const doc = buildAlerts(report);
  const hot = doc.alerts.find((a) => a.loanId === "ln_hot");
  assert.ok(hot, "still listed after a $5 partial payment");
  assert.equal(hot.ltv, report.loans.find((l) => l.id === "ln_hot").ltv);
  assert.equal(hot.paidSoFarRaw, "5000000");
});

test("price unavailable: no LTV alerts, stuck-send still listed, $0.10 never used", () => {
  const doc = alertsAt({ error: "price unavailable" });
  assert.deepEqual(doc.alerts.map((a) => a.loanId), ["ln_stuck"]);
  assert.doesNotMatch(JSON.stringify(doc), /"0\.1"|0\.10?[,}]/);
});

test("owner alert: file and webhook only when set, only when the alert set changes, never throws", async () => {
  const doc = alertsAt({ spot: 0.068, twap: 0.068 });
  const dir = mkdtempSync(join(tmpdir(), "al-"));
  const file = join(dir, "owner.jsonl");
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true };
  };
  assert.deepEqual(await notifyOwner(doc, null, { env: {}, fetchImpl }), []);
  assert.equal(posts.length, 0);
  const env = { KEELEND_ALERT_FILE: file, KEELEND_ALERT_WEBHOOK: "https://hook.test/x" };
  assert.deepEqual(await notifyOwner(doc, null, { env, fetchImpl }), ["file", "webhook"]);
  assert.equal(posts[0].method, "POST");
  assert.equal(posts[0].body.count, 2);
  assert.deepEqual(await notifyOwner(doc, doc, { env, fetchImpl }), []); // unchanged: no repeat
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  const broken = await notifyOwner(doc, null, { env: { KEELEND_ALERT_WEBHOOK: "https://hook.test" }, fetchImpl: async () => { throw new Error("down"); } });
  assert.deepEqual(broken, []);
});

test("CLI writes alerts.json from a fixture without contacting anyone", () => {
  const { records, balances } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "alc-"));
  writeFileSync(join(dir, "log.jsonl"), records.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "fx.json"), JSON.stringify({ balances, prices: { spot: 0.068, twap: 0.068 } }));
  const script = fileURLToPath(new URL("../alerts.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.KEELEND_ALERT_FILE;
  delete env.KEELEND_ALERT_WEBHOOK;
  const out = execFileSync(process.execPath, [script, join(dir, "log.jsonl"), "--out", dir, "--fixture", join(dir, "fx.json"), "--now", new Date(NOW).toISOString()], { encoding: "utf8", env });
  assert.match(out, /alerts: 2 \(price settled\)/);
  assert.equal(JSON.parse(readFileSync(join(dir, "alerts.json"), "utf8")).count, 2);
});
