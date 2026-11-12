import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createWordPressClient,
  type WordPressCredentials,
} from "../lib/integrations/wordpress-client.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const credentials: WordPressCredentials = {
  url: "https://www.example-site.com/",
  username: "companyos",
  application_password: "aaaa bbbb cccc dddd",
};
const expectedAuth = `Basic ${Buffer.from("companyos:aaaa bbbb cccc dddd").toString("base64")}`;

type MockReply = { status?: number; body?: unknown };
type RecordedCall = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => MockReply) {
  const calls: RecordedCall[] = [];
  const fn = async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = handler(url, init);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

test("byte upload posts the image binary to the media library, then sets title and alt text", async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const { fetchFn, calls } = mockFetch((url, init) => {
    if (init.method === "POST" && url.endsWith("/wp-json/wp/v2/media")) {
      return { body: { id: 77, slug: "generated-1", link: "https://www.example-site.com/generated-1/", source_url: "https://www.example-site.com/wp-content/uploads/generated-1.png", title: { rendered: "generated-1" }, mime_type: "image/png" } };
    }
    return { body: { id: 77, slug: "generated-1", link: "https://www.example-site.com/generated-1/", source_url: "https://www.example-site.com/wp-content/uploads/generated-1.png", title: { rendered: "Launch post hero" }, mime_type: "image/png" } };
  });
  const media = await createWordPressClient(credentials, fetchFn).uploadMediaBytes({
    bytes: pngBytes,
    filename: "generated-1.png",
    contentType: "image/png",
    title: "Launch post hero",
    altText: "Sunrise over the ridge",
  });
  assert.equal(media.id, 77);
  assert.equal(media.sourceUrl, "https://www.example-site.com/wp-content/uploads/generated-1.png");
  assert.equal(calls.length, 2, "binary POST plus one metadata update");
  assert.equal(headersOf(calls[0]).Authorization, expectedAuth);
  assert.equal(headersOf(calls[0])["Content-Type"], "image/png");
  assert.equal(headersOf(calls[0])["Content-Disposition"], 'attachment; filename="generated-1.png"');
  assert.deepEqual([...(calls[0].init.body as Uint8Array)], [...pngBytes], "the exact bytes must be the request body");
  assert.equal(calls[1].url, "https://www.example-site.com/wp-json/wp/v2/media/77");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { title: "Launch post hero", alt_text: "Sunrise over the ridge" });
});

test("byte upload rejects empty payloads and filenames without an extension", async () => {
  const { fetchFn, calls } = mockFetch(() => ({ body: {} }));
  const client = createWordPressClient(credentials, fetchFn);
  await assert.rejects(() => client.uploadMediaBytes({ bytes: new Uint8Array(0), filename: "x.png", contentType: "image/png" }), /empty/);
  await assert.rejects(() => client.uploadMediaBytes({ bytes: new Uint8Array([1]), filename: "noextension", contentType: "image/png" }), /extension/);
  assert.equal(calls.length, 0, "rejected uploads must never reach WordPress");
});

