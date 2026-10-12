#!/usr/bin/env node
/**
 * KeeLend proof-of-reserves generator (trust-log-and-reserves spec v4, Part B).
 * Read-only: Keeta REST balance reads (GET), a read-only eth_call for the KTA price, and the
 * trust log. No seeds, no keeper code. Writes reserves.json and a static reserves.html.
 *
 * Usage: node reserves.mjs <trust-log.jsonl | URL> [--out DIR] [--key keeta_…] [--allow-unsigned]
 *        [--api URL] [--verifier-url URL] [--fixture balances.json] [--now ISO (with --fixture, for tests)]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PINNED, dueRaw, pricesAgree } from "./audit.mjs";
import { DEFAULT_API, keetaVerifier, verifyLog } from "./verify.mjs";

const LTV_WARN = 0.48;
const LTV_LIQ = 0.52;

// ---------- reads (read-only) ----------

export async function readBalances(address, { api = DEFAULT_API, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${api}/node/ledger/account/${address}/balance`, { headers: { accept: "application/json", "user-agent": "keelend-reserves" } });
  if (!res.ok) throw new Error(`balance ${address}: HTTP ${res.status}`);
  const body = await res.json();
  const out = {};
  for (const row of body.balances ?? []) out[row.token] = String(BigInt(row.balance));
  return out;
}

/** The keeper's mark(): spot and 30-minute average from the Base pool, read with eth_call only. */
export async function readPrices({ fetchImpl = fetch } = {}) {
  const pool = "0xd9eDC75a3a797Ec92Ca370F19051BAbebfb2edEe";
  const ethUsd = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
  const one = (10n ** 18n).toString(16).padStart(64, "0");
  const kta = "c0634090f2fe6c6d75e61be2b949464abb498973".padStart(64, "0");
  const body = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: pool, data: "0xf140a35a" + one + kta }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: pool, data: "0x9e8cc04b" + kta + one + "1".padStart(64, "0") }, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: ethUsd, data: "0xfeaf968c" }, "latest"] },
  ];
  const res = await fetchImpl("https://base.publicnode.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rows = await res.json();
  const byId = new Map(rows.map((row) => [row.id, row.result]));
  const ethHex = String(byId.get(2) || "");
  const answer = BigInt("0x" + ethHex.slice(2 + 64, 2 + 128));
  const spotOut = BigInt(byId.get(0));
  if (spotOut <= 0n || answer <= 0n) throw new Error("price unavailable");
  const spot = Number((spotOut * answer) / 10n ** 18n) / 1e8;
  if (!(spot > 0.01 && spot < 5)) throw new Error("price out of range");
  let twap = null;
  try {
    const next = Number((BigInt(byId.get(1)) * answer) / 10n ** 18n) / 1e8;
    if (next > 0.01 && next < 5) twap = next;
  } catch {
    twap = null;
  }
  return { spot, twap };
}

// ---------- log replay ----------

