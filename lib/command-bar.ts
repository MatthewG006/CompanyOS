// Pure parsing for the Command Center command bar (app/api/command/route.ts).
//
// The route used to interleave these heuristics with its info branches, which
// caused three bugs: explicit "create task" commands that merely mentioned a
// project/agent/finance topic were swallowed by the info branches that ran
// first; any command starting with "please"/"request" or mentioning a website
// created a task (questions included); and project/agent matching depended on
// array order. Keeping the parsing here makes those rules unit-testable —
// see tests/command-bar.test.ts.

export type CommandProject = {
  id: string;
  name: string;
  slug: string;
};

export type CommandAgent = {
  id: string;
  name: string;
};

export type TaskDraft = {
  title: string;
  project: CommandProject | null;
  agent: CommandAgent | null;
};

const EXPLICIT_TASK_PREFIX = /^(create task|add task|new task|task:)/i;
const EXPLICIT_TASK_WORD = /^task\s/i;

// Topics that mark a command as being about the website. Used both for the
// Graphics project fallback and for inferred task detection.
const WEBSITE_TOPICS = ["wordpress", "website", "landing page"];

// First words that make a website command an imperative task request.
const TASK_IMPERATIVES = new Set([
  "build",
  "create",
  "update",
  "fix",
  "redesign",
  "publish",
  "launch",
  "make",
  "add",
  "write",
  "design",
]);

// First words that mark a command as a question or info request, never a
// task — even when it mentions the website. "please" and "request" live here
// (and nowhere else): politeness is not a task trigger.
const INFO_STARTERS = new Set([
  "how",
  "what",
  "why",
  "when",
  "is",
  "are",
  "do",
  "does",
  "can",
  "could",
  "show",
  "list",
  "check",
  "please",
  "request",
]);

function firstWord(command: string): string {
  return command.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
}

function hasWebsiteTopic(text: string): boolean {
  const lower = text.toLowerCase();
  return WEBSITE_TOPICS.some((topic) => lower.includes(topic));
}

function mentionsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * Match the project a piece of text refers to:
 * 1. the longest full project name or slug that appears in the text, so
 *    "Sky Mountain Graphics" beats "Sky Mountain Cloud" when both appear;
 * 2. otherwise the project whose distinctive last name word (Cloud, Plants,
 *    Graphics) appears as a whole word — only when exactly one project
 *    matches that way;
 * 3. otherwise, for wordpress / landing page / graphics work, the Graphics
 *    project, preserving the previous fallback behaviour. A bare "website"
 *    mention deliberately does not trigger this fallback.
 */
export function matchProject(text: string, projects: CommandProject[]): CommandProject | null {
  const lower = text.toLowerCase();

  let best: CommandProject | null = null;
  let bestLength = 0;
  for (const project of projects) {
    const candidates = [project.name.toLowerCase(), project.slug.toLowerCase(), project.slug.replace(/-/g, " ")];
    for (const candidate of candidates) {
      if (candidate && lower.includes(candidate) && candidate.length > bestLength) {
        best = project;
        bestLength = candidate.length;
      }
    }
  }
  if (best) return best;

  const distinctiveMatches = projects.filter((project) => {
    const words = project.name.trim().toLowerCase().split(/\s+/);
    const distinctive = words[words.length - 1];
    return distinctive ? mentionsWord(lower, distinctive) : false;
  });
  if (distinctiveMatches.length === 1) return distinctiveMatches[0];

  if (lower.includes("wordpress") || lower.includes("landing page") || lower.includes("graphics")) {
    return projects.find((project) => project.name.toLowerCase().includes("graphics")) ?? null;
  }
  return null;
}

/**
 * The agent website/design/page tasks are auto-assigned to. Engineer is
 * preferred over Designer deterministically, regardless of the order the
 * agents happen to be listed in.
 */
export function findWebsiteAgent(agents: CommandAgent[]): CommandAgent | null {
  return (
    agents.find((agent) => agent.name.toLowerCase() === "engineer") ??
    agents.find((agent) => agent.name.toLowerCase() === "designer") ??
    null
  );
}

function buildDraft(title: string, projects: CommandProject[], agents: CommandAgent[]): TaskDraft {
  let raw = title.trim();
  let agent: CommandAgent | null = null;

  // "for <Agent>: <title>" / "to <Agent>: <title>" explicit assignment.
  const agentMatch = raw.match(/^(?:for|to)\s+([a-zA-Z0-9\s]+?)\s*[:-]\s*(.*)$/i);
  if (agentMatch) {
    const found = agents.find((a) => a.name.toLowerCase() === agentMatch[1].trim().toLowerCase());
    if (found) {
      agent = found;
      raw = agentMatch[2].trim();
    }
  }

  const project = matchProject(raw, projects);

  if (!agent) {
    const lower = raw.toLowerCase();
    if (lower.includes("design") || lower.includes("page") || hasWebsiteTopic(lower)) {
      agent = findWebsiteAgent(agents);
    }
  }

  return { title: raw, project, agent };
}

/** Explicit task commands: "create task …", "add task …", "new task …", "task: …", "task …". */
export function isExplicitTaskCommand(command: string): boolean {
  const trimmed = command.trim();
  return EXPLICIT_TASK_PREFIX.test(trimmed) || EXPLICIT_TASK_WORD.test(trimmed);
}

/**
 * Build a draft from an explicit task command, or return null when the
 * command is not one. The title keeps whatever follows the prefix (a leading
 * "please" after the prefix is stripped too); it may be empty, which the
 * route turns into its task-create-help response.
 */
export function buildExplicitTaskDraft(
  command: string,
  projects: CommandProject[],
  agents: CommandAgent[],
): TaskDraft | null {
  if (!isExplicitTaskCommand(command)) return null;
  const raw = command
    .trim()
    .replace(/^(create task|add task|new task|task)\s*[:-]?\s*/i, "")
    .replace(/^please\s*[:-]?\s*/i, "")
    .trim();
  return buildDraft(raw, projects, agents);
}

/**
 * Inferred website tasks: a command about wordpress / the website / a landing
 * page that is phrased as an imperative ("Update the landing page hero"),
 * not as a question or info request ("How is our website doing?",
 * "Please show me the website stats", "Request status of …"). Anything
 * starting with "please" or "request" is an info request by definition here.
 */
export function isInferredWebsiteTaskCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!hasWebsiteTopic(trimmed)) return false;
  if (trimmed.endsWith("?")) return false;
  const first = firstWord(trimmed);
  if (INFO_STARTERS.has(first)) return false;
  return TASK_IMPERATIVES.has(first);
}

/**
 * Build a draft from an inferred website task command, or return null when
 * the command is not one. There is no prefix to strip: the whole command is
 * the task title, as it was when keyword matching created these tasks.
 */
export function buildInferredTaskDraft(
  command: string,
  projects: CommandProject[],
  agents: CommandAgent[],
): TaskDraft | null {
  if (!isInferredWebsiteTaskCommand(command)) return null;
  return buildDraft(command.trim(), projects, agents);
}
