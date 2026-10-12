#!/usr/bin/env node
/**
 * KeeLend LTV alerts. Read-only like reserves.mjs (same reads, same price rules), no seeds.
 * Writes a public alerts.json listing every open loan at LTV >= 48% and every stuck-send loan.
 * Price unsettled: LTV is shown at both spot and average and a loan is listed if either is >= 48%.
 * Price unavailable: no LTV alerts (stuck-send still listed). The $0.10 preview is never used.
 *
 * Optional owner alert, only when the alert set changes since the previous alerts.json:
 *   KEELEND_ALERT_FILE=/path   append one JSON line
 *   KEELEND_ALERT_WEBHOOK=URL  POST the alerts JSON to that URL
 *
 * Usage: node alerts.mjs <trust-log.jsonl | URL> [--out DIR] [--api URL] [--fixture balances.json] [--now ISO]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PINNED } from "./audit.mjs";
import { DEFAULT_API } from "./verify.mjs";
import { computeReserves, readBalances, readPrices } from "./reserves.mjs";

export const ALERT_LTV = 0.48;

/** Build the public alerts document from a computeReserves() report. */
export function buildAlerts(report) {
  const unsettled = report.price.status !== "settled";
  const alerts = [];
  for (const loan of report.loans) {
    // LTV and liquidation price come from computeReserves: the full amount due, partial payments not subtracted.
    const base = { loanId: loan.id, borrower: loan.borrower, status: loan.status, liquidationPrice: loan.liquidationPrice, dueRaw: loan.debtRaw, paidSoFarRaw: loan.paidSoFarRaw };
    if (loan.status === "stuck-send") {
      alerts.push({ ...base, reason: "stuck-send" });
      continue;
    }
    if (loan.status !== "funded") continue;
    if (!unsettled) {
      if (loan.ltv != null && loan.ltv >= ALERT_LTV) alerts.push({ ...base, reason: "ltv", ltv: loan.ltv, price: report.price.px });
    } else if ((loan.ltvAtSpot ?? 0) >= ALERT_LTV || (loan.ltvAtTwap ?? 0) >= ALERT_LTV) {
      alerts.push({ ...base, reason: "ltv", ltv: null, ltvAtSpot: loan.ltvAtSpot, ltvAtTwap: loan.ltvAtTwap, spot: report.price.spot, twap: report.price.twap });
    }
  }
  return { at: report.at, threshold: ALERT_LTV, price: report.price, count: alerts.length, alerts };
}

const signature = (doc) => JSON.stringify(doc.alerts.map((a) => [a.loanId, a.reason]).sort());

/** Owner notification when the set of (loan, reason) changed. Never throws. */
export async function notifyOwner(doc, previous, { env = process.env, fetchImpl = fetch } = {}) {
  const sent = [];
  if (previous && signature(previous) === signature(doc)) return sent;
  if (!doc.alerts.length && (!previous || !previous.alerts?.length)) return sent;
  const line = JSON.stringify({ at: doc.at, count: doc.count, alerts: doc.alerts });
  if (env.KEELEND_ALERT_FILE) {
    try {
      appendFileSync(env.KEELEND_ALERT_FILE, line + "\n");
      sent.push("file");
    } catch (error) {
      console.error("alert file failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (env.KEELEND_ALERT_WEBHOOK) {
    try {
      const res = await fetchImpl(env.KEELEND_ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: line });
      if (res.ok) sent.push("webhook");
      else console.error("alert webhook HTTP " + res.status);
    } catch (error) {
      console.error("alert webhook failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return sent;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const valued = new Set(["--out", "--api", "--fixture", "--now"]);
  const source = argv.find((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1]));
  if (!source) {
    console.error("Usage: node alerts.mjs <trust-log.jsonl | URL> [--out DIR] [--api URL] [--fixture balances.json] [--now ISO]");
    return 1;
  }
  const out = argValue(argv, "--out") || ".";
  const api = argValue(argv, "--api") || DEFAULT_API;
  const text = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : readFileSync(source, "utf8");
  const records = text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  let balances, prices;
  const fixture = argValue(argv, "--fixture");
  if (fixture) {
    ({ balances, prices } = JSON.parse(readFileSync(fixture, "utf8")));
  } else {
    balances = {};
    const vaults = records.filter((r) => r.event === "open_quote" && r.vault).map((r) => r.vault);
    for (const address of new Set([...Object.values(PINNED.house), PINNED.treasury, ...vaults])) balances[address] = await readBalances(address, { api });
    try {
      prices = await readPrices();
    } catch (error) {
      prices = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const nowArg = argValue(argv, "--now");
  const report = computeReserves({ records, balances, prices, now: nowArg ? Date.parse(nowArg) : Date.now() });
  const doc = buildAlerts(report);
  mkdirSync(out, { recursive: true });
  const path = join(out, "alerts.json");
  let previous = null;
  try {
    if (existsSync(path)) previous = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    previous = null;
  }
  writeFileSync(path, JSON.stringify(doc, null, 2));
  const sent = await notifyOwner(doc, previous);
  console.log(`alerts: ${doc.count} (price ${doc.price.status})${sent.length ? ", notified " + sent.join("+") : ""}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
