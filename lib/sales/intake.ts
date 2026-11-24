import { timingSafeEqual } from "node:crypto";

/**
 * Website lead intake: the pure half of POST /api/leads/intake.
 *
 * The public Sky Mountain Graphics site (WordPress + Hash Form) forwards
 * each form submission to CompanyOS through the Advanced Form Integration
 * plugin. These helpers validate and shape that payload and check the
 * shared secret, so the route handler itself only does database work.
 * Nothing here logs or returns the secret.
 */

export const GRAPHICS_PROJECT_SLUG = "sky-mountain-graphics";
export const INTAKE_SECRET_HEADER = "x-intake-secret";
export const INTAKE_SECRET_FIELD = "secret";
export const INTAKE_SECRET_PARAM = "key";
export const DEFAULT_INTAKE_SOURCE = "website";

const NAME_MAX = 160;
const EMAIL_MAX = 254;
const PHONE_MAX = 32;
const SERVICE_MAX = 120;
const MESSAGE_MAX = 2000;
const SOURCE_MAX = 60;
const TITLE_MAX = 180;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LeadIntake = {
  name: string;
  email: string;
  phone: string;
  service: string;
  message: string;
  source: string;
};

export type LeadIntakeParse = { ok: true; lead: LeadIntake } | { ok: false; error: string };

function boundedField(body: Record<string, unknown>, key: string) {
  return typeof body[key] === "string" ? (body[key] as string).trim() : "";
}

/** Validate and normalize a raw intake body. Unknown fields are ignored. */
export function parseLeadIntake(body: unknown): LeadIntakeParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  const name = boundedField(record, "name");
  const email = boundedField(record, "email").toLowerCase();
  const phone = boundedField(record, "phone");
  const service = boundedField(record, "service");
  const message = boundedField(record, "message");
  const source = boundedField(record, "source") || DEFAULT_INTAKE_SOURCE;

  if (!name) return { ok: false, error: "A contact name is required." };
  if (name.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer.` };
  if (!email && !phone) return { ok: false, error: "An email address or phone number is required." };
  if (email && (email.length > EMAIL_MAX || !emailPattern.test(email))) {
    return { ok: false, error: "Enter a valid email address or leave it blank." };
  }
  if (phone.length > PHONE_MAX) return { ok: false, error: `Phone number must be ${PHONE_MAX} characters or fewer.` };
  if (service.length > SERVICE_MAX) return { ok: false, error: `Service must be ${SERVICE_MAX} characters or fewer.` };
  if (message.length > MESSAGE_MAX) return { ok: false, error: `Message must be ${MESSAGE_MAX} characters or fewer.` };
  if (source.length > SOURCE_MAX) return { ok: false, error: `Source must be ${SOURCE_MAX} characters or fewer.` };

  return { ok: true, lead: { name, email, phone, service, message, source } };
}

/** The pipeline title for a website enquiry, e.g. "Website enquiry — Web design". */
export function buildOpportunityTitle(service: string) {
  const trimmed = service.trim();
  if (!trimmed) return "Website enquiry";
  return `Website enquiry — ${trimmed}`.slice(0, TITLE_MAX);
}

/** The lead's notes: the visitor's message plus how to reach them and where they came from. */
export function buildLeadNotes(lead: LeadIntake) {
  const lines = [`Source: website contact form (${lead.source})`];
  if (lead.email) lines.push(`Email: ${lead.email}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.service) lines.push(`Service: ${lead.service}`);
  if (lead.message) lines.push("", lead.message);
  return lines.join("\n").slice(0, 4000);
}

/**
 * The shared secret may also arrive as a `secret` field in the JSON body:
 * the free Advanced Form Integration plugin cannot set custom headers, so
 * it maps the secret into the payload instead. The header wins when both
 * are sent. Returns null when no usable body secret is present.
 */
export function bodyIntakeSecret(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[INTAKE_SECRET_FIELD];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The shared secret may also arrive as a `key` query parameter on the
 * intake URL: the free Advanced Form Integration webhook cannot add
 * custom fields or headers at all, but the destination URL is always
 * editable, so the secret rides in the URL the plugin posts to (the
 * Zapier-hook pattern). Header and body field win when both are sent.
 */
export function queryIntakeSecret(url: string): string | null {
  try {
    const value = new URL(url).searchParams.get(INTAKE_SECRET_PARAM);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export type IntakeAuthStatus = "unconfigured" | "unauthorized" | "ok";

/**
 * Compare the caller-provided secret with the configured one in constant
 * time. An unset/empty configured secret means the endpoint is not
 * configured at all and must refuse every call.
 */
export function intakeAuthStatus(provided: string | null, expected: string | undefined): IntakeAuthStatus {
  if (!expected) return "unconfigured";
  if (!provided) return "unauthorized";
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return "unauthorized";
  return timingSafeEqual(providedBuffer, expectedBuffer) ? "ok" : "unauthorized";
}
