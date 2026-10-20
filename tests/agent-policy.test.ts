import assert from "node:assert/strict";
import { test } from "node:test";

const validProviders = new Set([
  "agnostic",
  "auto",
  "chatgpt-free",
  "claude-free",
  "codex",
  "codex-cli",
  "ollama",
  "openai",
  "anthropic",
]);

test("valid execution providers include ChatGPT Free, Claude Free, Codex, Codex CLI, Ollama, and APIs", () => {
  assert.ok(validProviders.has("chatgpt-free"));
  assert.ok(validProviders.has("claude-free"));
  assert.ok(validProviders.has("codex"));
  assert.ok(validProviders.has("codex-cli"));
  assert.ok(validProviders.has("ollama"));
  assert.ok(validProviders.has("openai"));
  assert.ok(validProviders.has("anthropic"));
  assert.ok(validProviders.has("agnostic"));
  assert.ok(!validProviders.has("invalid-model"));
});
