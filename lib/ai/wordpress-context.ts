import { getWordPressPageContent, listWordPressMenus, listWordPressMenuItems, listWordPressPageIndex } from "@/lib/integrations/wordpress";

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
 * an explicit page id in the task title wins outright; the page's
 * slug appearing in the title is a fallback for when no id is named.
 * At most two pages' content ride along, each capped,
 * so the prompt stays bounded.
 *
 * Menus ride along the same way: a menu task needs the menu's numeric
 * id and its current items, and update_wordpress_menu has no slug
 * fallback — without them the agent must decline rather than guess,
 * which is exactly what happened to the 2026-11-19 menu rebuild
 * (declined twice). The menu index loads on every managed run; the
 * current items load only when the task mentions a menu, so page
 * tasks pay one extra cheap call and nothing more.
 */

const MAX_TARGETED_PAGES = 2;
// A real page body runs 5-10 KB; the first live tests showed a
// 2,200-char excerpt is not enough to edit from (the agent rightly
// refused to "preserve" wording it could not see). The prompt
// builder carries targeted contents in a dedicated section with its
// own budget instead of the 6,000-char shared memory slice.
// Raised 12,000 -> 24,000 on 2026-11-21: the homepage body reached
// 14,907 chars, so a link edit was declined because the supplied
// content was truncated mid-section. Keep the prompt builder's
// slice in lib/ai/router.ts at the same value.
const MAX_PAGE_CONTENT_CHARS = 24_000;
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
  menus: Array<{ id: number; name: string; slug: string; locations: string[] }>;
  menu_items: Array<{
    menu_id: number;
    items: Array<{ id: number; title: string; url: string; parent: number; order: number }>;
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

/**
 * Decide which pages a task targets. An explicit page id in the
 * title is authoritative: when any candidate id exists in the page
 * index, slug matching is skipped entirely. Slug matching is a plain
 * substring test, so ordinary words collide with short slugs — a
 * title saying "landing page" once pulled the unrelated page with
 * slug "landing" into a run as a second targeted page, and the agent,
 * faced with a stranger page's excerpt next to its real target,
 * declined the task. Slug matching stays as the fallback for tasks
 * that name a page only by its slug.
 */
export function resolveTargetedPageIds(
  title: string,
  pages: Array<{ id: number; slug: string }>,
): { explicitIds: number[]; slugIds: number[] } {
  const explicitIds = pageIdCandidates(title).filter((id) => pages.some((page) => page.id === id));
  if (explicitIds.length) return { explicitIds, slugIds: [] };
  return { explicitIds, slugIds: slugTargetIds(title, pages, []) };
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
  // The menu index rides the same parallel fetch: one cheap call,
  // and a menu task cannot propose without the numeric menu id.
  const menusPromise = listWordPressMenus().then((menus) => menus, () => null);
  const pages = await listWordPressPageIndex();
  const menus = await menusPromise;
  const menuIndex = (menus ?? []).map((menu) => ({
    id: menu.id,
    name: menu.name,
    slug: menu.slug,
    locations: menu.locations,
  }));
  if (!pages.length && !menuIndex.length) return null;
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
  const { slugIds } = resolveTargetedPageIds(title, pages);
  if (slugIds.length) {
    const results = await Promise.allSettled(slugIds.map((id) => getWordPressPageContent(id)));
    for (const result of results) {
      if (result.status === "fulfilled") pushResult(result.value); // One unreadable page must not sink the whole context.
    }
  }
  // Menu items only when the task is about a menu: a page task has
  // no use for them, and each menu costs one more slow-host call.
  // One unreadable menu must not sink the whole context.
  const menuItems: WordPressRunContext["menu_items"] = [];
  if (title.toLowerCase().includes("menu") && menuIndex.length) {
    const itemResults = await Promise.allSettled(menuIndex.map((menu) => listWordPressMenuItems(menu.id)));
    for (const [index, result] of itemResults.entries()) {
      if (result.status === "fulfilled") {
        menuItems.push({
          menu_id: menuIndex[index].id,
          items: result.value.map((item) => ({
            id: item.id,
            title: item.title,
            url: item.url,
            parent: item.parent,
            order: item.order,
          })),
        });
      }
    }
  }
  return { pages: index, targeted_pages: targeted, menus: menuIndex, menu_items: menuItems };
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
