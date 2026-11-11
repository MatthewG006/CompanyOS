import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// WordPress connect form guards: PR #39 shipped the
// /api/integrations/wordpress endpoint (encrypted storage + health check)
// but no screen called it, so the owner could never connect the site from
// the app. The Operations page now carries the form; these guards keep it
// wired to the endpoint and keep the password handling safe.

const read = (path: string) => readFileSync(path, "utf8");

test("the WordPress connect component exists and posts credentials to the endpoint", () => {
  assert.ok(existsSync("components/WordPressConnect.tsx"), "components/WordPressConnect.tsx missing");
  const component = read("components/WordPressConnect.tsx");
  assert.match(component, /fetch\("\/api\/integrations\/wordpress"/, "component must call the wordpress integrations endpoint");
  assert.match(component, /application_password: password\.trim\(\)/, "component must post the application_password field the route expects");
  assert.match(component, /method: "POST"/, "saving must POST");
});

test("the application password is a password field and is cleared after save", () => {
  const component = read("components/WordPressConnect.tsx");
  assert.match(component, /type="password"/, "application password input must be masked");
  assert.match(component, /setPassword\(""\)/, "password state must be cleared after saving");
  assert.ok(!/localStorage|sessionStorage/.test(component.replace(/AdminToken/g, "")), "the WordPress password must never touch browser storage");
});

test("the component reads back the health status including the admin check", () => {
  const component = read("components/WordPressConnect.tsx");
  assert.match(component, /is_admin/, "component must surface the administrator check from the health response");
  assert.match(component, /cache: "no-store"/, "status reads must not be cached");
});

test("the Operations page renders the WordPress connection section", () => {
  const page = read("app/operations/page.tsx");
  assert.match(page, /WordPressConnect/, "operations page must render WordPressConnect");
  assert.match(page, /WordPress connection/, "operations page must label the WordPress connection section");
});

test("the endpoint still stores credentials encrypted under the connection name", () => {
  const route = read("app/api/integrations/wordpress/route.ts");
  assert.match(route, /encryptSecret/, "route must encrypt credentials before storage");
  assert.match(route, /'wordpress-skymountain'/, "route must store under the wordpress-skymountain connection name");
});
