/**
 * Rule replay (§A5 step 6) and on-chain reconciliation (§A5 step 7). Pure functions: the caller
 * supplies the log records and the history rows, so this runs the same against fixtures or the
 * live ledger. History rows use the Keeta REST shape the keeper reads:
 *   { $timestamp, voteStaple: { blocks: [{ $hash, account, date, operations: [{ type, to, token, amount, external }] }] } }
 */

// ---- Rule functions: the keeper's own, copied verbatim so the verifier is self-contained.
// ---- keeper/test/verifier-rules.test.mjs checks they still match the keeper.
export const APR = 0.075;
export const YEAR = 31_557_600;
export const KTA_ONE = 10n ** 18n;
export const MIN_PRINCIPAL_RAW = 400_000n; // $0.40
export const MAX_PRINCIPAL_RAW = 10_000_000n; // $10.00 trial cap (cents-floored)
export const LIQ_LTV = 0.52;
export const CLOSE_TOLERANCE_RAW = 10_000n;
export const GAS_TOP_RAW = 2n * KTA_ONE;
export const GAS_SWEEP_MAX_RAW = 20n * KTA_ONE;
export const HOLD_MS = 15 * 60 * 1000;

export function pricesAgree(spot, twap) {
  if (!(twap > 0)) return false;
  return Math.abs(spot - twap) / twap <= 0.03;
}

export function spotInRange(spot) {
  return spot > 0.01 && spot < 5;
}

/** keeper/sizing.mjs floatNeed: Math.ceil((usd / ltv) * 1.01 / price * 1e18). */
export function floatNeed(principalRaw, maxLtv, price) {
  const usd = Number(BigInt(principalRaw)) / 1e6;
  const ltv = Number(maxLtv);
  const collateralUsd = (usd / ltv) * 1.01;
  return BigInt(Math.ceil((collateralUsd / price) * 1e18));
}

export function decimalFraction(x) {
  const text = String(x);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new Error("not a finite decimal: " + text);
  const [, sign, whole, frac = "", exp = "0"] = match;
  let num = BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  const e = Number(exp);
  if (e > 0) num *= 10n ** BigInt(e);
  if (e < 0) den *= 10n ** BigInt(-e);
  return { num: sign ? -num : num, den };
}

export function exactNeed(principalRaw, maxLtv, price) {
  const ltv = decimalFraction(maxLtv);
  const px = decimalFraction(price);
  if (ltv.num <= 0n || px.num <= 0n) throw new Error("ltv and price must be positive");
  const num = BigInt(principalRaw) * 101n * 10n ** 18n * ltv.den * px.den;
  const den = 10n ** 6n * 100n * ltv.num * px.num;
  return (num + den - 1n) / den;
}

export function sizeFor(mode, principalRaw, maxLtv, price) {
  return mode === "exact" ? exactNeed(principalRaw, maxLtv, price) : floatNeed(principalRaw, maxLtv, price);
}

/** keeper dueRaw: simple interest on the original principal. */
export function dueRaw(principal, fundedAt, now) {
  const dt = Math.max(0, (now - fundedAt) / 1000);
  return BigInt(Math.round(Number(principal) * (1 + APR * (dt / YEAR))));
}

/** keeper seizeRaw: KTA for due × 1.02 at price, capped at the vault. */
export function seizeRaw(dueUsdcRaw, vaultRaw, price) {
  const priceRaw = BigInt(Math.round(price * 1e8));
  if (priceRaw <= 0n || dueUsdcRaw <= 0n) return 0n;
  const slice = (dueUsdcRaw * 102n * 10n ** 18n) / priceRaw;
  return slice > vaultRaw ? vaultRaw : slice;
}

export function loanLtv(debtRaw, vaultRaw, price) {
  const collateral = (Number(vaultRaw) / 1e18) * price;
  if (!(collateral > 0)) return 1;
  return Number(debtRaw) / 1e6 / collateral;
}

/**
 * §A5a replay rule for loans without a full log (backfilled from the loan book).
 * Returns { level: "OK" | "FAIL" | "REPORT", detail }.
 */
