import { getWordPressPageContent, listWordPressPageIndex } from "@/lib/integrations/wordpress";

/**
 * WordPress run context for agents holding request_wordpress_manage.
 *
 * Why this exists: agent runs are ephemeral and used to receive no
 * WordPress state at all, so an agent asked to *fix* an existing page
 * could not see the page's current HTML and either declined or
 * replaced it blind — the failure behind the 2026-11-13 website
 * correction round. At queue time the server (which holds the
 * credentials) now snapshots the page index and, for the pages the
 * task actually names, their current stored content, and the prompt
 * builder carries it as bounded memory. Deterministic matching only:
 * an explicit page id in the task title, or the page's slug appearing
 * in the title. At most two pages' content ride along, each capped,
 * so the prompt stays bounded.
 */

const MAX_TARGETED_PAGES = 2;
// A real page body runs 5-10 KB; the first live tests showed a
// 2,200-char excerpt is not enough to edit from (the agent rightly
// refused to "preserve" wording it could not see). The prompt
// builder carries targeted contents in a dedicated section with its
// own budget instead of the 6,000-char shared memory slice.
const MAX_PAGE_CONTENT_CHARS = 12_000;
// The WordPress host can take 5-10 s to answer on a cold connection
// (measured live 2026-11-13); an 8 s budget silently starved the
// first plumbing test run of its context. The lean _fields index
// keeps the normal case near a second, and this budget covers the
// slow tail without blocking task creation for long.
const CONTEXT_TIMEOUT_MS = 20_000;

export type WordPressRunContext = {
  pages: Array<{ id: number; slug: string; title: string; status: string; template: string }>;
  targeted_pages: Array<{
    id: number;
    slug: string;
    title: string;
    template: string;
    content: string;
    content_truncated: boolean;
  }>;
};

function pageIdCandidates(title: string): number[] {
  const ids: number[] = [];
  const lower = title.toLowerCase();
  const idPatterns = [/(?:page_id|page id|page)\s*#?\s*(\d{1,9})/gi, /#(\d{1,9})\b/g];
  for (const pattern of idPatterns) {
    for (const match of lower.matchAll(pattern)) {
      const id = Number(match[1]);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, MAX_TARGETED_PAGES);
}

function slugTargetIds(title: string, pages: Array<{ id: number; slug: string }>, already: number[]): number[] {
  const ids: number[] = [];
  const lower = title.toLowerCase();
  for (const page of pages) {
    if (already.length + ids.length >= MAX_TARGETED_PAGES) break;
    if (page.slug.length >= 3 && lower.includes(page.slug) && !already.includes(page.id) && !ids.includes(page.id)) ids.push(page.id);
  }
  return ids;
}

async function loadContext(title: string): Promise<WordPressRunContext | null> {
  // Start the targeted-content fetches for explicitly named page ids
  // at the same time as the index fetch: on this host each request
  // can take 5-10 s, so serializing them is what blew the budget.
  // Candidates are validated against the index before use.
  const candidates = pageIdCandidates(title);
  const candidateContent = new Map(
    candidates.map((id) => [id, getWordPressPageContent(id).then((result) => result, () => null)] as const),
  );
  const pages = await listWordPressPageIndex();
  if (!pages.length) return null;
  const index = pages.map((page) => ({
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    template: page.template,
  }));
  const targeted: WordPressRunContext["targeted_pages"] = [];
  const pushResult = (result: { page: { id: number; slug: string; title: string; template: string }; content: string } | null) => {
    if (!result || targeted.length >= MAX_TARGETED_PAGES) return;
    const { page, content } = result;
    targeted.push({
      id: page.id,
      slug: page.slug,
      title: page.title,
      template: page.template,
      content: content.slice(0, MAX_PAGE_CONTENT_CHARS),
      content_truncated: content.length > MAX_PAGE_CONTENT_CHARS,
    });
  };
  for (const id of candidates) {
    const pending = candidateContent.get(id);
    if (pending && pages.some((page) => page.id === id)) pushResult(await pending);
  }
  const slugIds = slugTargetIds(title, pages, targeted.map((page) => page.id));
  if (slugIds.length) {
    const results = await Promise.allSettled(slugIds.map((id) => getWordPressPageContent(id)));
    for (const result of results) {
      if (result.status === "fulfilled") pushResult(result.value); // One unreadable page must not sink the whole context.
    }
  }
  return { pages: index, targeted_pages: targeted };
}

/**
 * Load the context, never failing the queue: WordPress being slow or
 * unconfigured just means the run proceeds without page context,
 * exactly as runs did before this loader existed.
 */
export async function loadWordPressRunContext(title: string): Promise<WordPressRunContext | null> {
  try {
    return await Promise.race([
      loadContext(title),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}
