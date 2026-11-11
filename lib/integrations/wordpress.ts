import { query } from "../db";
import { decryptSecret } from "../secrets";
import {
  createWordPressClient,
  type WordPressCredentials,
  type WordPressMedia,
  type WordPressPage,
  type WordPressSettingsUpdate,
  type WordPressSiteProfile,
} from "./wordpress-client";

export type { WordPressCredentials } from "./wordpress-client";
export type { WordPressMedia, WordPressPage, WordPressSettingsUpdate, WordPressSiteProfile } from "./wordpress-client";

export async function getWordPressCredentials(): Promise<WordPressCredentials | null> {
  const envUrl = process.env.WORDPRESS_URL;
  const envUser = process.env.WORDPRESS_USER;
  const envPass = process.env.WORDPRESS_APP_PASS;

  if (envUrl && envUser && envPass) {
    return {
      url: envUrl.trim().replace(/\/+$/, ""),
      username: envUser.trim(),
      application_password: envPass.trim().replace(/\s+/g, ""),
    };
  }

  try {
    const result = await query<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM integration_secrets WHERE name='wordpress-skymountain' LIMIT 1"
    );
    if (!result.rows[0]) return null;
    const stored = decryptSecret<WordPressCredentials>(result.rows[0].encrypted_value);
    return {
      url: stored.url.trim().replace(/\/+$/, ""),
      username: stored.username.trim(),
      application_password: stored.application_password.replace(/\s+/g, ""),
    };
  } catch {
    return null;
  }
}

async function wordpressClient() {
  const credentials = await getWordPressCredentials();
  if (!credentials) throw new Error("WordPress credentials are not configured.");
  return createWordPressClient(credentials);
}

export async function checkWordPressHealth(): Promise<{
  healthy: boolean;
  siteName?: string;
  roles?: string[];
  isAdmin?: boolean;
  message: string;
}> {
  const credentials = await getWordPressCredentials();
  if (!credentials) {
    return { healthy: false, message: "WordPress credentials are not configured." };
  }

  try {
    const me = await createWordPressClient(credentials).getMe();
    const displayName = me.name || me.slug || credentials.username;
    // The connected account's roles decide how much of the full-access
    // surface WordPress will accept (settings and menus need an
    // administrator), so surface them in the health check for the owner.
    const roleNote = me.roles.length ? ` Account roles: ${me.roles.join(", ")}.` : "";
    return {
      healthy: true,
      siteName: displayName,
      roles: me.roles,
      isAdmin: me.roles.includes("administrator"),
      message: `Authenticated successfully as ${displayName}.${roleNote}`,
    };
  } catch (error) {
    return {
      healthy: false,
      message: error instanceof Error ? error.message : "Failed to connect to WordPress.",
    };
  }
}

export async function createWordPressPost(post: {
  title: string;
  content: string;
  status?: "draft" | "publish" | "pending" | "future" | "private";
}): Promise<{ id: number; link: string }> {
  const client = await wordpressClient();
  return client.createPost(post);
}

/**
 * Create a page, or update the existing page targeted by id (preferred)
 * or slug. Used by the publish_wordpress_page tool after owner approval.
 */
export async function createOrUpdateWordPressPage(input: {
  pageId?: number;
  slug?: string;
  title: string;
  content: string;
  status?: "draft" | "publish";
}): Promise<{ page: WordPressPage; created: boolean }> {
  const client = await wordpressClient();
  let targetId = input.pageId;
  if (!targetId && input.slug) {
    const existing = await client.findPageBySlug(input.slug);
    targetId = existing?.id;
  }
  if (targetId) {
    const page = await client.updatePage(targetId, { title: input.title, content: input.content, status: input.status ?? "draft" });
    return { page, created: false };
  }
  const page = await client.createPage({
    title: input.title,
    content: input.content,
    ...(input.slug ? { slug: input.slug } : {}),
    status: input.status ?? "draft",
  });
  return { page, created: true };
}

/** Download an approved public source URL into the WordPress media library. */
export async function uploadWordPressMedia(input: {
  sourceUrl: string;
  title?: string;
  altText?: string;
}): Promise<WordPressMedia> {
  const client = await wordpressClient();
  return client.uploadMediaFromUrl(input);
}

/** Apply the rebuild-critical subset of site settings (see the tool). */
export async function updateWordPressSiteSettings(update: WordPressSettingsUpdate) {
  const client = await wordpressClient();
  return client.updateSettings(update);
}

/**
 * Replace a menu's items with the approved list. WordPress has no bulk
 * menu endpoint, so existing items are deleted and the new ones created
 * in order; parentIndex points at an earlier entry in the same list.
 */
export async function replaceWordPressMenuItems(
  menuId: number,
  items: Array<{ title: string; url: string; parentIndex?: number }>,
): Promise<{ menuId: number; itemCount: number }> {
  const client = await wordpressClient();
  const menus = await client.listMenus();
  if (!menus.some((menu) => menu.id === menuId)) {
    throw new Error(`WordPress menu ${menuId} was not found on the site.`);
  }
  const existing = await client.listMenuItems(menuId);
  for (const item of existing) {
    await client.deleteMenuItem(item.id);
  }
  const createdIds: number[] = [];
  for (const [index, item] of items.entries()) {
    const parent = item.parentIndex !== undefined ? createdIds[item.parentIndex] : undefined;
    const created = await client.createMenuItem(menuId, {
      title: item.title,
      url: item.url,
      ...(parent ? { parent } : {}),
      order: index + 1,
    });
    createdIds.push(created.id);
  }
  return { menuId, itemCount: createdIds.length };
}

/** Read-only rebuild snapshot: identity, homepage settings, menus. */
export async function getWordPressSiteProfile(): Promise<WordPressSiteProfile> {
  const client = await wordpressClient();
  return client.getSiteProfile();
}