test("the generate_image tool is registered under request_image_generation and queues worker execution", () => {
  const registry = read("../lib/ai/tool-registry.ts");
  assert.match(
    registry,
    /generateImageTool: AgentTool = \{\s+actionType: "generate_image",\s+permission: "request_image_generation"/,
  );
  assert.match(registry, /\[generateImageTool\.actionType, generateImageTool\]/);
  // Execution is a queued worker run, never a server-side generation.
  assert.match(registry, /queueTaskExecution\(client, \{/);
  assert.match(registry, /source: "owner_approved_image_generation"/);
  assert.match(registry, /image_generation: \{\s+prompt: generationPrompt,/);
  assert.match(registry, /'images','image_generation_queued'/);
  // A named content item is re-validated against the project at execution.
  assert.match(registry, /SELECT 1 FROM content_items WHERE id=\$1 AND project_id=\$2/);
  // Count is bounded 1-4 and defaults to 3 in both parse and execute.
  assert.equal((registry.match(/boundedInt\((?:value|payload)\.count, 1, 4\) \?\? 3/g) ?? []).length, 2);
});

test("every agent is offered generate_image in the router, with the approval story spelled out", () => {
  const router = read("../lib/ai/router.ts");
  assert.match(
    router,
    /includes\("request_image_generation"\) \? \["generate_image"\]/,
    "no role gate: all eleven agents may propose image generation",
  );
  assert.match(router, /"type":"generate_image"/, "the JSON contract must include the new proposal type");
  assert.match(router, /For generate_image:/, "missing usage guidance for the new tool");
  assert.match(router, /owner approves the exact prompt before anything is generated/);
  assert.match(router, /imagegen CLI \(GPT Image\)/, "the router must describe the real generation path, not a model tool");
});

test("proposal recording adds no role restriction for generate_image beyond the permission", () => {
  const actions = read("../lib/ai/actions.ts");
  assert.match(actions, /run\.allowed_actions\.includes\(tool\.permission\)/, "the generic permission gate is the enforcement");
  assert.doesNotMatch(actions, /actionType === "generate_image" &&/, "generate_image must not gain a DevOps-style name restriction");
});

test("the permission grant is universal in schema, seed, and the agents API allow-list", () => {
  const schema = read("../db/schema.sql");
  assert.match(
    schema,
    /UPDATE agents SET allowed_actions=COALESCE\(allowed_actions,'\[\]'::jsonb\) \|\| '\["request_image_generation"\]'::jsonb\s+WHERE NOT \(COALESCE\(allowed_actions,'\[\]'::jsonb\) \? 'request_image_generation'\);/,
    "the schema auto-grant must add the permission to every existing agent row",
  );
  const seed = read("../scripts/seed.mjs");
  assert.match(seed, /"request_image_generation",/, "the seed grants it in the universal base list");
  const agentsRoute = read("../app/api/agents/route.ts");
  assert.match(agentsRoute, /"request_image_generation"/, "the policy API must accept the new permission");
  assert.match(agentsRoute, /"request_content_item"/, "the previously missing content-item permission must be in the allow-list too");
});

test("the upload endpoint is worker-authorized, bounds type and size, and stays server-side", () => {
  const route = read("../app/api/content/images/upload/route.ts");
  assert.match(route, /request\.headers\.get\("authorization"\) === `Bearer \$\{expected\}`/, "the admin/worker token pattern must gate the route");
  assert.match(route, /"image\/png": \["\.png"\]/);
  assert.match(route, /"image\/jpeg": \["\.jpg", "\.jpeg"\]/);
  assert.match(route, /"image\/webp": \["\.webp"\]/);
  assert.match(route, /"image\/gif": \["\.gif"\]/);
  assert.match(route, /MAX_IMAGE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(route, /bytes\.length > MAX_IMAGE_BYTES/);
  assert.match(route, /data_base64/, "uploads arrive as JSON base64 like every other route input");
  assert.match(route, /uploadWordPressMediaBytes/, "the bytes must go through the server-side WordPress adapter");
  assert.match(route, /image_options=\$2::jsonb/, "a named content item gets the URL appended with the intake semantics");
  assert.match(route, /content_image_options_added/);
  assert.match(route, /Content item not found/, "a bad content item id fails before any upload");
  assert.doesNotMatch(route, /console\./, "the route must never log file contents or credentials");
});

test("the database-mode worker mirrors generate_image and executes approved runs via imagegen", () => {
  const worker = read("../scripts/agent-worker.mjs");
  // Proposal mirror: same permission, payload, and label as the registry.
  assert.match(worker, /task\.agent_allowed_actions\.includes\("request_image_generation"\)/);
  assert.match(worker, /prop\?\.type !== "generate_image" \|\| !canGenerateImages/);
  assert.match(worker, /'generate_image',\$7/);
  assert.match(worker, /Generate image \(×\$\{count\}, \$\{purpose\}\): \$\{promptText\.slice\(0, 120\)\}/);
  // Execution is deterministic: the worker itself spawns the imagegen
  // CLI fallback — the skill's built-in image_gen tool is unavailable in
  // headless sessions, so no model session may be involved.
  assert.match(worker, /parseImageGenerationSpec\(claimed\.input\?\.image_generation\)/);
  assert.match(worker, /await executeImageGenerationRun\(pool, claimed, task, imageSpec\)/);
  assert.match(worker, /"skills", "\.system", "imagegen", "scripts", "image_gen\.py"/, "the CLI path must resolve under CODEX_HOME like the worker's other Codex paths");
  assert.match(worker, /spawn\("python3", \[script, \.\.\.args\]/);
  assert.match(worker, /"generate-batch", "--input", inputPath, "--out-dir", outDir, "--force"/, "one JSONL job per requested variation into a fresh output dir");
  assert.match(worker, /OPENAI_API_KEY is not configured on the worker\./, "a missing key must end the run with this exact clear reason");
  assert.doesNotMatch(worker, /generated_images|in its default built-in mode/, "the unavailable built-in mode must not be part of the execution path");
  assert.match(worker, /built-in image_gen tool is NOT used/, "the worker must document why the built-in mode is avoided");
  assert.match(worker, /`\/api\/content\/images\/upload`|"\/api\/content\/images\/upload"|\$\{baseUrl\}\/api\/content\/images\/upload/, "files upload to the server endpoint");
  assert.match(worker, /Image generation produced no image files\./, "an empty generation must end the run with a clear failure reason");
  assert.match(worker, /image_urls: urls/, "returned public URLs must land in the run result");
  // The worker must never hold WordPress credentials — binary upload is
  // server-side only, through the endpoint above.
  assert.doesNotMatch(worker, /WORDPRESS_APP_PASS|WORDPRESS_URL|WORDPRESS_USER|application_password/, "no WordPress credential may ever appear in the worker");
  assert.doesNotMatch(worker, /UPDATE agents SET allowed_actions/, "the worker must never re-grant permissions");
});
