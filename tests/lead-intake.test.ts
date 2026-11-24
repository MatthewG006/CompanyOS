import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bodyIntakeSecret,
  buildLeadNotes,
  buildOpportunityTitle,
  GRAPHICS_PROJECT_SLUG,
  INTAKE_SECRET_FIELD,
  INTAKE_SECRET_PARAM,
  intakeAuthStatus,
  parseLeadIntake,
  queryIntakeSecret,
} from "../lib/sales/intake.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("intake validation accepts a full website submission and normalizes it", () => {
  const parsed = parseLeadIntake({
    name: "  Ada Lovelace ",
    email: "ADA@Example.COM",
    phone: " (305) 555-0100 ",
    service: "Web design",
    message: "We need a new site.",
    extra: "ignored",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.lead.name, "Ada Lovelace");
  assert.equal(parsed.lead.email, "ada@example.com");
  assert.equal(parsed.lead.phone, "(305) 555-0100");
  assert.equal(parsed.lead.service, "Web design");
  assert.equal(parsed.lead.source, "website", "source defaults to 'website'");
});

test("intake validation accepts phone-only and email-only contact details", () => {
  assert.equal(parseLeadIntake({ name: "Sam", phone: "3055550100" }).ok, true);
  assert.equal(parseLeadIntake({ name: "Sam", email: "sam@example.com" }).ok, true);
  const custom = parseLeadIntake({ name: "Sam", email: "sam@example.com", source: "hoa-landing" });
  assert.equal(custom.ok, true);
  if (custom.ok) assert.equal(custom.lead.source, "hoa-landing");
});

test("intake validation rejects a missing name and missing contact details", () => {
  assert.equal(parseLeadIntake({ email: "ada@example.com" }).ok, false);
  assert.equal(parseLeadIntake({ name: "   ", phone: "3055550100" }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada" }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada", email: "", phone: " " }).ok, false);
});