export function replayOldLoan(loan) {
  const mode = loan.sizingMode || "float";
  const ltv = Number(loan.maxLtv);
  if (loan.quotedKtaRaw != null && (loan.openPx != null || loan.priceUsd != null)) {
    const px = Number(loan.openPx ?? loan.priceUsd);
    const got = sizeFor(mode, loan.principalRaw, ltv, px);
    return got === BigInt(loan.quotedKtaRaw)
      ? { level: "OK", detail: "quotedKtaRaw reproduces" }
      : { level: "FAIL", detail: `quotedKtaRaw ${loan.quotedKtaRaw} != ${got}` };
  }
  const repriced = loan.pricedAt != null && Number(loan.pricedAt) !== Number(loan.openedAt);
  const got = floatNeed(loan.principalRaw, ltv, Number(loan.priceUsd));
  const diff = got - BigInt(loan.requiredKtaRaw);
  if (!repriced) {
    return diff === 0n ? { level: "OK", detail: "requiredKtaRaw reproduces" } : { level: "FAIL", detail: `requiredKtaRaw differs by ${diff}` };
  }
  return { level: "REPORT", detail: `re-priced, original quote not kept (difference ${diff})` };
}

// ---- Audit

export const PINNED = {
  usdc: "keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna",
  kta: "keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg",
  house: {
    custody: "keeta_aabtniyuzvglb242mqtzxftjnld4t3msn3h625mp7q37yyf7orjc4lnmmhwlt6y",
    inventory: "keeta_aaby7hhw4hed7lakiryc3gj7g57ukatagjvnt6d5f2y33yxwh6zyo6ghqhbvbwy",
    servicing: "keeta_aabrjwaqbgjyjipsvvelwl6plj3iohj53p3o7l72ot47rdeasx3rpcmlrzbqb4i",
    checker: "keeta_aab2sotkleigi2djzvs3xbfojhqezksjnu7st3qptteccangnqhbiehp6nznmya",
    desk: "keeta_aabirtl4i3n4xawprl3rwvijltxdbidpi3v6nziyqmtdn2lkj4bd2bf5phbe7gq",
  },
  treasury: "keeta_aabn4lqecjlv3nvsp374gk5jtog6uzmghoiwyjxf4wr5wlzlkruhvszb5f4g5uq",
  gas: "keeta_aab7fkht5ty3clefamvouza3eg273tdvyd3sxxjwn26uasatodvsmiun7ifwsma",
};
const SEND = 0;

export class Report {
  constructor() {
    this.items = [];
  }
  add(level, code, message, extra = {}) {
    this.items.push({ level, code, message, ...extra });
  }
  get ok() {
    return !this.items.some((item) => item.level === "FAIL");
  }
  count(level) {
    return this.items.filter((item) => item.level === level).length;
  }
}

/** The keeper's hash compare (funding.mjs sameHash): case-insensitive, by uppercasing both sides. */
export const normHash = (hash) => String(hash || "").trim().toUpperCase();
export const sameHash = (a, b) => normHash(a) !== "" && normHash(a) === normHash(b);

const big = (value) => (value == null ? null : BigInt(value));
const num = (value) => (value == null ? null : Number(value));
const ms = (iso) => Date.parse(iso);

/** Config from genesis, checked against the pinned addresses. */
export function configFrom(records, report, anchors = []) {
  const genesis = records.find((record) => record.event === "genesis") || {};
  const house = { ...PINNED.house };
  for (const [name, address] of Object.entries(genesis.house || {})) {
    if (PINNED.house[name] && PINNED.house[name] !== address) report.add("FAIL", "GENESIS", `genesis ${name} ${address} differs from the pinned address`);
  }
  if (genesis.usdc && genesis.usdc !== PINNED.usdc) report.add("FAIL", "USDC TOKEN", `genesis USDC ${genesis.usdc} is not the pinned token`);
  const listed = [...anchors, ...(Array.isArray(genesis.anchors) ? genesis.anchors : [])];
  return { house, treasury: PINNED.treasury, gas: PINNED.gas, usdc: PINNED.usdc, kta: genesis.kta || PINNED.kta, anchors: new Set(listed), since: genesis.at ? ms(genesis.at) : 0 };
}

