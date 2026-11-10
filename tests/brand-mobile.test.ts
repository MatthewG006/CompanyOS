import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Brand + mobile guards: the dashboard wears the Sky Mountain Graphics
// palette sampled from the owner's logo (deep teal #4196b3, sky blue
// #54c9ea), the logo itself ships in /public and appears in the sidebar
// and on the login card, and the mobile layout keeps a full-width nav
// row, 44px touch targets, and no squeezed multi-column rows.

const read = (path: string) => readFileSync(path, "utf8");
const css = () => read("app/globals.css");

test("the brand palette from the logo drives the theme tokens", () => {
  const styles = css();
  assert.match(styles, /--brand: #4196b3;/, "brand deep teal token missing");
  assert.match(styles, /--brand-sky: #54c9ea;/, "brand sky token missing");
  assert.match(styles, /--accent: #54c9ea;/, "accent must be the logo sky blue");
  assert.match(styles, /--bg: #07191f;/, "background must be the deep teal-navy");
  assert.match(styles, /--border: #1e4657;/, "border must be the teal border");
});

test("no indigo or violet theme colors remain", () => {
  const styles = css().toLowerCase();
  for (const stale of ["#7c8cff", "#6c77ff", "#9c68ff", "#a978ff", "#586bd0", "#11182a", "#0c1323"]) {
    assert.ok(!styles.includes(stale), `stale pre-brand color ${stale} is still in globals.css`);
  }
});

test("primary actions use the brand gradient", () => {
  const styles = css();
  assert.match(styles, /\.command-form button \{[^}]*linear-gradient\(135deg, var\(--brand\), var\(--brand-sky\)\)/, "command button must use the brand gradient");
  assert.match(styles, /\.progress-bar \{[^}]*linear-gradient\(90deg, #4196b3, #54c9ea\)/, "progress bars must use the brand gradient");
});

test("the owner-supplied logo ships and is used in the sidebar and login", () => {
  assert.ok(existsSync("public/brand-logo.png"), "public/brand-logo.png is missing");
  const sidebar = read("components/Sidebar.tsx");
  assert.match(sidebar, /src="\/brand-logo\.png"/, "sidebar must show the brand logo");
  assert.match(sidebar, /className="brand-logo"/, "sidebar logo must use the brand-logo styling");
  const login = read("app/login/page.tsx");
  assert.match(login, /src="\/brand-logo\.png"/, "login card must show the brand logo");
});

test("the layout declares a mobile viewport with the brand theme color", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /export const viewport/, "layout must export a viewport");
  assert.match(layout, /themeColor: "#07191f"/, "theme color must match the brand background");
});

test("mobile layout: full-width nav row, touch targets, no squeezed rows", () => {
  const styles = css();
  assert.match(styles, /\.sidebar nav \{[^}]*order: 3;/, "mobile nav must take its own full-width row");
  assert.ok(styles.includes("flex: 1 1 100%"), "mobile nav must span the full width");
  assert.match(styles, /\.nav-link \{[^}]*min-height: 44px;/, "mobile nav links must be 44px touch targets");
  assert.ok(styles.includes(".sales-outcome-row button, .planner-weeknav a, .signout-button { min-height: 44px; }"), "primary tap controls must get 44px targets on mobile");
  assert.match(styles, /@media \(max-width: 700px\) \{\s*\.page-wrap \{ padding: 18px 14px 26px; \}/, "phone page padding must tighten");
  assert.match(styles, /\.sync-row \{ grid-template-columns: 1fr 1fr; \}/, "sync rows must collapse on phones instead of squeezing four columns");
  assert.match(styles, /\.command-kbd \{ display: none; \}/, "the keyboard hint must hide on phones");
  assert.match(styles, /overflow-x: clip;/, "horizontal overflow must be clipped");
});

test("the demo brand kit for Sky Mountain Graphics carries the real logo colors", () => {
  const data = read("lib/data.ts");
  assert.match(data, /"#4196b3", "#54c9ea", "#ffffff"/, "Graphics demo kit must use the sampled logo palette");
});
