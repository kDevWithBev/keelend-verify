#!/usr/bin/env node
/**
 * KeeLend public verifier (trust-log-and-reserves spec v4, §A5). Read-only: Keeta REST reads,
 * no seeds, no keeper code. See README.md.
 *
 * Usage: node verify.mjs <log.jsonl | https://…> [--key keeta_…] [--allow-unsigned] [--offline | --history saved.json]
 *        [--anchor keeta_…]… [--api URL] [--json report.json]
 * Exit code 0 = no FAIL, 1 = at least one FAIL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Report, checkLoanRules, configFrom, loansFrom, reconcile } from "./audit.mjs";

const GENESIS_PREV = "0".repeat(64);

export function canonical(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error("non-integer JSON number");
      return String(value);
    case "boolean":
      return String(value);
    case "object": {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    }
    default:
      throw new Error("cannot canonicalize " + typeof value);
  }
}

function hashOf(record) {
  const { hash, sig, ...body } = record;
  return createHash("sha256").update(canonical(body)).digest("hex");
}

/** Default signature check with the Keeta SDK (public key only). */
export async function keetaVerifier(address) {
  const KeetaNet = await import("@keetanetwork/keetanet-client");
  const account = KeetaNet.lib.Account.fromPublicKeyString(address);
  return (hash, sigBase64) => {
    const data = new TextEncoder().encode(hash);
    const sig = Buffer.from(sigBase64, "base64");
    return account.verify(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), new Uint8Array(sig).buffer);
  };
}

/**
 * text: the JSONL file contents. verify: (hash, sig) => boolean, or null to skip signature checks.
 * Returns { ok, records, errors: [{ line, seq, problem }] }.
 */
export function verifyLog(text, { verify = null, allowUnsigned = false } = {}) {
  const errors = [];
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let prev = null;
  let count = 0;
  lines.forEach((line, index) => {
    const at = index + 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      errors.push({ line: at, problem: "not valid JSON" });
      prev = null;
      return;
    }
    count++;
    const expectSeq = prev ? prev.seq + 1 : 0;
    if (record.seq !== expectSeq) errors.push({ line: at, seq: record.seq, problem: `seq ${record.seq}, expected ${expectSeq}` });
    const expectPrev = prev ? prev.hash : GENESIS_PREV;
    if (record.prevHash !== expectPrev) errors.push({ line: at, seq: record.seq, problem: "prevHash does not match the previous record" });
    if (index === 0 && record.event !== "genesis") errors.push({ line: at, seq: record.seq, problem: "first record is not genesis" });
    let computed = null;
    try {
      computed = hashOf(record);
    } catch (error) {
      errors.push({ line: at, seq: record.seq, problem: "cannot hash: " + error.message });
    }
    if (computed && computed !== record.hash) errors.push({ line: at, seq: record.seq, problem: "hash does not match the contents" });
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "number" && key !== "seq" && key !== "v") errors.push({ line: at, seq: record.seq, problem: `field ${key} is a JSON number, not a string` });
      if (value === null) errors.push({ line: at, seq: record.seq, problem: `field ${key} is null; missing fields must be left out` });
    }
    if (record.event !== "fund" && ["fundSpot", "fundTwap", "fundPx"].some((key) => key in record)) {
      errors.push({ line: at, seq: record.seq, problem: "fund* prices on a record that is not fund" });
    }
    if (!record.sig) {
      if (!allowUnsigned) errors.push({ line: at, seq: record.seq, problem: "unsigned record" });
    } else if (verify) {
      let good = false;
      try {
        good = verify(record.hash, record.sig);
      } catch {
        good = false;
      }
      if (!good) errors.push({ line: at, seq: record.seq, problem: "bad signature" });
    }
    prev = record;
  });
  return { ok: errors.length === 0, records: count, errors };
}

export const DEFAULT_API = "https://rep1.main.network.api.keeta.com/api";