export function loansFrom(records) {
  const loans = new Map();
  for (const record of records) {
    if (!record.loanId) continue;
    if (!loans.has(record.loanId)) loans.set(record.loanId, { id: record.loanId, borrower: record.borrower, events: [] });
    const loan = loans.get(record.loanId);
    loan.borrower = loan.borrower || record.borrower;
    loan.events.push(record);
  }
  return loans;
}

/** §A5 step 6: replay each loan's records against the rules. */
export function checkLoanRules(loans, report) {
  for (const loan of loans.values()) {
    const by = (event) => loan.events.filter((record) => record.event === event);
    const open = by("open_quote")[0];
    const where = { loanId: loan.id };
    if (open?.backfill) {
      const result = replayOldLoan(open);
      report.add(result.level === "REPORT" ? "WARN" : result.level, "OLD-LOAN REPLAY", result.detail, where);
    } else if (open) {
      const ltv = num(open.maxLtv);
      const principal = big(open.principalRaw);
      if (ltv !== 0.25 && ltv !== 0.4) report.add("FAIL", "OPEN LTV", `maxLtv ${open.maxLtv} not 0.25 or 0.40`, where);
      if (ltv === 0.4 && open.kycTier !== "kyc") report.add("FAIL", "OPEN LTV", "0.40 without a KYC tier", where);
      if (principal < MIN_PRINCIPAL_RAW) report.add("FAIL", "OPEN SIZE", `principal ${principal} below the keeper's $0.40 floor`, where);
      // The $10.00 cap is not enforced by the keeper yet (only the shadow log flags it): warn, don't fail.
      if (principal > MAX_PRINCIPAL_RAW) report.add("WARN", "OPEN CAP", `principal ${principal} above the planned $10.00 cap (not enforced yet)`, where);
      const spot = num(open.openSpot ?? open.priceUsd);
      if (!spotInRange(spot)) report.add("FAIL", "OPEN PRICE", `spot ${spot} outside (0.01, 5)`, where);
      if (open.openTwap != null) {
        const min = Math.min(num(open.openSpot), num(open.openTwap));
        if (open.openPx != null && num(open.openPx) !== min) report.add("FAIL", "OPEN PRICE", "openPx is not min(openSpot, openTwap)", where);
        if (!pricesAgree(num(open.openSpot), num(open.openTwap))) report.add("WARN", "OPEN BAND", "spot and twap disagree at open (not enforced at open yet)", where);
      } else {
        report.add("WARN", "OPEN BAND", "no twap stored at open; band not provable", where);
      }
      // The live keeper sizes the open quote at spot (priceUsd), float mode.
      const sized = sizeFor(open.sizingMode || "float", principal, ltv, num(open.priceUsd ?? open.openSpot));
      if (open.quotedKtaRaw != null && sized !== big(open.quotedKtaRaw)) report.add("FAIL", "OPEN SIZE", `quotedKtaRaw ${open.quotedKtaRaw} != ${sized}`, where);
    }

    const intents = by("fund_intent");
    const funds = by("fund");
    if (funds.length > 1) report.add("FAIL", "DOUBLE FUND", `${funds.length} fund records`, where);
    for (const fund of funds) {
      const intent = intents.filter((record) => record.seq < fund.seq).at(-1);
      if (!intent) report.add("FAIL", "FUND ORDER", "fund without an earlier fund_intent", where);
      const hashes = String(intent?.sendBlockHash || "").split(",").map(normHash).filter(Boolean);
      if (intent && !(fund.blocks || []).some((hash) => hashes.includes(normHash(hash)))) report.add("FAIL", "FUND HASH", "fund block is not the fund_intent sendBlockHash", where);
      if (fund.fundTwap != null) {
        if (num(fund.fundPx) !== Math.min(num(fund.fundSpot), num(fund.fundTwap))) report.add("FAIL", "FUND PRICE", "fundPx is not min(fundSpot, fundTwap)", where);
        if (!pricesAgree(num(fund.fundSpot), num(fund.fundTwap))) report.add("FAIL", "FUND BAND", "pricesAgree fails at funding", where);
        if (open && !open.backfill) {
          const need = sizeFor(fund.sizingMode || "float", fund.principalRaw, num(open.maxLtv), num(fund.fundPx));
          if (fund.requiredKtaRaw != null && need !== big(fund.requiredKtaRaw)) report.add("FAIL", "FUND SIZE", `requiredKtaRaw ${fund.requiredKtaRaw} != ${need}`, where);
        }
      }
      const seen = by("kta_received").filter((record) => record.seq < fund.seq).at(-1);
      if (seen && fund.requiredKtaRaw != null && big(seen.vaultBalanceRaw) < big(fund.requiredKtaRaw)) {
        report.add("FAIL", "FUND COLLATERAL", "last seen vault balance below requiredKtaRaw", where);
      }
    }

    const fundedAt = intents[0] ? ms(intents[0].at) : null;
    for (const close of by("close")) {
      const total = big(close.totalReceivedRaw ?? "0");
      if (open && total < big(open.principalRaw)) report.add("FAIL", "CLOSE", "closed with less than principal received", where);
      if (close.dueRaw != null && total + CLOSE_TOLERANCE_RAW < big(close.dueRaw)) report.add("FAIL", "CLOSE", "closed below due − $0.01", where);
      if (close.dueRaw != null && fundedAt && open) {
        const expect = dueRaw(big(open.principalRaw), fundedAt, ms(close.at));
        const slack = 1n + big(open.principalRaw) / 1_000_000n; // timestamps are ~seconds apart from the keeper's clock
        const diff = expect > big(close.dueRaw) ? expect - big(close.dueRaw) : big(close.dueRaw) - expect;
        if (diff > slack) report.add("WARN", "CLOSE DUE", `dueRaw ${close.dueRaw} vs recomputed ${expect}`, where);
      }
      if (close.vaultBalanceRaw != null && close.ktaReturnedRaw != null && close.blocks?.length && big(close.ktaReturnedRaw) !== big(close.vaultBalanceRaw)) {
        report.add("FAIL", "CLOSE", "ktaReturnedRaw is not the vault balance", where);
      }
    }
    for (const refund of by("overpay_refund")) {
      if (refund.totalReceivedRaw != null && refund.dueRaw != null && big(refund.refundRaw) !== big(refund.totalReceivedRaw) - big(refund.dueRaw)) {
        report.add("FAIL", "REFUND", "refundRaw is not totalReceived − due", where);
      }
    }
    const liq = by("liquidation")[0];
    if (liq) {
      const spot = num(liq.liqSpot);
      const vault = big(liq.vaultAtSeizeRaw);
      if (liq.liqDueRaw != null && vault != null && spot) {
        const seize = seizeRaw(big(liq.liqDueRaw), vault, spot);
        if (seize !== big(liq.seizeKtaRaw)) report.add("FAIL", "LIQ SEIZE", `seizeKtaRaw ${liq.seizeKtaRaw} != ${seize}`, where);
        if (big(liq.returnedKtaRaw) !== (vault > seize ? vault - seize : 0n)) report.add("FAIL", "LIQ RETURN", "returnedKtaRaw is not vault − seize", where);
      }
      if (liq.forced !== "true" && liq.debtRaw != null && liq.vaultAtCheckRaw != null && spot) {
        if (loanLtv(big(liq.debtRaw), big(liq.vaultAtCheckRaw), spot) < LIQ_LTV) report.add("FAIL", "LIQ TRIGGER", "LTV below 52% at liquidation", where);
        if (liq.markTwap != null && !pricesAgree(num(liq.markSpot), num(liq.markTwap))) report.add("FAIL", "LIQ BAND", "pricesAgree fails at liquidation", where);
      }
      if (liq.forced === "true") report.add("WARN", "LIQ FORCED", "owner-forced liquidation (no trigger check)", where);
      for (const settle of by("liquidation_settle")) {
        const principal = big(liq.remainPrincipalRaw);
        const due = big(liq.liqDueRaw);
        if (principal != null && big(settle.principalToInventoryRaw ?? "0") !== principal) report.add("FAIL", "SETTLE", "principal to inventory is not remainPrincipalRaw", where);
        if (principal != null && due != null && big(settle.feeToTreasuryRaw ?? "0") !== (due > principal ? due - principal : 0n)) report.add("FAIL", "SETTLE", "fee is not remainLiq − remainPrincipal", where);
        if (settle.saleUsdcRaw != null && settle.coveredRaw != null && big(settle.usdcSurplusRaw ?? "0") !== big(settle.saleUsdcRaw) - big(settle.coveredRaw)) report.add("FAIL", "SETTLE", "surplus is not sale − covered", where);
      }
    }
    for (const sweep of by("gas_sweep")) {
      if (big(sweep.gasSweepKtaRaw) > GAS_SWEEP_MAX_RAW) report.add("FAIL", "GAS SWEEP", "gas sweep above 20 KTA", where);
    }
    for (const expiry of by("expiry_refund")) {
      if (funds.some((fund) => fund.seq < expiry.seq)) report.add("FAIL", "EXPIRY", "expiry_refund after the loan was funded", where);
      if (open?.holdUntil && ms(expiry.at) < ms(open.holdUntil)) report.add("FAIL", "EXPIRY", "expired before holdUntil", where);
      if (expiry.vaultBalanceRaw != null && big(expiry.refundKtaRaw) !== big(expiry.vaultBalanceRaw)) report.add("FAIL", "EXPIRY", "refund is not the vault balance", where);
    }
  }
}

