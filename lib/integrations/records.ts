import { query } from "../db";

export async function upsertExternalRecord(record: {
  provider: string;
  record_type: string;
  external_id: string;
  title: string;
  url?: string | null;
  status?: string | null;
  owner?: string | null;
  occurred_at?: string | null;
  payload: unknown;
}) {
  const result = await query<{ id: string }>(`INSERT INTO external_records
    (provider,record_type,external_id,title,url,status,owner,occurred_at,payload,last_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
    ON CONFLICT (provider,record_type,external_id)
    DO UPDATE SET title=EXCLUDED.title,url=EXCLUDED.url,status=EXCLUDED.status,owner=EXCLUDED.owner,
      occurred_at=EXCLUDED.occurred_at,payload=EXCLUDED.payload,last_seen_at=NOW()
    RETURNING id`, [
    record.provider,
    record.record_type,
    record.external_id,
    record.title,
    record.url ?? null,
    record.status ?? null,
    record.owner ?? null,
    record.occurred_at ? new Date(record.occurred_at) : null,
    JSON.stringify(record.payload),
  ]);
  return result.rowCount ?? 0;
}
