import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPublicMediaUrl,
  createWordPressClient,
  WordPressApiError,
  type WordPressCredentials,
} from "../lib/integrations/wordpress-client.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const credentials: WordPressCredentials = {
  url: "https://www.example-site.com/",
  username: "owner-admin",
  application_password: "abcd efgh ijkl mnop",
};
const expectedAuth = `Basic ${Buffer.from("owner-admin:abcd efgh ijkl mnop").toString("base64")}`;

type MockReply = { status?: number; body?: unknown; headers?: Record<string, string> };
type RecordedCall = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => MockReply) {
  const calls: RecordedCall[] = [];
  const fn = async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = handler(url, init);
    const body =
      typeof reply.body === "string" || reply.body instanceof ArrayBuffer
        ? reply.body
        : JSON.stringify(reply.body ?? {});
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers ?? { "content-type": "application/json" } });
  };
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

test("the client reads the authenticated user with roles for the health check", async () => {
  const { fetchFn, calls } = mockFetch(() => ({
    body: { id: 7, name: "Matthew", slug: "matthew", roles: ["administrator"] },
  }));
  const me = await createWordPressClient(credentials, fetchFn).getMe();
  assert.equal(me.name, "Matthew");
  assert.deepEqual(me.roles, ["administrator"]);
  assert.equal(calls[0].url, "https://www.example-site.com/wp-json/wp/v2/users/me?context=edit");
  assert.equal(headersOf(calls[0]).Authorization, expectedAuth);
});

test("pages: create posts the full body, update patches only the given fields", async () => {
  const { fetchFn, calls } = mockFetch((url, init) => {
    if (init.method === "POST" && url.endsWith("/wp-json/wp/v2/pages")) {
      return { body: { id: 42, slug: "services", link: "https://www.example-site.com/services/", status: "draft", title: { rendered: "Services" } } };
    }
    return { body: { id: 42, slug: "services", link: "https://www.example-site.com/services/", status: "publish", title: { rendered: "Services" } } };
  });
  const client = createWordPressClient(credentials, fetchFn);
  const created = await client.createPage({ title: "Services", content: "<p>Hi</p>", slug: "services", status: "draft" });
  assert.equal(created.id, 42);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { title: "Services", content: "<p>Hi</p>", slug: "services", status: "draft" });

  await client.updatePage(42, { status: "publish" });
  assert.equal(calls[1].url, "https://www.example-site.com/wp-json/wp/v2/pages/42");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { status: "publish" });
});

test("pages: slug lookup finds the page to update or returns null", async () => {
  const found = mockFetch(() => ({ body: [{ id: 9, slug: "about", link: "", status: "draft", title: { rendered: "About" } }] }));
  const page = await createWordPressClient(credentials, found.fetchFn).findPageBySlug("about");
  assert.equal(page?.id, 9);
  assert.match(found.calls[0].url, /slug=about/);

  const missing = mockFetch(() => ({ body: [] }));
  assert.equal(await createWordPressClient(credentials, missing.fetchFn).findPageBySlug("nope"), null);
});

test("media upload downloads the approved URL, posts binary, then sets title and alt text", async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10]).buffer;
  const { fetchFn, calls } = mockFetch((url, init) => {
    if (url === "https://cdn.example.com/hero.png") return { body: pngBytes, headers: { "content-type": "image/png" } };
    if (init.method === "POST" && url.endsWith("/wp-json/wp/v2/media")) {
      return { body: { id: 55, slug: "hero", link: "https://www.example-site.com/hero/", source_url: "https://www.example-site.com/wp-content/uploads/hero.png", title: { rendered: "hero" }, mime_type: "image/png" } };
    }
    return { body: { id: 55, slug: "hero", link: "https://www.example-site.com/hero/", source_url: "https://www.example-site.com/wp-content/uploads/hero.png", title: { rendered: "Hero" }, mime_type: "image/png" } };
  });
  const media = await createWordPressClient(credentials, fetchFn).uploadMediaFromUrl({
    sourceUrl: "https://cdn.example.com/hero.png",
    title: "Hero",
    altText: "Team at work",
  });
  assert.equal(media.id, 55);
  assert.equal(calls.length, 3);
  // The WordPress credential must never leak to the third-party source host.
  assert.equal(headersOf(calls[0]).Authorization, undefined);
  assert.equal(headersOf(calls[1]).Authorization, expectedAuth);
  assert.equal(headersOf(calls[1])["Content-Disposition"], 'attachment; filename="hero.png"');
  assert.equal(headersOf(calls[1])["Content-Type"], "image/png");
  assert.equal(calls[2].url, "https://www.example-site.com/wp-json/wp/v2/media/55");
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { title: "Hero", alt_text: "Team at work" });
});