/** Expected on-chain sends for each logged record: [{ hash|null, from, to, token, amount, record, label }]. */
export function expectedSends(records, loans, cfg) {
  const out = [];
  const vaultOf = new Map();
  for (const loan of loans.values()) {
    const open = loan.events.find((record) => record.event === "open_quote");
    if (open?.vault) vaultOf.set(loan.id, open.vault);
  }
  const push = (record, hashes, from, to, token, amount, label, external) => {
    if (amount == null) return;
    const list = hashes == null ? [null] : [].concat(hashes).map(normHash).filter(Boolean);
    for (const hash of list.length ? list : [null]) out.push({ hash, from, to, token, amount: BigInt(amount), record, label, external });
  };
  for (const record of records) {
    const vault = vaultOf.get(record.loanId);
    const b = record.blocks;
    switch (record.event) {
      case "fund":
        // Without a block hash, a funding send only matches its keelend:<loanId> tag, never a same-size payment.
        push(record, b, cfg.house.inventory, record.borrower, cfg.usdc, record.principalRaw, "fund", `keelend:${record.loanId}`);
        break;
      case "overpay_refund":
        push(record, b, cfg.house.servicing, record.borrower, cfg.usdc, record.refundRaw, "overpay_refund");
        break;
      case "close":
        if (record.ktaReturnedRaw && BigInt(record.ktaReturnedRaw) > 0n) push(record, b, vault, record.borrower, cfg.kta, record.ktaReturnedRaw, "close");
        break;
      case "expiry_refund":
        if (record.refundKtaRaw && BigInt(record.refundKtaRaw) > 0n) push(record, b, vault, record.borrower, cfg.kta, record.refundKtaRaw, "expiry_refund");
        break;
      case "liquidation":
        if (BigInt(record.seizeKtaRaw || "0") > 0n) push(record, null, vault, cfg.house.desk, cfg.kta, record.seizeKtaRaw, "liquidation seize");
        if (BigInt(record.returnedKtaRaw || "0") > 0n) push(record, null, vault, record.borrower, cfg.kta, record.returnedKtaRaw, "liquidation return");
        break;
      case "liquidation_settle":
        if (BigInt(record.principalToInventoryRaw || "0") > 0n) push(record, b?.principalToInventory, cfg.house.desk, cfg.house.inventory, cfg.usdc, record.principalToInventoryRaw, "settle principal");
        if (BigInt(record.feeToTreasuryRaw || "0") > 0n) push(record, b?.feeToTreasury, cfg.house.desk, cfg.treasury, cfg.usdc, record.feeToTreasuryRaw, "settle fee");
        if (BigInt(record.usdcSurplusRaw || "0") > 0n) push(record, b?.surplusToBorrower, cfg.house.desk, record.borrower, cfg.usdc, record.usdcSurplusRaw, "settle surplus");
        break;
      case "gas_sweep":
        push(record, b, cfg.house.desk, cfg.gas, cfg.kta, record.gasSweepKtaRaw, "gas sweep");
        break;
      case "gas_topup":
        push(record, b, cfg.gas, record.to, cfg.kta, record.amountRaw, "gas top-up");
        break;
      default:
        break;
    }
  }
  return out;
}

