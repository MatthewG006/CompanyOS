"use client";

/**
 * Shared search box for the long owner lists (ledger, cases, pipeline,
 * run history). Pair with `matchesQuery` for case-insensitive filtering
 * across whichever fields a list shows.
 */
export function ListSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <input
      type="search"
      className="list-search"
      aria-label={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
  );
}

/** True when the query is empty or appears in any of the given fields. */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLowerCase().includes(needle));
}
