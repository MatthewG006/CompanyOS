import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractBrandFromHtml, validateWebsiteUrl } from "../lib/brand-extract.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("brand kits are stored per project with the Instagram mapping", () => {
  const schema = read("../db/schema.sql");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS brand_kits/);
  assert.match(schema, /project_id UUID PRIMARY KEY REFERENCES projects\(id\)/);
  for (const column of ["website_url", "logo_url", "colors", "fonts", "phone", "service_area", "services", "instagram_username", "tagline", "source"]) {
    assert.match(schema, new RegExp(column), `brand_kits is missing ${column}`);
  }
});

test("the agency loader composes projects, agents, tasks, approvals and brand kits", () => {
  const data = read("../lib/data.ts");
  assert.match(data, /async function sliceBrandKits/);
  assert.match(data, /export async function getAgencyData\(\) \{[\s\S]*?sliceBrandKits\(\)/);
  assert.match(data, /export async function getBrandKitsData/);
  // a project without a saved kit still gets a row (LEFT JOIN from projects)
  assert.match(data, /FROM projects p LEFT JOIN brand_kits bk ON bk\.project_id=p\.id/);
});

test("demo brand kits carry the connected Instagram accounts, one per business", () => {
  const data = read("../lib/data.ts");
  const kits = data.slice(data.indexOf("export const demoBrandKits"), data.indexOf("const demoContacts"));
  assert.match(kits, /project_name: "Sky Mountain Cloud"[\s\S]*?instagram_username: "skymountaincloud"/);
  assert.match(kits, /project_name: "Sky Mountain Graphics"[\s\S]*?instagram_username: "skymountaingraphics"/);
  assert.match(kits, /project_name: "Plenty of Plants"[\s\S]*?instagram_username: ""/);
});

test("brand extraction reads theme color, og image, fonts, phone and Instagram from a page", () => {
  const html = `<!doctype html><html><head>
    <title>Sunshine Roofing | Roof repair in Broward</title>
    <meta name="theme-color" content="#123456">
    <meta property="og:image" content="/images/hero.png">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Inter&display=swap" rel="stylesheet">
    <style>:root { --brand: #123456; --accent: #ffcc00; } body { color: #333333; font-family: Montserrat, sans-serif; }</style>
    </head><body>
    <p>Call us at (954) 555-0134 for a free inspection.</p>
    <a href="https://www.instagram.com/sunshineroofingfl/">Instagram</a>
    <a href="https://www.instagram.com/p/ABC123/">A post</a>
    </body></html>`;
  const found = extractBrandFromHtml(html, "https://sunshineroofing.example/");
  assert.equal(found.logo_url, "https://sunshineroofing.example/images/hero.png");
  assert.equal(found.colors[0], "#123456");
  assert.ok(found.colors.includes("#ffcc00"));
  assert.ok(found.fonts.includes("Montserrat"));
  assert.equal(found.phone, "(954) 555-0134");
  assert.equal(found.instagram_username, "sunshineroofingfl");
  assert.match(found.tagline, /Sunshine Roofing/);
});

test("website validation only accepts public http(s) URLs", () => {
  assert.equal(validateWebsiteUrl("https://example.com/"), "https://example.com/");
  assert.equal(validateWebsiteUrl("http://192.168.1.10/admin"), null);
  assert.equal(validateWebsiteUrl("http://127.0.0.1:3000/"), null);
  assert.equal(validateWebsiteUrl("http://localhost/"), null);
  assert.equal(validateWebsiteUrl("http://10.0.0.5/"), null);
  assert.equal(validateWebsiteUrl("ftp://example.com/"), null);
  assert.equal(validateWebsiteUrl("https://user:pass@example.com/"), null);
  assert.equal(validateWebsiteUrl("not a url"), null);
  // Bare domains are read as https; a lone word with no dot is still invalid.
  assert.equal(validateWebsiteUrl("example.com"), "https://example.com/");
  assert.equal(validateWebsiteUrl("www.example.com/path"), "https://www.example.com/path");
  assert.equal(validateWebsiteUrl("example"), null);
});

test("brand kit API: owner-reviewed saves, extraction never persists", () => {
  const route = read("../app/api/brand-kits/route.ts");
  assert.match(route, /ON CONFLICT \(project_id\) DO UPDATE/);
  assert.match(route, /brand_kit_updated/);
  const extract = read("../app/api/brand-kits/extract/route.ts");
  assert.match(extract, /extractBrandFromHtml/);
  assert.match(extract, /validateWebsiteUrl/);
  assert.doesNotMatch(extract, /INSERT INTO brand_kits/);
});

test("the brand kit joins the bounded project memory scope", () => {
  const memory = read("../lib/ai/memory.ts");
  assert.match(memory, /FROM brand_kits WHERE project_id=\$1/);
  assert.match(memory, /memory\.brand_kit/);
});

test("the agency desk shows departments, a business switcher and brand kit editing", () => {
  const page = read("../app/agency/page.tsx");
  assert.match(page, /getAgencyData/);
  const desk = read("../app/agency/AgencyDesk.tsx");
  assert.match(desk, /All businesses/);
  assert.match(desk, /editor-in-chief/);
  const editor = read("../app/agency/BrandKitEditor.tsx");
  assert.match(editor, /\/api\/brand-kits\/extract/);
  assert.match(editor, /Read from website/);
  assert.match(editor, /Instagram/);
  const sidebar = read("../components/Sidebar.tsx");
  assert.match(sidebar, /\["Agency", "\/agency"\]/);
});