/** Loan state replayed from the log. Status names follow the keeper. */
export function replayLoans(records, now) {
  const loans = new Map();
  for (const r of records) {
    if (!r.loanId) continue;
    let loan = loans.get(r.loanId);
    if (!loan) loans.set(r.loanId, (loan = { id: r.loanId, borrower: r.borrower, status: "unknown", paidRaw: 0n, refundedRaw: 0n, lastSeq: r.seq }));
    loan.borrower = loan.borrower || r.borrower;
    loan.lastSeq = r.seq;
    switch (r.event) {
      case "open_quote":
        Object.assign(loan, { vault: r.vault, principalRaw: BigInt(r.principalRaw), maxLtv: r.maxLtv, sizingMode: r.sizingMode || "float", holdUntil: r.holdUntil, status: "awaiting-kta" });
        break;
      case "fund_intent":
        loan.status = "sending-usdc";
        loan.sendAt = Date.parse(r.at);
        break;
      case "stuck_send":
        loan.status = "stuck-send";
        break;
      case "fund":
        loan.status = "funded";
        loan.fundedAt = loan.sendAt ?? Date.parse(r.at);
        break;
      case "repayment_received":
        loan.paidRaw = BigInt(r.totalReceivedRaw ?? loan.paidRaw + BigInt(r.amountRaw || "0"));
        break;
      case "overpay_refund":
        loan.refundedRaw += BigInt(r.refundRaw);
        break;
      case "close":
        loan.status = "closed";
        if (r.totalReceivedRaw != null && r.dueRaw != null) {
          const extra = BigInt(r.totalReceivedRaw) - BigInt(r.dueRaw);
          loan.refundDueRaw = extra > 0n ? extra : 0n;
        }
        break;
      case "liquidation":
        loan.status = "liquidated";
        break;
      case "liquidation_settle":
        loan.status = "settled";
        break;
      case "expiry_refund":
        loan.status = "expired";
        break;
      default:
        break;
    }
  }
  for (const loan of loans.values()) {
    // The keeper releases an unfilled vault after 15 minutes (releaseStale) before the refund is logged.
    if (loan.status === "awaiting-kta" && loan.holdUntil && now > Date.parse(loan.holdUntil)) loan.status = "expired";
  }
  return [...loans.values()];
}

const ACTIVE = new Set(["awaiting-kta", "sending-usdc", "stuck-send", "funded", "liquidated"]);
const RESERVING = new Set(["awaiting-kta", "sending-usdc", "stuck-send"]); // keeper reservedRaw

/** liquidation price in USD per KTA: debtRaw (6dp) / (0.52 × ktaRaw (18dp)). Display only. */
export function liqPrice(debtRaw, ktaRaw) {
  if (!ktaRaw || ktaRaw === 0n) return null;
  const e18 = (debtRaw * 10n ** 12n * 10n ** 18n * 100n) / (52n * ktaRaw);
  return Number(e18) / 1e18;
}

function ltvAt(debtRaw, ktaRaw, price) {
  const collateral = (Number(ktaRaw) / 1e18) * price;
  return collateral > 0 ? Number(debtRaw) / 1e6 / collateral : null;
}

// ---------- the report ----------

/**
 * records: parsed log; balances: { address: { token: rawString } }; prices: { spot, twap } or { error };
 * signature: "verified" | "unsigned" | "not checked" | "FAILED".
 */
