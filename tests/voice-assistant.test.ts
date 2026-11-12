import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Voice assistant guards (Phase 1): the floating panel is a thin client
// over the existing owner-gated backends — /api/command for status and
// task creation, /api/ask (start + poll) for knowledge answers, and
// /api/approvals for approval decisions behind a strict explicit-phrase
// confirmation gate. It must never grow a backend of its own, write
// directly outside those endpoints, or hold a secret.

const read = (path: string) => readFileSync(path, "utf8");

test("the voice assistant component exists and is mounted in the root layout", () => {
  assert.ok(existsSync("components/VoiceAssistant.tsx"), "components/VoiceAssistant.tsx missing");
  const layout = read("app/layout.tsx");
  assert.match(layout, /import \{ VoiceAssistant \} from "@\/components\/VoiceAssistant"/, "layout must import VoiceAssistant");
  assert.match(layout, /<VoiceAssistant \/>/, "layout must render the voice assistant on every page");
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /pathname === "\/login"/, "assistant must stay off the sign-in page");
});

test("voice input uses SpeechRecognition with the webkit fallback and an unsupported guard", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /SpeechRecognition/, "component must use the SpeechRecognition API");
  assert.match(component, /webkitSpeechRecognition/, "component must fall back to the webkit-prefixed API");
  assert.match(component, /micSupported/, "component must track mic support so unsupported browsers hide the mic button");
  assert.match(component, /recognition\.lang = "en-US"/, "recognition must set a language");
  assert.match(component, /result\.isFinal/, "final transcripts must be detected so they auto-submit");
});

test("messages route to /api/command first and fall back to the /api/ask job flow", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /fetch\("\/api\/command"/, "component must post commands to /api/command");
  assert.match(component, /body: JSON\.stringify\(\{ command: text \}\)/, "component must send the command field the route expects");
  assert.match(component, /data\.route !== "help"/, "only an understood command route skips the Ask fallback");
  assert.match(component, /fetch\("\/api\/ask"/, "component must start an ask job on /api/ask when the router does not understand");
  assert.match(component, /body: JSON\.stringify\(\{ question: text \}\)/, "component must send the question field the ask route expects");
  assert.match(component, /`\/api\/ask\?jobId=\$\{encodeURIComponent\(jobId\)\}`/, "component must poll the ask job by id");
  assert.match(component, /data\.status === "done"/, "component must wait for the ask job to finish");
  assert.match(component, /Sources:/, "grounded answers must show their source names");
});

test("a created task is reported with the command route's own message", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /return \{ role: "assistant", text: data\.message \}/, "task replies must use the route's returned message verbatim");
});

test("spoken replies use speechSynthesis behind a toggle and are cancelled on send", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /speechSynthesis/, "component must speak replies with speechSynthesis");
  assert.match(component, /SpeechSynthesisUtterance/, "component must build utterances for replies");
  assert.match(component, /aria-pressed=\{voiceOn\}/, "the speaker toggle must expose its state");
  assert.match(component, /toggleVoice/, "component must offer a mute toggle for spoken replies");
});

test("the panel never writes directly and holds no secrets or browser storage", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.doesNotMatch(component, /lib\/db|from "pg"|INSERT INTO|UPDATE .* SET|DELETE FROM/, "component must not touch the database directly");
  assert.doesNotMatch(component, /process\.env|_TOKEN|_SECRET|api[_-]?key/i, "component must not reference secrets or env values");
  assert.doesNotMatch(component, /localStorage|sessionStorage/, "component must not persist anything in browser storage");
  assert.doesNotMatch(component, /method: "(PUT|DELETE)"/, "the only decision call allowed is the approvals PATCH below");
});

test("approvals are read and decided through the existing /api/approvals endpoint", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /fetch\("\/api\/approvals", \{ headers: authHeaders\(\), cache: "no-store" \}\)/, "pending approvals must be fetched fresh from /api/approvals");
  assert.match(component, /fetch\("\/api\/approvals", \{\s*method: "PATCH"/, "decisions must go through the approvals endpoint's PATCH, like the Approvals UI");
  assert.match(component, /body: JSON\.stringify\(\{ id: armed\.approval\.id, status: armed\.decision \}\)/, "the decision body must be the id + status the route expects");
  assert.match(component, /isApprovalListRequest/, "asking what is waiting must take the approvals read path");
  assert.match(component, /item\.status === "pending"/, "only pending approvals may be listed or decided");
});

test("the confirmation gate: explicit phrases only, decided before any approvals PATCH", () => {
  const component = read("components/VoiceAssistant.tsx");

  // The phrase sets contain only explicit confirmations — never a bare
  // "yes", "yeah", or "ok".
  for (const name of ["APPROVE_CONFIRMATIONS", "REJECT_CONFIRMATIONS"]) {
    const declaration = component.match(new RegExp(`${name} = new Set\\(\\[([^\\]]*)\\]\\)`))?.[1] ?? "";
    assert.ok(declaration.length > 0, `${name} must be declared`);
    const entries = [...declaration.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    assert.ok(entries.length >= 3, `${name} must list the explicit confirmation phrases`);
    assert.ok(entries.every((entry) => entry !== "yes" && entry !== "yeah" && entry !== "ok" && entry !== "uh-huh"), `${name} must never contain a bare affirmation`);
    assert.ok(entries.some((entry) => entry.includes("approve") || entry.includes("reject")), `${name} entries must name the decision`);
  }
  assert.match(component, /APPROVE_CONFIRMATIONS = new Set\(\["yes approve it"/, "the approve set must include 'yes approve it'");
  assert.match(component, /REJECT_CONFIRMATIONS = new Set\(\["yes reject it"/, "the reject set must include 'yes reject it'");

  // The gate is consulted before the decision call exists in the flow:
  // the phrase check appears in the file ahead of the PATCH, and the
  // armed confirmation state is what routes a reply into the handler.
  assert.match(component, /confirmation \? await handleConfirmationReply\(text\) : await routeMessage\(text\)/, "an armed confirmation must consume the next reply before any routing");
  assert.match(component, /phrases\.has\(phrase\)/, "the handler must require the reply to be an explicit confirmation phrase");
  assert.ok(
    component.indexOf("phrases.has(phrase)") < component.indexOf('method: "PATCH"'),
    "the explicit-phrase check must come before the approvals PATCH in the handler",
  );
  assert.match(component, /setConfirmation\(\{ approval: target, decision \}\)/, "a decision request must only arm the confirmation, never decide directly");
});

test("an unconfirmed reply cancels the armed confirmation and decides nothing", () => {
  const component = read("components/VoiceAssistant.tsx");
  assert.match(component, /setConfirmation\(null\)/, "the handler must clear the armed confirmation on any reply");
  assert.match(component, /Cancelled — nothing was decided/, "cancelling must be reported to the owner in the panel (and spoken)");
  assert.match(component, /voice-confirm/, "the panel must visibly show the armed confirmation while it waits");
});

test("the floating launcher and panel styles live in globals.css", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.voice-launcher \{[^}]*position: fixed/, "launcher must float in the corner");
  assert.match(css, /\.voice-panel \{[^}]*position: fixed/, "panel must float above the page");
  assert.match(css, /\.voice-mic\.listening/, "the mic needs a visible listening state");
});
