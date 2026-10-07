import { query } from "./db";
import { dispatchGmailAttention } from "./workflows/gmail";

const EMAIL_RE = /<?([^<>\s]+@[^<>\s]+)>?$/i;
const NAME_EMAIL_RE = /^(.*?)\s*<?([^<>\s]+@[^<>\s]+)>?$/i;

export type EmailClassification = {
  category: "sales" | "support" | "billing" | "general";
  priority: "high" | "normal";
  projectSlug: string | null;
  businessRelevant: boolean;
  attention: boolean;
};

function cleanName(value: string | null | undefined) {
  return (value ?? "").replace(/^"|"$/g, "").trim() || null;
}

export function parseEmailAddress(raw: string) {
  const match = raw.match(NAME_EMAIL_RE);
  if (match) return { name: cleanName(match[1]) ?? null, email: match[2].toLowerCase() };
  const fallback = raw.match(EMAIL_RE);
  return { name: null, email: fallback?.[1]?.toLowerCase() ?? raw.trim().toLowerCase() };
}

export function classifyEmail(input: { subject: string; snippet: string; from: string; unread: boolean }): EmailClassification {
  const text = `${input.subject} ${input.snippet} ${input.from}`.toLowerCase();
  const projectSignals: Array<[string, RegExp]> = [
    ["sky-mountain-cloud", /sky mountain cloud|nextcloud|cloud storage|storage upgrade|65 gb|15 gb/],
    ["plenty-of-plants", /plenty of plants|plant game|nursery|plant collection|firebase|pwa/],
    ["sky-mountain-graphics", /sky mountain graphics|graphic design|web design|wordpress|website|logo|branding|contractor|roofer|auto repair/],
  ];
  const projectSlug = projectSignals.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  let category: EmailClassification["category"] = "general";
  if (/payment|invoice|receipt|billing|subscription|refund|charge/.test(text)) category = "billing";
  else if (/support|help|problem|issue|error|bug|cannot|can't|failed|broken|not working/.test(text)) category = "support";
  else if (/quote|estimate|proposal|pricing|price|interested|website|design|marketing|services|project|meeting|consult|lead|advertis/.test(text)) category = "sales";
  const businessRelevant = Boolean(projectSlug) || category !== "general";
  const attention = input.unread && businessRelevant;
  return { category, priority: /urgent|asap|critical|emergency/.test(text) ? "high" : "normal", projectSlug, businessRelevant, attention };
}

async function projectIdForSlug(slug: string | null) {
  if (!slug) return null;
  const result = await query<{ id: string }>("SELECT id FROM projects WHERE slug=$1 LIMIT 1", [slug]);
  return result.rows[0]?.id ?? null;
}

export async function upsertContact(input: {
  name?: string | null;
  email?: string | null;
  organization?: string | null;
  source: string;
  projectSlug?: string | null;
  lastContactAt?: string | null;
}) {
  const email = input.email?.trim().toLowerCase() || null;
  if (!email) return null;
  const projectId = await projectIdForSlug(input.projectSlug ?? null);
  const canonicalKey = `email:${email}`;
  const result = await query<{ id: string }>(
    `INSERT INTO contacts (canonical_key,name,email,organization,source,project_id,last_contact_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (canonical_key) DO UPDATE SET
       name=COALESCE(EXCLUDED.name,contacts.name), organization=COALESCE(EXCLUDED.organization,contacts.organization),
       source=EXCLUDED.source, project_id=COALESCE(EXCLUDED.project_id,contacts.project_id),
       last_contact_at=GREATEST(COALESCE(EXCLUDED.last_contact_at,contacts.last_contact_at),COALESCE(contacts.last_contact_at,EXCLUDED.last_contact_at)),
       updated_at=NOW()
     RETURNING id`,
    [canonicalKey, input.name ?? null, email, input.organization ?? null, input.source, projectId, input.lastContactAt ? new Date(input.lastContactAt) : null],
  );
  return result.rows[0]?.id ?? null;
}

async function externalRecordId(provider: string, recordType: string, externalId: string) {
  const result = await query<{ id: string }>(
    "SELECT id FROM external_records WHERE provider=$1 AND record_type=$2 AND external_id=$3 LIMIT 1",
    [provider, recordType, externalId],
  );
  return result.rows[0]?.id ?? null;
}

export async function upsertAttention(input: {
  provider: string;
  recordType: string;
  externalId: string;
  attentionType: string;
  priority: "high" | "normal";
  title: string;
  description?: string | null;
  dueAt?: string | null;
  projectSlug?: string | null;
  contactId?: string | null;
  category?: string;
}) {
  const recordId = await externalRecordId(input.provider, input.recordType, input.externalId);
  if (!recordId) return;
  const projectId = await projectIdForSlug(input.projectSlug ?? null);
  const result = await query<{ id: string }>(
    `INSERT INTO attention_items (external_record_id,source,attention_type,priority,title,description,status,due_at,project_id,contact_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,NOW())
     ON CONFLICT (external_record_id,attention_type) DO UPDATE SET
       priority=EXCLUDED.priority,title=EXCLUDED.title,description=EXCLUDED.description,
       due_at=EXCLUDED.due_at,project_id=EXCLUDED.project_id,contact_id=EXCLUDED.contact_id,updated_at=NOW()
     RETURNING id`,
    [recordId, input.provider, input.attentionType, input.priority, input.title, input.description ?? null, input.dueAt ? new Date(input.dueAt) : null, projectId, input.contactId ?? null],
  );
  const attentionItemId = result.rows[0]?.id;
  if (attentionItemId && input.provider === "google-gmail" && input.attentionType === "email_follow_up" && input.category) {
    await dispatchGmailAttention(attentionItemId, input.category);
  }
}

export async function enrichGmailRecord(input: {
  externalId: string;
  subject: string;
  snippet: string;
  from: string;
  occurredAt: string | null;
  unread: boolean;
}) {
  const parsed = parseEmailAddress(input.from);
  const classification = classifyEmail(input);
  const contactId = await upsertContact({ name: parsed.name, email: parsed.email, source: "google-gmail", projectSlug: classification.projectSlug, lastContactAt: input.occurredAt });
  if (classification.attention) {
    await upsertAttention({
      provider: "google-gmail",
      recordType: "email",
      externalId: input.externalId,
      attentionType: "email_follow_up",
      priority: classification.priority,
      title: input.subject || "Business email needs attention",
      description: `${classification.category} · ${parsed.email}`,
      dueAt: new Date().toISOString(),
      projectSlug: classification.projectSlug,
      contactId,
      category: classification.category,
    });
  }
  await query(
    `UPDATE external_records SET payload = payload || $2::jsonb WHERE provider='google-gmail' AND record_type='email' AND external_id=$1`,
    [input.externalId, JSON.stringify({ category: classification.category, business_relevant: classification.businessRelevant, attention: classification.attention })],
  );
  return classification;
}

export async function enrichCalendarRecord(input: {
  externalId: string;
  title: string;
  organizer: string | null;
  startAt: string | null;
  endAt: string | null;
  projectSlug: string | null;
}) {
  const start = input.startAt ? new Date(input.startAt) : null;
  const shouldAlert = Boolean(start && start.getTime() >= Date.now() && start.getTime() <= Date.now() + 48 * 60 * 60 * 1000);
  if (!shouldAlert) return;
  await upsertAttention({
    provider: "google-calendar",
    recordType: "calendar_event",
    externalId: input.externalId,
    attentionType: "meeting_upcoming",
    priority: /important|review|demo|client|sales|proposal/.test(input.title.toLowerCase()) ? "high" : "normal",
    title: `Upcoming: ${input.title}`,
    description: input.organizer ? `Organizer: ${input.organizer}` : "Upcoming calendar event",
    dueAt: input.startAt,
    projectSlug: input.projectSlug,
  });
}

export function inferProjectSlug(text: string) {
  const lower = text.toLowerCase();
  if (/sky mountain cloud|nextcloud|cloud storage|storage/.test(lower)) return "sky-mountain-cloud";
  if (/plenty of plants|nursery|plant game|firebase/.test(lower)) return "plenty-of-plants";
  if (/sky mountain graphics|graphic design|web design|wordpress|logo|branding/.test(lower)) return "sky-mountain-graphics";
  return null;
}
