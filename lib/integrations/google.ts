import { query } from "../db";
import { enrichCalendarRecord, enrichGmailRecord, inferProjectSlug } from "../intelligence";
import { decryptSecret, encryptSecret } from "../secrets";
import { fetchJson } from "./http";
import { upsertExternalRecord } from "./records";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

type GoogleToken = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
};

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
};

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_URL && process.env.COMPANYOS_ENCRYPTION_KEY);
}

export function googleRedirectUri() {
  return `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/integrations/google/callback`;
}

export function buildGoogleAuthorizationUrl(state: string) {
  if (!process.env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID is not configured.");
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth credentials are not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Google token exchange failed: ${await response.text()}`);
  return response.json() as Promise<GoogleTokenResponse>;
}

async function saveSecret(value: GoogleToken) {
  const encrypted = encryptSecret(value);
  await query(`INSERT INTO integration_secrets (name,provider,encrypted_value)
    VALUES ('google-oauth','google',$1)
    ON CONFLICT (name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=NOW()`, [encrypted]);
}

export async function saveGoogleToken(token: GoogleTokenResponse) {
  const existing = await getStoredGoogleToken().catch(() => null);
  await saveSecret({
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? existing?.refresh_token,
    expires_at: Date.now() + Math.max(30, token.expires_in - 60) * 1000,
    token_type: token.token_type,
    scope: token.scope ?? existing?.scope,
  });
}

async function getStoredGoogleToken() {
  const result = await query<{ encrypted_value: string }>("SELECT encrypted_value FROM integration_secrets WHERE name='google-oauth' LIMIT 1");
  if (!result.rowCount) return null;
  return decryptSecret<GoogleToken>(result.rows[0].encrypted_value);
}

export async function getGoogleToken() {
  const stored = await getStoredGoogleToken();
  if (!stored) throw new Error("Google is not connected to local CompanyOS. Connect Google first.");
  if (stored.expires_at > Date.now() + 30_000) return stored.access_token;
  if (!stored.refresh_token) throw new Error("Google access token expired and no refresh token is stored.");
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth credentials are not configured.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Google token refresh failed: ${await response.text()}`);
  const refreshed = await response.json() as GoogleTokenResponse;
  await saveSecret({
    access_token: refreshed.access_token,
    refresh_token: stored.refresh_token,
    expires_at: Date.now() + Math.max(30, refreshed.expires_in - 60) * 1000,
    token_type: refreshed.token_type,
    scope: refreshed.scope ?? stored.scope,
  });
  return refreshed.access_token;
}

export async function googleEmailSendReady() {
  const stored = await getStoredGoogleToken().catch(() => null);
  return Boolean(stored?.scope?.split(/\s+/).includes("https://www.googleapis.com/auth/gmail.send"));
}

export async function sendGoogleEmail(input: { idempotencyId: string; to: string; subject: string; body: string }) {
  const stored = await getStoredGoogleToken().catch(() => null);
  if (!stored?.scope?.split(/\s+/).includes("https://www.googleapis.com/auth/gmail.send")) {
    throw new Error("Reconnect Google from Communications to grant the Gmail send permission before approving outbound email.");
  }
  const accessToken = await getGoogleToken();
  const host = new URL(process.env.APP_URL ?? "http://localhost:3000").hostname;
  const messageId = `<${input.idempotencyId}@${host}>`;
  const lookup = new URLSearchParams({ q: `in:sent rfc822msgid:${input.idempotencyId}@${host}`, maxResults: "1" });
  const existingResponse = await fetchJson<{ messages?: Array<{ id: string; threadId: string }> }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${lookup.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (existingResponse.messages?.[0]) return { ...existingResponse.messages[0], alreadySent: true };
  const safeSubject = input.subject.replace(/[\r\n]+/g, " ").trim();
  const rawMessage = [
    `To: ${input.to}`,
    `Subject: ${safeSubject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd(),
  ].join("\r\n");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(rawMessage, "utf8").toString("base64url") }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Gmail send failed with HTTP ${response.status}.`);
  const sent = await response.json() as { id: string; threadId: string };
  return { ...sent, alreadySent: false };
}

export async function fetchGoogleUserInfo(accessToken: string) {
  return fetchJson<{ email?: string; name?: string }>("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

type GmailList = { messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; resultSizeEstimate?: number };
type GmailMessage = { id: string; threadId: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } };
type CalendarList = {
  items?: Array<{
    id: string;
    summary?: string;
    description?: string;
    htmlLink?: string;
    status?: string;
    location?: string;
    start?: {
      dateTime?: string;
      date?: string;
    };
    end?: {
      dateTime?: string;
      date?: string;
    };
    organizer?: {
      email?: string;
    };
    updated?: string;
  }>;
  nextPageToken?: string;
};

function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function recordIntegrationEvent(source: string, eventType: string, title: string, externalId: string, occurredAt: string | null, payload: unknown) {
  const idempotencyKey = `${source}:${eventType}:${externalId}`;
  await query(`INSERT INTO events (source,event_type,title,severity,payload,idempotency_key,created_at)
    VALUES ($1,$2,$3,'info',$4::jsonb,$5,COALESCE($6,NOW()))
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`, [source, eventType, title, JSON.stringify(payload), idempotencyKey, occurredAt ? new Date(occurredAt) : null]);
}

export async function syncGmail() {
  const accessToken = await getGoogleToken();
  const pageSize = Math.min(500, Math.max(1, Number(process.env.GOOGLE_GMAIL_PAGE_SIZE ?? 100)));
  const maxPages = Math.min(20, Math.max(1, Number(process.env.GOOGLE_GMAIL_MAX_PAGES ?? 5)));
  const queryText = process.env.GOOGLE_GMAIL_QUERY ?? "newer_than:30d";
  const headers = { Authorization: `Bearer ${accessToken}` };
  let pageToken: string | undefined;
  let seen = 0;
  let written = 0;
  let pages = 0;

  do {
    const params = new URLSearchParams({ maxResults: String(pageSize), q: queryText });
    if (pageToken) params.set("pageToken", pageToken);
    const list = await fetchJson<GmailList>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, { headers });
    pages += 1;

    for (const item of list.messages ?? []) {
      const message = await fetchJson<GmailMessage>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers },
      );
      const subject = header(message, "Subject") ?? "(No subject)";
      const from = header(message, "From") ?? "Unknown sender";
      const occurredAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
      const unread = message.labelIds?.includes("UNREAD") ?? false;
      const payload = { from, date: header(message, "Date"), subject, snippet: message.snippet ?? "", thread_id: message.threadId, labels: message.labelIds ?? [], unread };
      written += await upsertExternalRecord({
        provider: "google-gmail",
        record_type: "email",
        external_id: message.id,
        title: subject,
        url: `https://mail.google.com/mail/u/0/#inbox/${message.threadId}`,
        status: "received",
        owner: from,
        occurred_at: occurredAt,
        payload,
      });
      await recordIntegrationEvent("google-gmail", "email_received", `${subject} — ${from}`, message.id, occurredAt, payload);
      const sender = from.match(/<([^>]+)>/)?.[1] ?? from;
      const optedOut = /\b(unsubscribe|stop emailing|remove me|opt[\s-]?out)\b/i.test(message.snippet ?? "");
      if (optedOut) {
        const sentThread = await query<{ contact_id: string }>(
          `SELECT om.contact_id FROM outbound_messages om JOIN contacts c ON c.id=om.contact_id
           WHERE om.channel='email' AND om.status='sent' AND om.provider_thread_id=$1 AND LOWER(c.email)=LOWER($2) LIMIT 1`,
          [message.threadId, sender],
        );
        const contactId = sentThread.rows[0]?.contact_id;
        if (contactId) {
          await query(`INSERT INTO contact_channel_preferences (contact_id,channel,status,evidence,updated_at)
            VALUES ($1,'email','opted_out','Opt-out detected in Gmail reply',$2)
            ON CONFLICT (contact_id,channel) DO UPDATE SET status='opted_out',evidence=EXCLUDED.evidence,updated_at=EXCLUDED.updated_at`,
            [contactId, occurredAt ? new Date(occurredAt) : new Date()]);
          await query(`INSERT INTO events (source,event_type,title,severity,payload) VALUES ('communications','email_opt_out_received','Email opt-out detected','warning',$1::jsonb)`, [JSON.stringify({ contact_id: contactId, gmail_message_id: message.id })]);
        }
      }
      await enrichGmailRecord({ externalId: message.id, subject, snippet: message.snippet ?? "", from, occurredAt, unread });
      seen += 1;
    }

    pageToken = list.nextPageToken;
  } while (pageToken && pages < maxPages);

  return { seen, written };
}