export function computeReserves({ records, balances, prices, now = Date.now(), signature = "not checked", readAt = {} }) {
  const usdc = PINNED.usdc;
  const kta = PINNED.kta;
  const bal = (address, token) => BigInt(balances[address]?.[token] ?? "0");
  const H = PINNED.house;
  const priceOk = prices && !prices.error && prices.twap != null && pricesAgree(prices.spot, prices.twap);
  const px = priceOk ? Math.min(prices.spot, prices.twap) : null;
  const loans = replayLoans(records, now);

  const rows = [];
  let reserved = 0n, outstandingPrincipal = 0n, outstandingInterest = 0n, totalDebt = 0n, totalKta = 0n;
  let refundOwed = 0n;
  let totalPaid = 0n;
  for (const loan of loans) {
    if (loan.refundDueRaw != null) {
      const left = loan.refundDueRaw - loan.refundedRaw;
      if (left > 0n) refundOwed += left;
    }
    if (!ACTIVE.has(loan.status)) continue;
    if (RESERVING.has(loan.status)) reserved += loan.principalRaw ?? 0n;
    const vaultKta = loan.vault ? bal(loan.vault, kta) : 0n;
    // Debt is the FULL amount due, exactly as the keeper's liquidation check computes it
    // (dueRaw on the original principal); partial payments are shown separately, never subtracted.
    let debt = 0n;
    let paidSoFar = 0n;
    if (loan.status === "funded") {
      debt = dueRaw(loan.principalRaw, loan.fundedAt, now);
      paidSoFar = loan.paidRaw;
      outstandingPrincipal += loan.principalRaw;
      outstandingInterest += debt - loan.principalRaw;
      totalDebt += debt;
      totalPaid += paidSoFar;
      totalKta += vaultKta;
    }
    rows.push({
      id: loan.id,
      borrower: loan.borrower,
      vault: loan.vault,
      status: loan.status,
      collateralKtaRaw: vaultKta.toString(),
      debtRaw: debt.toString(),
      paidSoFarRaw: paidSoFar.toString(),
      ltv: px != null ? ltvAt(debt, vaultKta, px) : null,
      ltvAtSpot: prices?.spot ? ltvAt(debt, vaultKta, prices.spot) : null,
      ltvAtTwap: prices?.twap ? ltvAt(debt, vaultKta, prices.twap) : null,
      liquidationPrice: debt > 0n ? liqPrice(debt, vaultKta) : null,
      maxLtv: loan.maxLtv,
      sizingMode: loan.sizingMode,
      lastSeq: loan.lastSeq,
    });
  }
  const inventory = bal(H.inventory, usdc);
  const servicing = bal(H.servicing, usdc);
  const treasury = bal(PINNED.treasury, usdc);
  const head = records.at(-1) || null;
  const totalCollateralUsd = px != null ? (Number(totalKta) / 1e18) * px : null;
  return {
    at: new Date(now).toISOString(),
    readAt,
    price: prices?.error
      ? { status: "price unavailable", error: prices.error }
      : { status: priceOk ? "settled" : "price unsettled", spot: prices?.spot ?? null, twap: prices?.twap ?? null, px },
    lendableUsdcRaw: (inventory > reserved ? inventory - reserved : 0n).toString(),
    inventoryUsdcRaw: inventory.toString(),
    reservedUsdcRaw: reserved.toString(),
    collected: { servicingUsdcRaw: servicing.toString(), treasuryUsdcRaw: treasury.toString() },
    outstanding: { principalRaw: outstandingPrincipal.toString(), interestRaw: outstandingInterest.toString(), debtRaw: totalDebt.toString(), paidSoFarRaw: totalPaid.toString() },
    refunds: { owedRaw: refundOwed.toString(), payer: "servicing", payerUsdcRaw: servicing.toString(), short: servicing < refundOwed },
    collateral: {
      ktaRaw: totalKta.toString(),
      usd: totalCollateralUsd,
      debtUsd: Number(totalDebt) / 1e6,
      ltv: totalCollateralUsd ? Number(totalDebt) / 1e6 / totalCollateralUsd : null,
      ltvAtSpot: prices?.spot ? ltvAt(totalDebt, totalKta, prices.spot) : null,
      ltvAtTwap: prices?.twap ? ltvAt(totalDebt, totalKta, prices.twap) : null,
    },
    house: Object.fromEntries(
      [...Object.entries(H), ["treasury", PINNED.treasury], ["gas", PINNED.gas]].map(([name, address]) => [name, { address, usdcRaw: bal(address, usdc).toString(), ktaRaw: bal(address, kta).toString() }]),
    ),
    loans: rows,
    logHead: head ? { seq: head.seq, hash: head.hash, at: head.at, signature, logKey: records[0]?.logKey ?? null } : null,
  };
}

