// Pure helpers for finance import reconciliation.
//
// Two jobs live here so both the API route and the guard tests can use them:
// - inferImportCategory: staged CSV rows used to default to category "other";
//   infer a category from the description/payee keywords instead, falling
//   back to "other" (expenses) or the manual-entry default "sales" (income).
// - findNearMatch: exact fingerprint matching misses rows whose bank memo
//   differs slightly from the ledger entry. Surface the most likely ledger
//   candidate (same direction and amount, close date and/or similar
//   description) so the owner can confirm the match instead of guessing.

export type ReconcilableRow = {
  transaction_date: string;
  direction: "income" | "expense";
  amount_cents: number | string;
  description: string;
};

export type LedgerCandidate = ReconcilableRow & { id: string };

export type NearMatch = {
  transaction_id: string;
  transaction_date: string;
  description: string;
  amount_cents: string;
  reason: string;
};

export function normalizeDescription(description: string) {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

function descriptionTokens(description: string) {
  return new Set(normalizeDescription(description).split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

// Share of distinct description words the two texts have in common (Jaccard).
export function descriptionSimilarity(left: string, right: string) {
  const a = descriptionTokens(left);
  const b = descriptionTokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function dayDifference(left: string, right: string) {
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(a - b) / 86_400_000);
}

// Best near-match for a staged row among recorded ledger entries, or null.
// Exact matches (same date, amount, and normalized description) are excluded:
// the fingerprint re-check already flags those as duplicates automatically.
export function findNearMatch(row: ReconcilableRow, candidates: LedgerCandidate[]): NearMatch | null {
  const rowCents = Number(row.amount_cents);
  if (!Number.isFinite(rowCents)) return null;
  let best: { candidate: LedgerCandidate; score: number; reason: string } | null = null;
  for (const candidate of candidates) {
    if (candidate.direction !== row.direction) continue;
    if (Number(candidate.amount_cents) !== rowCents) continue;
    const days = dayDifference(row.transaction_date, candidate.transaction_date);
    const sameDescription = normalizeDescription(candidate.description) === normalizeDescription(row.description);
    if (days === 0 && sameDescription) continue;
    let score = 0;
    let reason = "";
    if (days === 0) {
      score = 100;
      reason = "Same amount and date · different description wording";
    } else if (days <= 3) {
      score = 90 - days * 5;
      reason = `Same amount · ${days} day${days === 1 ? "" : "s"} apart`;
    }
    const similarity = descriptionSimilarity(row.description, candidate.description);
    if (similarity >= 0.5 && days > 3) {
      const similarityScore = 60 + Math.round(similarity * 30);
      if (similarityScore > score) {
        score = similarityScore;
        reason = "Same amount · similar description";
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { candidate, score, reason };
  }
  if (!best) return null;
  return {
    transaction_id: best.candidate.id,
    transaction_date: best.candidate.transaction_date,
    description: best.candidate.description,
    amount_cents: String(best.candidate.amount_cents),
    reason: best.reason,
  };
}

// Keyword rules over the existing finance category set, strongest first.
// Direction-agnostic rules (a refund or a tax payment reads the same either
// way) run before the income-only defaults.
const sharedCategoryRules: [string, RegExp][] = [
  ["refund", /\b(refund|chargeback|reversal|returned)\b/],
  ["taxes", /\b(tax|irs|vat|department of revenue|treasury)\b/],
  ["subscriptions", /\b(subscription|membership|recurring)\b/],
  ["infrastructure", /\b(vercel|supabase|aws|amazon web services|digitalocean|cloudflare|linode|vultr|hosting|domain|dns|server|proxmox)\b/],
  ["software", /\b(software|saas|github|gitlab|openai|anthropic|adobe|figma|notion|slack|microsoft 365|google workspace|quickbooks|license|licence)\b/],
  ["marketing", /\b(advertising|marketing|google ads|facebook ads|meta ads|promotion|sponsorship)\b/],
  ["operations", /\b(rent|utilities|utility|electric|internet|phone|insurance|shipping|postage|supplies|office|fuel|maintenance|repair)\b/],
];

const servicesPattern = /\b(service|services|consulting|consultation|design|development|retainer|freelance|contract work)\b/;
const salesPattern = /\b(stripe|square|paypal|sale|sales|invoice payment|payment received|client payment|deposit)\b/;

export function inferImportCategory(description: string, direction: "income" | "expense"): string {
  const text = normalizeDescription(description);
  for (const [category, pattern] of sharedCategoryRules) {
    if (pattern.test(text)) return category;
  }
  if (direction === "income") {
    if (servicesPattern.test(text)) return "services";
    if (salesPattern.test(text)) return "sales";
    // Unexplained income defaults to sales, matching the manual-entry form.
    return "sales";
  }
  return "other";
}
