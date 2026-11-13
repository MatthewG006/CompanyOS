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
  username: "owner-admin",
  application_password: "abcd efgh ijkl mnop",
};

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

const pageBody = {
  id: 2081,
  slug: "hoa-websites",
  link: "https://www.example-site.com/hoa-websites/",
  status: "publish",
  title: { rendered: "HOA Websites" },
  template: "elementor_header_footer",
};

test("client sends the template on create and update only when one is provided", async () => {
  const { fetchFn, calls } = mockFetch(() => ({ body: pageBody }));
  const client = createWordPressClient(credentials, fetchFn);

  const created = await client.createPage({ title: "HOA Websites", content: "<p>x</p>", template: "elementor_header_footer" });
  assert.equal(created.template, "elementor_header_footer");
  assert.equal(JSON.parse(String(calls[0].init.body)).template, "elementor_header_footer");

  await client.updatePage(2081, { template: "" });
  assert.equal(JSON.parse(String(calls[1].init.body)).template, "");

  await client.updatePage(2081, { status: "draft" });
  assert.equal("template" in JSON.parse(String(calls[2].init.body)), false);
});

test("client reads a page's stored raw content and template for edit context", async () => {
  const { fetchFn, calls } = mockFetch(() => ({
    body: { ...pageBody, content: { raw: "<section>raw html</section>", rendered: "<p>rendered</p>" } },
  }));
  const client = createWordPressClient(credentials, fetchFn);
  const { page, content } = await client.getPageContent(2081);
  assert.equal(calls[0].url, "https://www.example-site.com/wp-json/wp/v2/pages/2081?context=edit");
  assert.equal(content, "<section>raw html</section>");
  assert.equal(page.template, "elementor_header_footer");
});

test("the page tool carries template, style, and image count through parse, payload, and execute", () => {
  const registry = read("../lib/ai/tool-registry.ts");
  assert.match(registry, /boundedTemplate\(value\.template\)/);
  assert.match(registry, /boundedPageStyle\(value\.style\)/);
  assert.match(registry, /image_count: value\.imageCount/);
  assert.match(registry, /template: template \?\? null, has_style: Boolean\(style\)/);
  // Execution forwards both fields to the adapter.
  assert.match(registry, /createOrUpdateWordPressPage\(\{ pageId, slug: slug \|\| undefined, title, content, status, template, style \}\)/);
  // Old payloads without the fields stay valid: bounded helpers return
  // undefined for missing values, which the adapter treats as "leave
  // the template unchanged" and "no style block".
  assert.match(registry, /export function boundedTemplate/);
  assert.match(registry, /export function boundedPageStyle/);
  assert.match(registry, /export function countContentImages/);
});

test("style blocks are refused when they could break out or import resources", () => {
  const registry = read("../lib/ai/tool-registry.ts");
  assert.match(registry, /\/<\\\/style\/i/);
  assert.match(registry, /\/@import\/i/);
  const adapter = read("../lib/integrations/wordpress.ts");
  assert.match(adapter, /<style data-companyos-scoped="page">/);
});

test("the worker mirrors the page tool's template, style, and image-count handling", () => {
  const worker = read("../scripts/agent-worker.mjs");
  assert.match(worker, /const wpTemplate = /);
  assert.match(worker, /const wpPageStyle = /);
  assert.match(worker, /const wpImageCount = /);
  assert.match(worker, /template: template \?\? null, style: style \?\? "", image_count: imageCount/);
  assert.match(worker, /includes page CSS/);
  assert.match(worker, /no images/);
});

test("runs for WordPress-managing agents are queued with current page context", () => {
  const queue = read("../lib/ai/queue-task-run.ts");
  assert.match(queue, /loadWordPressRunContext\(args\.title\)/);
  assert.match(queue, /request_wordpress_manage/);
  const context = read("../lib/ai/wordpress-context.ts");
  assert.match(context, /MAX_TARGETED_PAGES = 2/);
  assert.match(context, /targetedPageIds/);
  // The loader must never fail the queue.
  assert.match(context, /catch \{\s*\n\s*return null;/);
});

test("the prompt teaches template, scoped style, contrast, and image expectations", () => {
  const router = read("../lib/ai/router.ts");
  assert.match(router, /wordpress\.targeted_pages/);
  assert.match(router, /Include "template" to set the page template/);
  assert.match(router, /prefix every selector with your content\\?'s outermost wrapper class/);
  assert.match(router, /white-on-white text invisible/);
  assert.match(router, /\\?"template\\?":"elementor_header_footer"/);
});