// ---------- HTML ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const usd = (raw) => {
  const v = BigInt(raw);
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  return `${sign}$${(a / 1_000_000n).toString()}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
};
export const ktaFmt = (raw) => {
  const v = BigInt(raw);
  return `${(v / 10n ** 18n).toString()}.${(v % 10n ** 18n).toString().padStart(18, "0").slice(0, 4)} KTA`;
};
const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const short = (a) => (a ? `${a.slice(0, 12)}…${a.slice(-6)}` : "");

export function renderHtml(r, { verifierUrl } = {}) {
  const unsettled = r.price.status !== "settled";
  const banner = r.refunds.short
    ? `<div class="red">Refunds owed (${usd(r.refunds.owedRaw)}) exceed the servicing account's USDC (${usd(r.refunds.payerUsdcRaw)}).</div>`
    : "";
  const priceLine = r.price.status === "price unavailable"
    ? `<p class="warn">Price unavailable: ${esc(r.price.error)}. No LTVs shown.</p>`
    : unsettled
      ? `<p class="warn">Price unsettled: spot $${esc(r.price.spot)}, 30-minute average ${r.price.twap == null ? "missing" : "$" + esc(r.price.twap)}. LTVs shown at both.</p>`
      : `<p>KTA price used: $${esc(r.price.px)} (lower of spot $${esc(r.price.spot)} and 30-minute average $${esc(r.price.twap)}).</p>`;
  const ltvCell = (row) => {
    const one = (x) => `<span class="${x != null && x >= LTV_WARN ? "hot" : ""}">${pct(x)}</span>`;
    return unsettled ? `${one(row.ltvAtSpot)} spot / ${one(row.ltvAtTwap)} avg` : one(row.ltv);
  };
  const loanRows = r.loans.map((row) => `<tr><td>${esc(row.id)}</td><td title="${esc(row.borrower)}">${esc(short(row.borrower))}</td><td title="${esc(row.vault)}">${esc(short(row.vault))}</td><td class="${row.status === "stuck-send" ? "hot" : ""}">${esc(row.status)}</td><td>${ktaFmt(row.collateralKtaRaw)}</td><td>${usd(row.debtRaw)}</td><td>${usd(row.paidSoFarRaw)}</td><td>${ltvCell(row)}</td><td>${row.liquidationPrice == null ? "–" : "$" + row.liquidationPrice.toFixed(6)}</td><td>${row.maxLtv === "0.4" || row.maxLtv === "0.40" ? "40%" : "25%"}</td><td>${esc(row.sizingMode)}</td><td>${esc(row.lastSeq)}</td></tr>`).join("\n");
  const houseRows = Object.entries(r.house).map(([name, h]) => `<tr><td>${esc(name)}</td><td><code>${esc(h.address)}</code></td><td>${usd(h.usdcRaw)}</td><td>${ktaFmt(h.ktaRaw)}</td></tr>`).join("\n");
  const c = r.collateral;
  const aggregate = unsettled
    ? `${pct(c.ltvAtSpot)} at spot / ${pct(c.ltvAtTwap)} at average`
    : `${pct(c.ltv)} (collateral ${c.usd == null ? "–" : "$" + c.usd.toFixed(2)})`;
  const head = r.logHead
    ? `<p>Log head: seq ${esc(r.logHead.seq)}, hash <code>${esc(r.logHead.hash)}</code>, ${esc(r.logHead.at)}. Signature: <b class="${r.logHead.signature === "verified" ? "" : "hot"}">${esc(r.logHead.signature)}</b>${r.logHead.logKey ? `, key <code>${esc(r.logHead.logKey)}</code>` : ""}.</p>`
    : "<p>No log yet.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KeeLend reserves</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:1100px;margin:1.5em auto;padding:0 1em;color:#111}table{border-collapse:collapse;width:100%;margin:.5em 0 1.5em}td,th{border-bottom:1px solid #ddd;padding:.3em .5em;text-align:left}code{font-size:12px}.red{background:#c00;color:#fff;padding:.8em;font-weight:bold}.warn{background:#fff3cd;padding:.5em}.hot{color:#c00;font-weight:bold}.big{font-size:1.4em;font-weight:bold}</style>