export async function syncCalendar() {
  const accessToken = await getGoogleToken();
  const daysPast = Math.max(0, Number(process.env.GOOGLE_CALENDAR_DAYS_PAST ?? 7));
  const daysFuture = Math.max(1, Number(process.env.GOOGLE_CALENDAR_DAYS_FUTURE ?? 45));
  const pageSize = Math.min(2500, Math.max(1, Number(process.env.GOOGLE_CALENDAR_PAGE_SIZE ?? 250)));
  const maxPages = Math.min(20, Math.max(1, Number(process.env.GOOGLE_CALENDAR_MAX_PAGES ?? 10)));
  const start = new Date(Date.now() - daysPast * 86400000).toISOString();
  const end = new Date(Date.now() + daysFuture * 86400000).toISOString();
  const headers = { Authorization: `Bearer ${accessToken}` };
  let pageToken: string | undefined;
  let seen = 0;
  let written = 0;
  let pages = 0;

  do {
    const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: start, timeMax: end, maxResults: String(pageSize) });
    if (pageToken) params.set("pageToken", pageToken);
    const calendar = await fetchJson<CalendarList>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, { headers });
    pages += 1;

    for (const event of calendar.items ?? []) {
      const occurredAt = event.start?.dateTime ?? event.start?.date ?? event.updated ?? null;
      const payload = { start: event.start, end: event.end, description: event.description ?? "", organizer: event.organizer?.email ?? null, location: event.location ?? null };
      written += await upsertExternalRecord({
        provider: "google-calendar",
        record_type: "calendar_event",
        external_id: event.id,
        title: event.summary ?? "(Untitled event)",
        url: event.htmlLink ?? null,
        status: event.status ?? "confirmed",
        owner: event.organizer?.email ?? null,
        occurred_at: occurredAt,
        payload,
      });
      await recordIntegrationEvent("google-calendar", "calendar_event_synced", event.summary ?? "(Untitled event)", event.id, occurredAt, payload);
      const projectSlug = inferProjectSlug(event.summary ?? "");
      const project = projectSlug ? await query<{ id: string }>("SELECT id FROM projects WHERE slug=$1 LIMIT 1", [projectSlug]) : { rows: [] };
      await query(`INSERT INTO meetings (provider,external_id,title,url,status,organizer,start_at,end_at,location,project_id,payload,last_seen_at)
        VALUES ('google-calendar',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
        ON CONFLICT (provider,external_id) DO UPDATE SET title=EXCLUDED.title,url=EXCLUDED.url,status=EXCLUDED.status,organizer=EXCLUDED.organizer,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,location=EXCLUDED.location,project_id=EXCLUDED.project_id,payload=EXCLUDED.payload,last_seen_at=NOW()`,
        [
  event.id,
  event.summary ?? "(Untitled event)",
  event.htmlLink ?? null,
  event.status ?? "confirmed",
  event.organizer?.email ?? null,
  event.start?.dateTime ?? event.start?.date ?? null,
  event.end?.dateTime ?? event.end?.date ?? null,
  event.location ?? null,
  project.rows[0]?.id ?? null,
  JSON.stringify(payload)
]);
      await enrichCalendarRecord({ externalId: event.id, title: event.summary ?? "(Untitled event)", organizer: event.organizer?.email ?? null, startAt: occurredAt, endAt: event.end?.dateTime ?? event.end?.date ?? null, projectSlug });
      seen += 1;
    }

    pageToken = calendar.nextPageToken;
  } while (pageToken && pages < maxPages);

  return { seen, written };
}
