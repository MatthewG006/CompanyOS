import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { descriptionSimilarity, findNearMatch, inferImportCategory, type LedgerCandidate } from "../lib/finance/reconcile.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const ledgerEntry = (overrides: Partial<LedgerCandidate>): LedgerCandidate => ({
  id: "11111111-1111-4111-8111-111111111111",
  transaction_date: "2026-11-05",
  direction: "expense",
  amount_cents: "4999",
  description: "Vercel hosting",
  ...overrides,
});

test("near-match suggestions skip exact matches and surface close ones", () => {
  const row = { transaction_date: "2026-11-05", direction: "expense" as const, amount_cents: "4999", description: "Vercel hosting" };
  // Exact fingerprint territory: same date, amount, and description.
  assert.equal(findNearMatch(row, [ledgerEntry({})]), null);
  // Same amount and date, bank wording differs.
  const reworded = findNearMatch(row, [ledgerEntry({ description: "VERCEL INC HOSTING SRVC" })]);
  assert.equal(reworded?.transaction_id, "11111111-1111-4111-8111-111111111111");
  assert.match(reworded?.reason ?? "", /Same amount and date/);
  // Same amount and description, posted two days later.
  const shifted = findNearMatch(row, [ledgerEntry({ transaction_date: "2026-11-07" })]);
  assert.match(shifted?.reason ?? "", /2 days apart/);
  // Same amount, far apart date, similar description.
  const similar = findNearMatch(
    { transaction_date: "2026-11-05", direction: "expense", amount_cents: "1200", description: "Monthly software subscription payment" },
    [ledgerEntry({ transaction_date: "2026-10-01", amount_cents: "1200", description: "Software subscription payment" })],
  );
  assert.match(similar?.reason ?? "", /similar description/);
});

test("near-match suggestions require the same direction and amount", () => {
  const row = { transaction_date: "2026-11-05", direction: "expense" as const, amount_cents: "4999", description: "Vercel hosting" };
  assert.equal(findNearMatch(row, [ledgerEntry({ direction: "income" })]), null);
  assert.equal(findNearMatch(row, [ledgerEntry({ amount_cents: "5000" })]), null);
  assert.equal(findNearMatch(row, [ledgerEntry({ transaction_date: "2026-09-01", description: "Unrelated corner store purchase" })]), null);
  assert.ok(descriptionSimilarity("Vercel hosting invoice", "Vercel hosting") >= 0.5);
  assert.equal(descriptionSimilarity("Vercel hosting", "Corner store"), 0);
});

test("staged rows infer a category instead of defaulting everything to other", () => {
  assert.equal(inferImportCategory("STRIPE PAYMENT", "income"), "sales");
  assert.equal(inferImportCategory("Consulting services retainer", "income"), "services");
  assert.equal(inferImportCategory("Client refund issued", "expense"), "refund");
  assert.equal(inferImportCategory("IRS payroll tax payment", "expense"), "taxes");
  assert.equal(inferImportCategory("Monthly subscription charge", "expense"), "subscriptions");
  assert.equal(inferImportCategory("Vercel invoice", "expense"), "infrastructure");
  assert.equal(inferImportCategory("Adobe software license", "expense"), "software");
  assert.equal(inferImportCategory("Facebook Ads spend", "expense"), "marketing");
  assert.equal(inferImportCategory("Office rent", "expense"), "operations");
  assert.equal(inferImportCategory("Corner store", "expense"), "other");
  // Unexplained income follows the manual-entry default.
  assert.equal(inferImportCategory("Check 1042", "income"), "sales");
});

test("the imports API infers categories, suggests near matches, and accepts owner-confirmed matches", () => {
  const route = read("../app/api/finance/imports/route.ts");
  assert.match(route, /inferImportCategory\(row\.description, row\.direction\)/);
  assert.doesNotMatch(route, /'other',\$7/);
  assert.match(route, /suggested_match: row\.status === "pending" \? findNearMatch\(row, ledger\.rows\) : null/);
  assert.match(route, /decision === "mark_duplicate"/);
  assert.match(route, /SET status='duplicate',duplicate_note=\$2,transaction_id=\$3/);
});

test("the finance UI offers re-check, match confirmation, and an unmatched view", () => {
  const ledger = read("../app/finance/FinanceLedger.tsx");
  assert.match(ledger, /Re-check matches/);
  assert.match(ledger, /method: "PUT", headers: headers\(\), body: JSON\.stringify\(\{ batch_id: batch\.id \}\)/);
  assert.match(ledger, /Possible ledger match:/);
  assert.match(ledger, /decision: "mark_duplicate"/);
  assert.match(ledger, /Staged rows with no match/);
  assert.match(ledger, /Ledger entries with no import match/);
  assert.match(ledger, /unmatchedImportRows = importRows\.filter\(\(row\) => row\.status === "pending" && !row\.suggested_match\)/);
  assert.match(ledger, /unmatchedLedgerEntries = entries\.filter\(\(entry\) => entry\.status === "recorded" && !entry\.source_import_row_id\)/);
});