</head><body>
<h1>KeeLend proof of reserves</h1>
${banner}
<p>Generated ${esc(r.at)} from on-chain balances and the signed loan log. KTA and USDC are shown separately.</p>
${priceLine}
<h2>USDC</h2>
<table>
<tr><th>Lendable USDC</th><td class="big">${usd(r.lendableUsdcRaw)}</td><td>inventory ${usd(r.inventoryUsdcRaw)} minus ${usd(r.reservedUsdcRaw)} reserved for waiting vaults</td></tr>
<tr><th>Outstanding principal</th><td>${usd(r.outstanding.principalRaw)}</td><td>plus interest so far ${usd(r.outstanding.interestRaw)}; paid so far ${usd(r.outstanding.paidSoFarRaw)} (held on servicing, not subtracted from LTV)</td></tr>
<tr><th>Collected: servicing</th><td>${usd(r.collected.servicingUsdcRaw)}</td><td>repaid principal and interest; not lendable until moved by hand</td></tr>
<tr><th>Collected: treasury</th><td>${usd(r.collected.treasuryUsdcRaw)}</td><td>liquidation fees; not lendable</td></tr>
<tr><th>Refunds owed</th><td>${usd(r.refunds.owedRaw)}</td><td>paid from servicing, which holds ${usd(r.refunds.payerUsdcRaw)}</td></tr>
</table>
<h2>Collateral vs debt</h2>
<p>Vault KTA ${ktaFmt(c.ktaRaw)} against the full amount due $${c.debtUsd.toFixed(6)} (partial payments not subtracted, as in the keeper's liquidation check). Aggregate LTV ${aggregate}.</p>
<h2>Loans</h2>
<table><tr><th>Loan</th><th>Borrower</th><th>Vault</th><th>Status</th><th>Collateral</th><th>Amount due</th><th>Paid so far</th><th>LTV</th><th>Liquidation price</th><th>Max LTV</th><th>Sizing</th><th>Last seq</th></tr>
${loanRows || '<tr><td colspan="12">No open or waiting loans.</td></tr>'}
</table>
<h2>House accounts</h2>
<table><tr><th>Role</th><th>Address</th><th>USDC</th><th>KTA</th></tr>
${houseRows}
</table>
<h2>Log</h2>
${head}
${verifierUrl ? `<h2>Verify it yourself</h2>
<p><a href="${esc(verifierUrl)}">${esc(verifierUrl)}</a>: <code>node verify.mjs &lt;log URL&gt;</code></p>` : ""}
</body></html>
`;
}

// ---------- CLI ----------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const valued = new Set(["--out", "--key", "--api", "--verifier-url", "--fixture", "--now"]);
  const source = argv.find((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1]));
  if (!source) {
    console.error("Usage: node reserves.mjs <trust-log.jsonl | URL> [--out DIR] [--key keeta_…] [--allow-unsigned] [--api URL] [--verifier-url URL] [--fixture balances.json]");
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
  const key = argValue(argv, "--key") || records[0]?.logKey || null;
  let signature = "not checked";
  try {
    const verify = key ? await keetaVerifier(key) : null;
    const result = verifyLog(text, { verify, allowUnsigned: argv.includes("--allow-unsigned") });
    signature = !result.ok ? "FAILED" : !records.at(-1)?.sig ? "unsigned" : verify ? "verified" : "not checked";
  } catch (error) {
    signature = "not checked (" + (error instanceof Error ? error.message : String(error)) + ")";
  }
  const fixture = argValue(argv, "--fixture");
  let balances, prices;
  const readAt = {};
  if (fixture) {
    ({ balances, prices } = JSON.parse(readFileSync(fixture, "utf8")));
  } else {
    const addresses = new Set([...Object.values(PINNED.house), PINNED.treasury, PINNED.gas, ...records.filter((r) => r.event === "open_quote" && r.vault).map((r) => r.vault)]);
    balances = {};
    for (const address of addresses) {
      balances[address] = await readBalances(address, { api });
      readAt[address] = new Date().toISOString();
    }
    try {
      prices = await readPrices();
    } catch (error) {
      prices = { error: error instanceof Error ? error.message : String(error) };
    }
    readAt.price = new Date().toISOString();
  }
  const nowArg = argValue(argv, "--now");
  const report = computeReserves({ records, balances, prices, signature, readAt, now: nowArg ? Date.parse(nowArg) : Date.now() });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "reserves.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "reserves.html"), renderHtml(report, { verifierUrl: argValue(argv, "--verifier-url") }));
  console.log(`reserves: lendable ${usd(report.lendableUsdcRaw)}, ${report.loans.length} active loans, price ${report.price.status}${report.refunds.short ? ", REFUNDS SHORT" : ""}`);
  return report.refunds.short ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