test("intake validation rejects malformed email and overlong fields", () => {
  assert.equal(parseLeadIntake({ name: "Ada", email: "not-an-email" }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada", email: "ada@localhost" }).ok, false);
  assert.equal(parseLeadIntake({ name: "A".repeat(161), email: "ada@example.com" }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada", phone: "1".repeat(33) }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada", email: "ada@example.com", service: "s".repeat(121) }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada", email: "ada@example.com", message: "m".repeat(2001) }).ok, false);
  assert.equal(parseLeadIntake({ name: "Ada", email: "ada@example.com", source: "s".repeat(61) }).ok, false);
});

test("intake validation accepts the form labels AFI sends, in any capitalization", () => {
  const parsed = parseLeadIntake({ Name: "Ada Lovelace", Email: "ADA@Example.COM", Message: "Hello there." });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.lead.name, "Ada Lovelace");
  assert.equal(parsed.lead.email, "ada@example.com");
  assert.equal(parsed.lead.message, "Hello there.");
});

test("intake validation accepts common field aliases", () => {
  const parsed = parseLeadIntake({
    full_name: "Sam Reyes",
    email_address: "sam@example.com",
    your_message: "Please send a quote.",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.lead.name, "Sam Reyes");
  assert.equal(parsed.lead.email, "sam@example.com");
  assert.equal(parsed.lead.message, "Please send a quote.");
  // The canonical key still wins over an alias when both are present.
  const both = parseLeadIntake({ name: "Canonical", full_name: "Alias", email: "ada@example.com" });
  assert.equal(both.ok, true);
  if (both.ok) assert.equal(both.lead.name, "Canonical");
});

test("intake validation rejects non-object bodies", () => {
  assert.equal(parseLeadIntake(null).ok, false);
  assert.equal(parseLeadIntake("name").ok, false);
  assert.equal(parseLeadIntake([{ name: "Ada", email: "ada@example.com" }]).ok, false);
});

test("opportunity titles name the service when one is given", () => {
  assert.equal(buildOpportunityTitle("Web design"), "Website enquiry — Web design");
  assert.equal(buildOpportunityTitle("  HOA website  "), "Website enquiry — HOA website");
  assert.equal(buildOpportunityTitle(""), "Website enquiry");
  assert.equal(buildOpportunityTitle("   "), "Website enquiry");
  assert.ok(buildOpportunityTitle("s".repeat(300)).length <= 180);
});

test("lead notes carry the message, contact details and source", () => {
  const parsed = parseLeadIntake({
    name: "Ada",
    email: "ada@example.com",
    phone: "3055550100",
    service: "Web design",
    message: "Please call me back.",
    source: "hoa-landing",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const notes = buildLeadNotes(parsed.lead);
  assert.match(notes, /hoa-landing/);
  assert.match(notes, /ada@example\.com/);
  assert.match(notes, /3055550100/);
  assert.match(notes, /Web design/);
  assert.match(notes, /Please call me back\./);
});

test("intake auth refuses everything when the secret is not configured", () => {
  assert.equal(intakeAuthStatus("anything", undefined), "unconfigured");
  assert.equal(intakeAuthStatus("anything", ""), "unconfigured");
  assert.equal(intakeAuthStatus(null, undefined), "unconfigured");
});

test("intake auth accepts only the exact secret", () => {
  assert.equal(intakeAuthStatus("s3cret-value", "s3cret-value"), "ok");
  assert.equal(intakeAuthStatus("wrong-value", "s3cret-value"), "unauthorized");
  assert.equal(intakeAuthStatus("s3cret-valu", "s3cret-value"), "unauthorized");
  assert.equal(intakeAuthStatus("s3cret-value ", "s3cret-value"), "unauthorized");
  assert.equal(intakeAuthStatus(null, "s3cret-value"), "unauthorized");
  assert.equal(intakeAuthStatus("", "s3cret-value"), "unauthorized");
});

test("the body secret field carries the shared secret when no header can be set", () => {
  assert.equal(INTAKE_SECRET_FIELD, "secret");
  assert.equal(bodyIntakeSecret({ secret: "s3cret-value", name: "Ada" }), "s3cret-value");
  assert.equal(bodyIntakeSecret({ name: "Ada" }), null);
  assert.equal(bodyIntakeSecret({ secret: "" }), null);
  assert.equal(bodyIntakeSecret({ secret: 42 }), null);
  assert.equal(bodyIntakeSecret({ secret: ["s3cret-value"] }), null);
  assert.equal(bodyIntakeSecret(null), null);
  assert.equal(bodyIntakeSecret("secret"), null);
  assert.equal(bodyIntakeSecret([{ secret: "s3cret-value" }]), null);
  // A body secret authenticates exactly like the header value.
  assert.equal(intakeAuthStatus(bodyIntakeSecret({ secret: "s3cret-value" }), "s3cret-value"), "ok");
  assert.equal(intakeAuthStatus(bodyIntakeSecret({ secret: "wrong" }), "s3cret-value"), "unauthorized");
  // The secret field is not a lead field: validation ignores it.
  assert.equal(parseLeadIntake({ name: "Ada", email: "ada@example.com", secret: "s3cret-value" }).ok, true);
});

test("the URL key parameter carries the shared secret when neither header nor field can be set", () => {
  assert.equal(INTAKE_SECRET_PARAM, "key");
  assert.equal(queryIntakeSecret("https://example.com/api/leads/intake?key=s3cret-value"), "s3cret-value");
  assert.equal(queryIntakeSecret("https://example.com/api/leads/intake?other=1&key=s3cret-value"), "s3cret-value");
  assert.equal(queryIntakeSecret("https://example.com/api/leads/intake"), null);
  assert.equal(queryIntakeSecret("https://example.com/api/leads/intake?key="), null);
  assert.equal(queryIntakeSecret("not a url"), null);
  // A URL key authenticates exactly like the header value.
  assert.equal(
    intakeAuthStatus(queryIntakeSecret("https://example.com/api/leads/intake?key=s3cret-value"), "s3cret-value"),
    "ok",
  );
  assert.equal(
    intakeAuthStatus(queryIntakeSecret("https://example.com/api/leads/intake?key=wrong"), "s3cret-value"),
    "unauthorized",
  );
});

test("the intake route enforces the secret before touching the database", () => {
  const route = read("../app/api/leads/intake/route.ts");
  assert.match(route, /LEAD_INTAKE_SECRET/);
  assert.match(route, /request\.headers\.get\(INTAKE_SECRET_HEADER\) \?\? bodyIntakeSecret\(body\) \?\? queryIntakeSecret\(request\.url\)/);
  assert.match(route, /auth === "unconfigured"\) return apiError\("Lead intake is not configured\.", 503\)/);
  assert.match(route, /auth === "unauthorized"\) return NextResponse\.json\(\{ error: "Unauthorized\." \}, \{ status: 401 \}\)/);
  assert.ok(
    route.indexOf("intakeAuthStatus") < route.indexOf("databaseAvailable()"),
    "the secret check must run before the database availability check",
  );
  assert.ok(!/console\.(log|info|warn|error)\([^)]*SECRET/.test(route), "the secret must never be logged");
});

test("the intake route files the lead under Sky Mountain Graphics as a new lead with an attention item", () => {
  const route = read("../app/api/leads/intake/route.ts");
  assert.equal(GRAPHICS_PROJECT_SLUG, "sky-mountain-graphics");
  assert.match(route, /SELECT id FROM projects WHERE slug=\$1 LIMIT 1/);
  assert.match(route, /INSERT INTO contacts/);
  assert.match(route, /'website-form'/);
  assert.match(route, /INSERT INTO sales_leads/);
  assert.match(route, /'new'/);
  assert.match(route, /source_attention_item_id/);
  assert.match(route, /INSERT INTO attention_items/);
  assert.match(route, /'new_website_lead'/);
  assert.match(route, /New website lead:/);
  assert.match(route, /INSERT INTO events/);
  assert.match(route, /'sales_lead_created'/);
});

test("the proxy allowlists the intake path so the WordPress webhook can reach it", () => {
  const proxy = read("../proxy.ts");
  assert.match(proxy, /"\/api\/leads\/intake"/);
  assert.match(proxy, /"\/api\/events\/ingest"/, "the existing signed ingest path stays public");
});