/** Page an account's history newest-first until it is older than `since`. GET only. */
export async function fetchHistory(address, { api = DEFAULT_API, since = 0, maxPages = 200, fetchImpl = fetch } = {}) {
  const rows = [];
  let start = "";
  for (let page = 0; page < maxPages; page++) {
    const url = `${api}/node/ledger/account/${address}/history` + (start ? `?start=${encodeURIComponent(start)}` : "");
    const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "keelend-verify" } });
    if (!res.ok) throw new Error(`history ${address}: HTTP ${res.status}`);
    const body = await res.json();
    const list = body.history || [];
    if (!list.length) break;
    rows.push(...list);
    const oldest = Math.min(...list.map((row) => Date.parse(row.$timestamp || "") || Infinity));
    if (!body.nextKey || oldest < since) break;
    start = body.nextKey;
  }
  return rows;
}

/** Full audit of parsed records with a history map (address -> rows). */
export function audit(records, history, { anchors = [] } = {}) {
  const report = new Report();
  const cfg = configFrom(records, report, anchors);
  checkLoanRules(loansFrom(records), report);
  const stats = history ? reconcile(records, history, cfg, report) : null;
  if (!history) report.add("WARN", "OFFLINE", "on-chain reconciliation skipped");
  return { report, cfg, stats };
}

function argValues(argv, flag) {
  const out = [];
  argv.forEach((arg, i) => {
    if (arg === flag && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}

async function readSource(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`log fetch failed: HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(source, "utf8");
}

async function main(argv) {
  const valued = new Set(["--key", "--anchor", "--api", "--json", "--history"]);
  const file = argv.find((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1]));
  if (!file) {
    console.error("Usage: node verify.mjs <log.jsonl | URL> [--key keeta_…] [--allow-unsigned] [--offline] [--anchor keeta_…] [--api URL] [--json out.json]");
    return 1;
  }
  const allowUnsigned = argv.includes("--allow-unsigned");
  const text = await readSource(file);
  let key = argValues(argv, "--key")[0] || null;
  if (!key) {
    try {
      key = JSON.parse(text.split("\n")[0]).logKey || null;
    } catch {
      key = null;
    }
  }
  const verify = key ? await keetaVerifier(key) : null;
  const chain = verifyLog(text, { verify, allowUnsigned });
  const records = text.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  let history = null;
  const historyFile = argValues(argv, "--history")[0];
  if (historyFile) {
    history = new Map(Object.entries(JSON.parse(readFileSync(historyFile, "utf8"))));
  } else if (!argv.includes("--offline")) {
    const api = argValues(argv, "--api")[0] || DEFAULT_API;
    const cfg = configFrom(records, new Report());
    const addresses = new Set([...Object.values(cfg.house), cfg.gas, cfg.treasury, ...records.filter((r) => r.event === "open_quote" && r.vault).map((r) => r.vault)]);
    history = new Map();
    for (const address of addresses) history.set(address, await fetchHistory(address, { api, since: cfg.since }));
  }
  const { report, stats } = audit(records, history, { anchors: argValues(argv, "--anchor") });
  for (const error of chain.errors) report.add("FAIL", "CHAIN", error.problem, { line: error.line, seq: error.seq });
  if (!key && !allowUnsigned) report.add("WARN", "SIGNATURES", "no log key named; signatures not checked");
  for (const item of report.items) {
    if (item.level === "INFO") continue;
    const where = [item.loanId && `loan ${item.loanId}`, item.seq != null && `seq ${item.seq}`, item.block && `block ${item.block}`].filter(Boolean).join(" ");
    console.log(`${item.level} ${item.code}${where ? " [" + where + "]" : ""}: ${item.message}`);
  }
  const summary = `${report.ok ? "OK" : "FAIL"}: ${chain.records} records, ${stats ? stats.sends + " on-chain sends checked, " : ""}${report.count("FAIL")} FAIL, ${report.count("WARN")} WARN, ${report.count("INFO")} INFO`;
  console.log(summary);
  const jsonOut = argValues(argv, "--json")[0];
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ok: report.ok, summary, items: report.items }, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
