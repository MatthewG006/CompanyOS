import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExplicitTaskDraft,
  buildInferredTaskDraft,
  isExplicitTaskCommand,
  isInferredWebsiteTaskCommand,
  matchProject,
  type CommandAgent,
  type CommandProject,
} from "../lib/command-bar.ts";

// Designer is deliberately listed before Engineer: auto-assignment must
// prefer Engineer deterministically, not by array order.
const projects: CommandProject[] = [
  { id: "p-cloud", name: "Sky Mountain Cloud", slug: "sky-mountain-cloud" },
  { id: "p-plants", name: "Plenty of Plants", slug: "plenty-of-plants" },
  { id: "p-graphics", name: "Sky Mountain Graphics", slug: "sky-mountain-graphics" },
];

const agents: CommandAgent[] = [
  { id: "a-designer", name: "Designer" },
  { id: "a-engineer", name: "Engineer" },
  { id: "a-sales", name: "Sales" },
];

test("explicit create mentioning a project creates a task for that project", () => {
  const draft = buildExplicitTaskDraft("Create task: Migrate the Sky Mountain Cloud Nextcloud instance", projects, agents);
  assert.ok(draft);
  assert.equal(draft.title, "Migrate the Sky Mountain Cloud Nextcloud instance");
  assert.equal(draft.project?.name, "Sky Mountain Cloud");
});

test("explicit create mentioning agent and finance topics still creates a task", () => {
  // The old routing answered this from the agents/finance info branches and
  // never created anything.
  const draft = buildExplicitTaskDraft("Create task: Reconcile the finance agent report", projects, agents);
  assert.ok(draft);
  assert.equal(draft.title, "Reconcile the finance agent report");
  assert.equal(draft.project, null);
});

test("explicit create with 'for <Agent>:' assigns that agent and strips the pattern", () => {
  const draft = buildExplicitTaskDraft("Create task for Engineer: Update landing page hero", projects, agents);
  assert.ok(draft);
  assert.equal(draft.agent?.name, "Engineer");
  assert.equal(draft.title, "Update landing page hero");
});

test("explicit detection covers the create/add/new/task prefixes and nothing else", () => {
  for (const command of ["Create task: X", "Add task: X", "New task: X", "Task: X", "Task X"]) {
    assert.equal(isExplicitTaskCommand(command), true, command);
  }
  for (const command of ["Please create a task", "Request a task", "Show tasks", "Tasks: X"]) {
    assert.equal(isExplicitTaskCommand(command), false, command);
  }
});

test("longest full project match wins when two project names appear", () => {
  // Cloud is listed first and appears last in the text; the old first-match
  // loop would have picked it. "Sky Mountain Graphics" is the longer match.
  const draft = buildExplicitTaskDraft(
    "Create task: Move the Sky Mountain Graphics assets into Sky Mountain Cloud storage",
    projects,
    agents,
  );
  assert.ok(draft);
  assert.equal(draft.project?.name, "Sky Mountain Graphics");
  assert.equal(matchProject("Sky Mountain Cloud versus Sky Mountain Graphics", projects)?.name, "Sky Mountain Graphics");
});

test("distinctive last-word match finds a project named only by that word", () => {
  const draft = buildExplicitTaskDraft("Create task: Update the Plants inventory page", projects, agents);
  assert.ok(draft);
  assert.equal(draft.project?.name, "Plenty of Plants");
});

test("landing-page task with no project falls back to Graphics", () => {
  const draft = buildExplicitTaskDraft("Create task: Build a landing page for the spring campaign", projects, agents);
  assert.ok(draft);
  assert.equal(draft.project?.name, "Sky Mountain Graphics");
});

test("inferred imperatives about the website produce a draft", () => {
  const landing = buildInferredTaskDraft("Update the landing page hero", projects, agents);
  assert.ok(landing);
  assert.equal(landing.title, "Update the landing page hero");
  assert.equal(landing.project?.name, "Sky Mountain Graphics");
  assert.equal(landing.agent?.name, "Engineer");

  const redesign = buildInferredTaskDraft("Redesign the website homepage", projects, agents);
  assert.ok(redesign);
  assert.equal(redesign.title, "Redesign the website homepage");
  assert.equal(redesign.project, null);
  // Designer is listed first in the fixture; Engineer must still win.
  assert.equal(redesign.agent?.name, "Engineer");
});

test("questions and info requests produce no task draft from either detector", () => {
  const infoCommands = [
    "How is our website doing?",
    "Please show me the website stats",
    "Request status of the website migration",
    "Show finance",
  ];
  for (const command of infoCommands) {
    assert.equal(isExplicitTaskCommand(command), false, command);
    assert.equal(isInferredWebsiteTaskCommand(command), false, command);
    assert.equal(buildExplicitTaskDraft(command, projects, agents), null, command);
    assert.equal(buildInferredTaskDraft(command, projects, agents), null, command);
  }
});

test("'please' and 'request' are never task triggers on their own", () => {
  assert.equal(buildExplicitTaskDraft("Please update the website", projects, agents), null);
  assert.equal(buildInferredTaskDraft("Please update the website", projects, agents), null);
  assert.equal(buildInferredTaskDraft("Request an update to the website", projects, agents), null);
});

test("explicit draft with an empty title is preserved for the route's help response", () => {
  const draft = buildExplicitTaskDraft("Create task:", projects, agents);
  assert.ok(draft);
  assert.equal(draft.title, "");
});
