# keelend-verify

Independent, read-only verifier for [KeeLend](https://keelend.com) — USDC loans against KTA collateral on the Keeta network.

KeeLend runs without smart contracts. Instead, its keeper publishes a signed, hash-chained trust log of every loan event, and every send it makes lands on the public Keeta ledger. This repo lets **anyone** check the two against each other without trusting KeeLend:

- **`verify.mjs`** — checks the log's hash chain and signatures, replays each loan against the published rules (LTV caps, interest, fees, collateral sizing), and reconciles every logged send with the real on-chain blocks. It flags phantom log entries, unlogged sends, double funding, wrong tokens and rule breaks.
- **`reserves.mjs`** — reads live balances of KeeLend's public house accounts and produces a proof-of-reserves report (`reserves.json` + static `reserves.html`): USDC lendable vs. reserved, outstanding loans, collateral held and per-loan LTV.
- **`alerts.mjs`** — lists loans at or above 48% LTV and any stuck sends; can optionally notify via `KEELEND_ALERT_FILE` / `KEELEND_ALERT_WEBHOOK`.

No account, seed, API key or KeeLend code is needed. It only reads public files and the public Keeta API.

## Quick start

```sh
git clone https://github.com/kDevWithBev/keelend-verify.git
cd keelend-verify
npm test                                   # Node >= 20, no install needed for tests
node verify.mjs https://<keeper-host>/log/<date>.jsonl
node reserves.mjs <log file or URL> --out ./out
```

`@keetanetwork/keetanet-client` is an optional dependency (`npm install`) used only for signature checks; pinned house account addresses and the USDC token id are in `audit.mjs` (`PINNED`), so you can compare them with what KeeLend publishes.

## Exit codes / results

Any `FAIL` line means the log and the ledger disagree or a loan broke the published rules. `WARN` and `INFO` are informational. Details below.

---


This is a read-only checker for the KeeLend loan log. It needs no account, no seed and no keeper code. It only reads public files and the public Keeta ledger.

## Run it

```sh
git clone <this repo> && cd verifier
npm install            # only needed to check signatures (installs @keetanetwork/keetanet-client)
node verify.mjs https://<keeper-host>/log/2026-10-13.jsonl
```

Options:

| Flag | Meaning |
|---|---|
| `--key keeta_…` | Pin the log signing key. If you leave it out, the key named in the genesis record is used. |
| `--allow-unsigned` | Accept unsigned records. The private shadow log can be unsigned. |
| `--offline` | Check only the log's chain and rules. Skip the ledger. |
| `--history saved.json` | Use a saved `{ address: [historyRows] }` file instead of the live ledger. |
| `--anchor keeta_…` | Add an anchor-exchange counterparty, on top of any listed in genesis. You can repeat it. |
| `--api URL` | Use a different Keeta REST endpoint. The default is `https://rep1.main.network.api.keeta.com/api`. |
| `--json out.json` | Also write the full report as JSON. |

The exit code is `0` when nothing failed and `1` on any FAIL. Each problem is printed as `FAIL`, `WARN` or `INFO`, with the loan, record and block it applies to.

## What it checks

1. **Chain:** `seq` runs from 0 with no gaps, each `prevHash` equals the previous `hash`, and each `hash` is the sha256 of the record with sorted keys and no whitespace. The first record is `genesis`.
2. **Signatures:** every `sig` verifies against the log key, using Keeta `Account.verify` with the public key only.
3. **Schema:** amounts are strings and missing fields are left out instead of `null`. `fundSpot`, `fundTwap` and `fundPx` appear only on `fund` records.
4. **Rules, replayed per loan** with the keeper's own functions at the top of `audit.mjs`:
   - **Open:** LTV and tier, the $0.40 floor, the price range, and the quoted KTA. A principal above the planned $10.00 cap is a WARN until the keeper enforces it.
   - **Funding:**
     - a `fund_intent` comes first, and the `fund` block equals its precomputed `sendBlockHash`
     - `fundPx` is the min of spot and average, and the 3% band holds
     - the required KTA reproduces, and the vault held enough
   - **Close and refund:**
     - total ≥ principal, and total + $0.01 ≥ due
     - the refund equals received − due
     - the KTA returned equals the vault balance
   - **Liquidation:**
     - the trigger is LTV ≥ 52% with the band holding, unless the owner forced it
     - the seize amount uses the keeper's rounding, and returned = vault − seized
   - **Settlement:**
     - principal goes to inventory and the fee (= remainLiq − remainPrincipal) to treasury
     - the surplus goes to the borrower
     - the gas sweep is ≤ 20 KTA
   - **Expiry:** after `holdUntil` and never after funding.
   - **Old loans (backfilled):** the §A5a replay rule. A loan that was re-priced is reported, not failed.
5. **On-chain reconciliation:** it pages the history of every house account and every vault named in the log, then:
   - **UNLOGGED SEND:** a send by a house account or vault with no matching log record. It's a WARN only for allowed flows the keeper doesn't log yet: anchor sales, the 0.2 KTA swap-fee transfer and vault creation.
   - **PHANTOM LOG ENTRY:** a logged block that isn't on-chain, or doesn't match the logged amount, token or destination.
   - **UNEXPECTED FLOW:** any send outside the allowed-flows map. The map includes gas top-ups of exactly 2 KTA, the settlement split and the listed anchor counterparties.
   - **DOUBLE SEND:** more than one inventory → borrower USDC send that belongs to one loan. A send belongs to the loan if it carries the `keelend:<loanId>` tag or one of that loan's stored hashes. A same-size payment to the same address for another loan doesn't count.
   - **Block hashes** are compared case-insensitively, the way the keeper compares them: both sides are uppercased.
   - **USDC TOKEN:** the USDC token is pinned to `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna`.
   - Unmatched transfers *into* servicing are informational.

## Tests

```sh
node --test test/       # fixture log + ledger history are built in test/verifier.test.mjs
```

## Limits

- The keeper doesn't yet log anchor sale pieces (`liquidation_sale`), the swap-fee transfer or vault creation. Those are allowed but show as WARN.
- Liquidation seize and return sends are matched by vault, destination and amount, because the keeper doesn't keep their block hashes.
- Daily anchors (§A4), `head.json`, key rotation and multi-file logs aren't checked yet. Run it once per day's file in order, or join the files first.

## Proof of reserves (`reserves.mjs`)

`reserves.mjs` is read-only, like the verifier. It reads:
- Keeta REST balances (GET) for every house account and every vault named in the log
- the KTA price, through the same read-only `eth_call` the keeper's `mark()` uses
- the trust log

It writes two files: `reserves.json`, and `reserves.html`, a static page with no scripts and no external files.

```sh
node reserves.mjs /opt/keelend/trust-log.jsonl --out /var/www/keelend-reserves --verifier-url <public verifier repo URL>
```

The page shows:
- **USDC:** lendable USDC (inventory minus the principal reserved for waiting, sending and stuck-send vaults), outstanding principal and interest, and servicing and treasury listed separately as collected
- **Refunds:** refunds owed against the servicing account, with a red banner if servicing is short
- **Collateral:** total vault KTA against total debt
- **Loans:** a table of LTV (red at 48% or more; computed on the **full amount due**, as in the keeper's liquidation check, with partial payments shown separately as "paid so far"), liquidation price (`debt / (0.52 × KTA)`), max LTV, sizing mode and status, including `stuck-send`
- **Log:** the log head (seq, hash, signature status). The verifier link appears only when `--verifier-url` is given; there's no default.

If the 3% check between spot and the 30-minute average fails, or the average is missing, the page says **"price unsettled"** and shows each LTV at both prices. If the price can't be read at all, no LTV is shown. The $0.10 preview is never used.

The exit code is `0` when OK, `2` when refunds are short, and `1` on an error.

### Cron on the VPS

The generator needs Node 20 or later and no secrets. It never touches the keeper process or the loan book. Run it every 5 minutes as a user with no access to `/opt/keelend/.env`:

```cron
*/5 * * * * cd /opt/keelend-verify && /usr/bin/node reserves.mjs /opt/keelend/trust-log.jsonl --out /var/www/keelend-reserves >> /var/log/keelend-reserves.log 2>&1
```

- Serve `/var/www/keelend-reserves` as static files, for example with an nginx `location /reserves/`.
- The log is only read, so a read-only bind or a copy of `trust-log.jsonl` is enough.
- Signatures are checked when `npm install` has installed the Keeta SDK and the genesis record (or `--key`) names the log key. Otherwise the page says "not checked".

## LTV alerts (`alerts.mjs`)

`alerts.mjs` uses the same read-only data and price rules as `reserves.mjs`. It writes a public `alerts.json` that lists:
- every funded loan at **LTV ≥ 48%**, with the loan id, borrower, LTV at the price used, liquidation price and status
- every **`stuck-send`** loan

If the price is unsettled, each loan carries `ltvAtSpot` and `ltvAtTwap`, and it's listed when either one is ≥ 48%. If the price can't be read, no LTV alerts are made, but stuck-send loans are still listed. The $0.10 preview is never used.

```sh
node alerts.mjs /opt/keelend/trust-log.jsonl --out /var/www/keelend-reserves
```

You can also be notified yourself. The alert is sent only when the set of alerts changes since the previous `alerts.json`, and a failure never stops the run:
- `KEELEND_ALERT_FILE=/var/log/keelend-alerts.jsonl` appends one JSON line.
- `KEELEND_ALERT_WEBHOOK=https://…` POSTs the same JSON to your own webhook.

Cron, next to the reserves job:

```cron
*/2 * * * * cd /opt/keelend-verify && KEELEND_ALERT_FILE=/var/log/keelend-alerts.jsonl /usr/bin/node alerts.mjs /opt/keelend/trust-log.jsonl --out /var/www/keelend-reserves >> /var/log/keelend-alerts.log 2>&1
```