test("media source URLs are restricted to public http(s) hosts", () => {
  assert.equal(assertPublicMediaUrl("https://cdn.example.com/a.jpg").hostname, "cdn.example.com");
  for (const bad of [
    "ftp://cdn.example.com/a.jpg",
    "https://localhost/a.jpg",
    "http://127.0.0.1/a.jpg",
    "http://10.0.0.5/a.jpg",
    "http://172.16.0.9/a.jpg",
    "http://192.168.1.20/a.jpg",
    "http://169.254.169.254/latest/meta-data",
    "not a url",
  ]) {
    assert.throws(() => assertPublicMediaUrl(bad), `expected rejection: ${bad}`);
  }
});

test("settings updates send only the provided fields, mapped to wp keys", async () => {
  const { fetchFn, calls } = mockFetch(() => ({
    body: { title: "New Title", description: "Old", url: "https://www.example-site.com", show_on_front: "posts", page_on_front: 0 },
  }));
  const settings = await createWordPressClient(credentials, fetchFn).updateSettings({ title: "New Title" });
  assert.equal(settings.title, "New Title");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { title: "New Title" });
});

test("the site profile degrades gracefully when the index is not JSON and menus are absent", async () => {
  const { fetchFn } = mockFetch((url) => {
    if (url.endsWith("/wp-json/")) return { body: "<!DOCTYPE html><html><body>bot wall</body></html>", headers: { "content-type": "text/html" } };
    if (url.includes("/wp/v2/settings")) {
      return { body: { title: "Sky Mountain", description: "Design", url: "https://www.example-site.com", show_on_front: "page", page_on_front: 12 } };
    }
    if (url.includes("/wp/v2/menus")) return { status: 404, body: { code: "rest_no_route", message: "No route was found" } };
    return { body: {} };
  });
  const profile = await createWordPressClient(credentials, fetchFn).getSiteProfile();
  assert.equal(profile.name, null);
  assert.equal(profile.settings?.title, "Sky Mountain");
  assert.equal(profile.settings?.pageOnFront, 12);
  assert.equal(profile.menus, null);
});

test("menus: items come back in menu order and creation carries menu, parent and order", async () => {
  const { fetchFn, calls } = mockFetch((url, init) => {
    if (url.includes("/wp/v2/menu-items") && init.method !== "POST") {
      return {
        body: [
          { id: 2, title: { rendered: "About" }, url: "https://www.example-site.com/about/", parent: 0, menu_order: 2 },
          { id: 1, title: { rendered: "Home" }, url: "https://www.example-site.com/", parent: 0, menu_order: 1 },
        ],
      };
    }
    return { body: { id: 3, title: { rendered: "Child" }, url: "https://www.example-site.com/child/", parent: 1, menu_order: 3 } };
  });
  const client = createWordPressClient(credentials, fetchFn);
  const items = await client.listMenuItems(4);
  assert.deepEqual(items.map((item) => item.title), ["Home", "About"]);
  const created = await client.createMenuItem(4, { title: "Child", url: "https://www.example-site.com/child/", parent: 1, order: 3 });
  assert.equal(created.id, 3);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    title: "Child",
    url: "https://www.example-site.com/child/",
    menus: 4,
    parent: 1,
    menu_order: 3,
    status: "publish",
  });
});

test("WordPress errors map to a typed error with status and message", async () => {
  const { fetchFn } = mockFetch(() => ({ status: 403, body: { code: "rest_forbidden", message: "Sorry, you are not allowed to do that." } }));
  await assert.rejects(
    () => createWordPressClient(credentials, fetchFn).getSettings(),
    (error: unknown) => {
      assert.ok(error instanceof WordPressApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "rest_forbidden");
      assert.match(error.message, /not allowed/);
      return true;
    },
  );
});

