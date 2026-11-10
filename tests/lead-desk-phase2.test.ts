import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("content items are stored per project with the planner status flow", () => {
  const schema = read("../db/schema.sql");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS content_items/);
  assert.match(schema, /type TEXT NOT NULL DEFAULT 'post' CHECK \(type IN \('post','reel','story','article'\)\)/);
  assert.match(schema, /status TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft','in_review','approved','scheduled','published'\)\)/);
  assert.match(schema, /image_options JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(schema, /scheduled_for DATE/);
});

test("the content loader composes projects, brand kits and content items", () => {
  const data = read("../lib/data.ts");
  assert.match(data, /async function sliceContentItems/);
  assert.match(data, /export async function getContentData\(\) \{[\s\S]*?sliceContentItems\(\)/);
  const demo = data.slice(data.indexOf("export const demoContentItems"), data.indexOf("const demoContacts"));
  for (const business of ["Sky Mountain Cloud", "Plenty of Plants", "Sky Mountain Graphics"]) {
    assert.match(demo, new RegExp(`project_name: "${business}"`), `demo planner is missing ${business}`);
  }
  assert.match(demo, /status: "in_review"/);
  assert.match(demo, /status: "scheduled"/);
});

test("agents propose content through the approval flow via request_content_item", () => {
  const registry = read("../lib/ai/tool-registry.ts");
  assert.match(registry, /actionType: "create_content_item"/);
  assert.match(registry, /permission: "request_content_item"/);
  assert.match(registry, /INSERT INTO content_items \(project_id,type,title,caption,image_prompt,status,scheduled_for,created_by\)\s*VALUES \(\$1,\$2,\$3,\$4,\$5,'in_review'/);
  const router = read("../lib/ai/router.ts");
  assert.match(router, /includes\("request_content_item"\) \? \["create_content_item"\]/);
  const worker = read("../scripts/agent-worker.mjs");
  assert.match(worker, /prop\?\.type !== "create_content_item" \|\| !canProposeContent/);
  assert.match(worker, /'create_content_item',\$7/);
  const seed = read("../scripts/seed.mjs");
  assert.match(seed, /row\[0\] === "Marketing" \? \["request_content_item"\]/);
});

test("content API: owner CRUD, week approval, and schedule-requires-date", () => {
  const route = read("../app/api/content/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /body\?\.bulk === "approve_week"/);
  assert.match(route, /status='in_review' AND scheduled_for >= \$2::date/);
  assert.match(route, /Pick a date before scheduling this item/);
});

test("design studio intake adds variations without choosing one", () => {
  const route = read("../app/api/content/images/route.ts");
  assert.match(route, /image_options=\$2::jsonb/);
  assert.doesNotMatch(route, /image_url=/);
  assert.match(route, /content_image_options_added/);
});

test("the planner page renders a week grid with a studio panel and sidebar link", () => {
  const page = read("../app/planner/page.tsx");
  assert.match(page, /getContentData/);
  const board = read("../app/planner/PlannerBoard.tsx");
  assert.match(board, /Approve this week/);
  assert.match(board, /Ideas · unscheduled/);
  assert.match(board, /Due to publish/);
  const panel = read("../app/planner/ContentItemPanel.tsx");
  assert.match(panel, /Design studio/);
  assert.match(panel, /Approve this visual/);
  assert.match(panel, /Publishes to Instagram @/);
  const sidebar = read("../components/Sidebar.tsx");
  assert.match(sidebar, /\["Planner", "\/planner"\]/);
});