/** Classify one on-chain send against the allowed-flows map. Returns { allowed, label, loggedByKeeper }. */
export function classifyFlow(send, cfg, vaults, borrowers) {
  const { from, to, token } = send;
  const h = cfg.house;
  const isVault = vaults.has(from);
  const tokenIs = (t) => token === t;
  if (from === h.custody && to === h.desk && tokenIs(cfg.kta)) return { allowed: send.amount === 200_000_000_000_000_000n, label: "swap fees", loggedByKeeper: false };
  if (from === h.custody && vaults.has(to) && tokenIs(cfg.kta)) return { allowed: true, label: "vault creation", loggedByKeeper: false };
  if (from === h.inventory && borrowers.has(to) && tokenIs(cfg.usdc)) return { allowed: true, label: "fund", loggedByKeeper: true };
  if (from === h.servicing && borrowers.has(to) && tokenIs(cfg.usdc)) return { allowed: true, label: "overpay_refund", loggedByKeeper: true };
  if (isVault && borrowers.has(to) && tokenIs(cfg.kta)) return { allowed: true, label: "vault to borrower", loggedByKeeper: true };
  if (isVault && to === h.desk && tokenIs(cfg.kta)) return { allowed: true, label: "liquidation seize", loggedByKeeper: true };
  if (from === h.desk && cfg.anchors.has(to)) return { allowed: true, label: "liquidation sale", loggedByKeeper: false };
  if (from === h.desk && to === h.inventory && tokenIs(cfg.usdc)) return { allowed: true, label: "settle principal", loggedByKeeper: true };
  if (from === h.desk && to === cfg.treasury && tokenIs(cfg.usdc)) return { allowed: true, label: "settle fee", loggedByKeeper: true };
  if (from === h.desk && borrowers.has(to) && tokenIs(cfg.usdc)) return { allowed: true, label: "settle surplus", loggedByKeeper: true };
  if (from === h.desk && to === cfg.gas && tokenIs(cfg.kta)) return { allowed: send.amount <= GAS_SWEEP_MAX_RAW, label: "gas sweep", loggedByKeeper: true };
  if (from === cfg.gas && [h.custody, h.inventory, h.checker, h.desk].includes(to) && tokenIs(cfg.kta)) return { allowed: send.amount === GAS_TOP_RAW, label: "gas top-up", loggedByKeeper: true };
  return { allowed: false, label: "unexpected", loggedByKeeper: false };
}