test("the wrapper keeps credentials server-side and delegates to the pure client", () => {
  const wrapper = read("../lib/integrations/wordpress.ts");
  assert.match(wrapper, /process\.env\.WORDPRESS_URL/);
  assert.match(wrapper, /integration_secrets/);
  assert.match(wrapper, /wordpress-skymountain/);
  assert.match(wrapper, /createWordPressClient/);
  assert.match(wrapper, /roles/);
  assert.doesNotMatch(wrapper, /console\./, "the adapter must never log credentials");
  const client = read("../lib/integrations/wordpress-client.ts");
  assert.doesNotMatch(client, /process\.env|decryptSecret|from "\.\.\/db"/, "the client must stay dependency-free and credential-agnostic");
  assert.doesNotMatch(client, /console\./, "the client must never log");
});

test("the four full-access tools are registered under request_wordpress_manage", () => {
  const registry = read("../lib/ai/tool-registry.ts");
  for (const [actionType, toolName] of [
    ["publish_wordpress_page", "publishWordPressPageTool"],
    ["upload_wordpress_media", "uploadWordPressMediaTool"],
    ["update_wordpress_settings", "updateWordPressSettingsTool"],
    ["update_wordpress_menu", "updateWordPressMenuTool"],
  ]) {
    assert.match(registry, new RegExp(`actionType: "${actionType}"`), `missing tool ${actionType}`);
    assert.match(registry, new RegExp(`\\[${toolName}\\.actionType, ${toolName}\\]`), `tool ${toolName} not in the registry map`);
  }
  const manageTools = registry.match(/permission: "request_wordpress_manage"/g) ?? [];
  assert.equal(manageTools.length, 4, "all four tools must share the manage permission");
  for (const eventType of ["wordpress_page_published", "wordpress_media_uploaded", "wordpress_settings_updated", "wordpress_menu_updated"]) {
    assert.match(registry, new RegExp(eventType), `missing events row for ${eventType}`);
  }
  // The settings approval label must spell out the diff being approved.
  assert.match(registry, /describeSettingsChanges\(value\)\.join\("; "\)/);
  // The legacy post tool keeps its narrower permission.
  assert.match(registry, /publishWordPressPostTool: AgentTool = \{\s+actionType: "publish_wordpress_post",\s+permission: "request_wordpress_publish"/);
});

test("the manage permission is granted in schema and seed to the website agents only", () => {
  const schema = read("../db/schema.sql");
  assert.match(
    schema,
    /UPDATE agents SET allowed_actions=COALESCE\(allowed_actions,'\[\]'::jsonb\) \|\| '\["request_wordpress_manage"\]'::jsonb\s+WHERE LOWER\(name\) IN \('engineer', 'designer', 'graphics', 'marketing'\)/,
  );
  const seed = read("../scripts/seed.mjs");
  assert.match(seed, /\["Engineer", "Designer", "Graphics", "Marketing"\]\.includes\(row\[0\]\) \? \["request_wordpress_manage"\]/);
  const agentsRoute = read("../app/api/agents/route.ts");
  assert.match(agentsRoute, /"request_wordpress_manage"/);
});

test("the router advertises the rebuild tools only with the manage permission", () => {
  const router = read("../lib/ai/router.ts");
  assert.match(
    router,
    /includes\("request_wordpress_manage"\) \? \["publish_wordpress_page", "upload_wordpress_media", "update_wordpress_settings", "update_wordpress_menu"\]/,
  );
  for (const type of ["publish_wordpress_page", "upload_wordpress_media", "update_wordpress_settings", "update_wordpress_menu"]) {
    assert.match(router, new RegExp(`"type":"${type}"`), `JSON contract is missing ${type}`);
    assert.match(router, new RegExp(`For ${type}:`), `missing usage guidance for ${type}`);
  }
});

test("the database-mode worker mirrors the manage tools with the same bounds", () => {
  const worker = read("../scripts/agent-worker.mjs");
  assert.match(worker, /task\.agent_allowed_actions\.includes\("request_wordpress_manage"\)/);
  for (const type of ["publish_wordpress_page", "upload_wordpress_media", "update_wordpress_settings", "update_wordpress_menu"]) {
    assert.match(worker, new RegExp(`prop\\?\\.type === "${type}"`), `worker mirror is missing ${type}`);
  }
});

test("the health route surfaces the connected account roles", () => {
  const route = read("../app/api/integrations/wordpress/route.ts");
  assert.match(route, /roles: health\.roles \?\? \[\]/);
  assert.match(route, /is_admin: health\.isAdmin \?\? false/);
});