/** Flatten history rows into sends and receipts for one account, from `since` on. */
export function sendsIn(rows, since = 0) {
  const out = [];
  for (const row of rows) {
    for (const block of row.voteStaple?.blocks || []) {
      const when = Date.parse(block.date || row.$timestamp || "");
      if (Number.isFinite(when) && when < since) continue;
      (block.operations || []).forEach((op, index) => {
        if (op.type !== SEND) return;
        out.push({ hash: normHash(block.$hash), index, from: block.account, to: op.to, token: op.token, amount: BigInt(op.amount), external: op.external, at: when });
      });
    }
  }
  return out;
}

/**
 * §A5 step 7. history: Map(address -> rows). Every send authored by a house account or a vault
 * must match a log record and the allowed-flows map; every logged block must exist on-chain.
 */
export function reconcile(records, history, cfg, report) {
  const loans = loansFrom(records);
  const vaults = new Set(records.filter((record) => record.event === "open_quote" && record.vault).map((record) => record.vault));
  const borrowers = new Set([...loans.values()].map((loan) => loan.borrower).filter(Boolean));
  const authors = new Set([...Object.values(cfg.house), cfg.gas, cfg.treasury, ...vaults]);
  const seen = new Map();
  for (const rows of history.values()) {
    for (const send of sendsIn(rows, cfg.since)) {
      if (!authors.has(send.from)) continue;
      const key = `${send.hash}:${send.index}`;
      if (!seen.has(key)) seen.set(key, send);
    }
  }
  const expected = expectedSends(records, loans, cfg);
  const used = new Set();
  const matchOf = (exp) => {
    for (const [key, send] of seen) {
      if (used.has(key)) continue;
      if (exp.hash && !sameHash(send.hash, exp.hash)) continue;
      if (!exp.hash && exp.external && send.external !== exp.external) continue;
      if (send.from === exp.from && send.to === exp.to && send.token === exp.token && send.amount === exp.amount) return key;
    }
    return null;
  };
  // Hash-bound expectations first, then amount-bound ones (liquidation seize/return).
  for (const exp of [...expected.filter((e) => e.hash), ...expected.filter((e) => !e.hash)]) {
    const key = matchOf(exp);
    if (key) {
      used.add(key);
      continue;
    }
    const hashOnChain = exp.hash && [...seen.values()].some((send) => sameHash(send.hash, exp.hash));
    report.add("FAIL", "PHANTOM LOG ENTRY", `${exp.label}: ${exp.hash ? "block " + exp.hash : "no matching send"} ${hashOnChain ? "exists but amount, token or destination differ" : "not found on-chain"}`, { loanId: exp.record.loanId, seq: exp.record.seq });
  }
  for (const [key, send] of seen) {
    const flow = classifyFlow(send, cfg, vaults, borrowers);
    const where = { block: send.hash, index: send.index, from: send.from, to: send.to, amount: send.amount.toString(), token: send.token };
    if (send.token !== cfg.usdc && send.token !== cfg.kta) report.add("FAIL", "USDC TOKEN", "send in a token that is neither pinned USDC nor KTA", where);
    if (!flow.allowed) report.add("FAIL", "UNEXPECTED FLOW", `${flow.label} send outside the allowed-flows map`, where);
    if (!used.has(key)) {
      if (flow.allowed && !flow.loggedByKeeper) report.add("WARN", "UNLOGGED SEND", `${flow.label}: allowed flow the keeper does not log yet`, where);
      else report.add("FAIL", "UNLOGGED SEND", `${flow.label} send has no log record`, where);
    }
  }
  // DOUBLE SEND: more than one inventory -> borrower USDC send that belongs to THIS loan, i.e. carries
  // its keelend:<loanId> tag or one of its stored send hashes. Same-size payments to the same address
  // for a different loan (or untagged) are not this loan's sends.
  for (const loan of loans.values()) {
    const own = new Set(loan.events.flatMap((record) => [
      ...String(record.event === "fund_intent" ? record.sendBlockHash || "" : "").split(","),
      ...(record.event === "fund" ? [].concat(record.blocks || []) : []),
    ]).map(normHash).filter(Boolean));
    const blocks = new Set();
    for (const send of seen.values()) {
      if (send.from !== cfg.house.inventory || send.to !== loan.borrower || send.token !== cfg.usdc) continue;
      if (send.external === `keelend:${loan.id}` || own.has(send.hash)) blocks.add(send.hash);
    }
    if (blocks.size > 1) report.add("FAIL", "DOUBLE SEND", `${blocks.size} inventory → borrower USDC sends for one loan`, { loanId: loan.id, blocks: [...blocks] });
  }
  // Inbound to vaults and servicing: informational only.
  const logged = new Set(records.flatMap((record) => [].concat(record.blocks || [])).map(normHash));
  for (const [address, rows] of history) {
    if (!(vaults.has(address) || address === cfg.house.servicing)) continue;
    for (const send of sendsIn(rows, cfg.since)) {
      if (send.to !== address || authors.has(send.from)) continue;
      if (address === cfg.house.servicing && !logged.has(send.hash)) report.add("INFO", "UNMATCHED INBOUND", "transfer into servicing with no repayment_received", { block: send.hash, from: send.from, amount: send.amount.toString(), token: send.token });
    }
  }
  return { sends: seen.size, expected: expected.length };
}
