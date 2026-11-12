// WordPress REST API client (WordPress full-access pack).
//
// This module is the pure HTTP core of the WordPress adapter: it knows how
// to build wp-json requests and map responses, but it never reads the
// environment, the database, or the secret store. Credentials are injected
// by lib/integrations/wordpress.ts, which keeps them server-side. Keeping
// the client dependency-free also makes it unit-testable with a mocked
// fetch (see tests/wordpress-full-access.test.ts).
//
// Every write here is executed only from an owner-approved agent action in
// lib/ai/tool-registry.ts; nothing in this file decides policy.

export type WordPressCredentials = {
  url: string;
  username: string;
  application_password: string;
};

export type WordPressFetch = typeof fetch;

export class WordPressApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(`WordPress API error (${status}): ${message}`);
    this.name = "WordPressApiError";
    this.status = status;
    this.code = code;
  }
}

export type WordPressMe = {
  id: number;
  name: string;
  slug: string;
  roles: string[];
};

export type WordPressPage = {
  id: number;
  slug: string;
  link: string;
  status: string;
  title: string;
};

export type WordPressMedia = {
  id: number;
  slug: string;
  link: string;
  sourceUrl: string;
  title: string;
  mimeType: string;
};

export type WordPressSettings = {
  title: string;
  description: string;
  url: string;
  showOnFront: string;
  pageOnFront: number;
};

export type WordPressSettingsUpdate = {
  title?: string;
  description?: string;
  showOnFront?: "posts" | "page";
  pageOnFront?: number;
};

export type WordPressMenu = {
  id: number;
  name: string;
  slug: string;
  locations: string[];
};

export type WordPressMenuItem = {
  id: number;
  title: string;
  url: string;
  parent: number;
  order: number;
};

export type WordPressSiteProfile = {
  name: string | null;
  description: string | null;
  home: string | null;
  settings: WordPressSettings | null;
  menus: WordPressMenu[] | null;
};

export type WordPressPageInput = {
  title: string;
  content: string;
  slug?: string;
  status?: "draft" | "publish" | "pending" | "private";
};

export type WordPressMediaBytesInput = {
  bytes: ArrayBuffer | Uint8Array;
  filename: string;
  contentType: string;
  title?: string;
  altText?: string;
};

export type WordPressMenuItemInput = {
  title: string;
  url: string;
  parentIndex?: number;
};

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_FETCH_TIMEOUT_MS = 30_000;

function authHeader(credentials: WordPressCredentials): string {
  const token = Buffer.from(`${credentials.username}:${credentials.application_password}`).toString("base64");
  return `Basic ${token}`;
}

function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { rendered?: unknown }).rendered === "string") {
    return (value as { rendered: string }).rendered;
  }
  return "";
}

function toPage(raw: Record<string, unknown>): WordPressPage {
  return {
    id: Number(raw.id ?? 0),
    slug: String(raw.slug ?? ""),
    link: String(raw.link ?? ""),
    status: String(raw.status ?? ""),
    title: rendered(raw.title),
  };
}

function toMedia(raw: Record<string, unknown>): WordPressMedia {
  return {
    id: Number(raw.id ?? 0),
    slug: String(raw.slug ?? ""),
    link: String(raw.link ?? ""),
    sourceUrl: String(raw.source_url ?? ""),
    title: rendered(raw.title),
    mimeType: String(raw.mime_type ?? ""),
  };
}

function toSettings(raw: Record<string, unknown>): WordPressSettings {
  return {
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    url: String(raw.url ?? ""),
    showOnFront: String(raw.show_on_front ?? ""),
    pageOnFront: Number(raw.page_on_front ?? 0),
  };
}

/**
 * Media uploads start from an owner-approved source URL, so the server
 * fetches it at execution time. Only public http(s) hosts are allowed:
 * loopback, link-local, and RFC-1918 targets are rejected so an approved
 * URL can never be used to reach the LAN or cloud metadata endpoints.
 */
export function assertPublicMediaUrl(sourceUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("The media source is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The media source URL must use http or https.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "::1" || host === "[::1]") {
    throw new Error("The media source URL must be a public host.");
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const privateRange =
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
    if (privateRange) throw new Error("The media source URL must be a public host.");
  }
  return parsed;
}

function mediaFilename(source: URL, contentType: string): string {
  const base = source.pathname.split("/").filter(Boolean).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned?.includes(".")) return cleaned.slice(0, 120);
  const extension = contentType.includes("/") ? contentType.split("/")[1].replace(/[^a-z0-9]+/gi, "") : "";
  return `upload${extension ? `.${extension}` : ".bin"}`;
}

export function createWordPressClient(credentials: WordPressCredentials, fetchFn: WordPressFetch = fetch) {
  const base = credentials.url.replace(/\/+$/, "");
  const authorization = authHeader(credentials);

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchFn(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      let code = "";
      let message = `WordPress REST API responded with status ${response.status}.`;
      try {
        const data = (await response.json()) as { code?: unknown; message?: unknown };
        if (typeof data.code === "string") code = data.code;
        if (typeof data.message === "string" && data.message) message = data.message;
      } catch {
        // Non-JSON error body: keep the status-based message.
      }
      throw new WordPressApiError(response.status, code, message);
    }
    return (await response.json()) as T;
  }

  /**
   * Shared binary media POST for both upload paths (URL-downloaded and
   * caller-supplied bytes): posts the raw bytes to /wp-json/wp/v2/media
   * with a Content-Disposition filename, then applies the optional title
   * and alt text with a metadata update, exactly as the original
   * URL-based upload always did.
   */
  async function postMediaBytes(
    bytes: ArrayBuffer | Uint8Array,
    filename: string,
    contentType: string,
    title?: string,
    altText?: string,
  ): Promise<WordPressMedia> {
    const response = await fetchFn(`${base}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: bytes as BodyInit,
      cache: "no-store",
    });
    if (!response.ok) {
      let message = `WordPress REST API responded with status ${response.status}.`;
      try {
        const data = (await response.json()) as { message?: unknown };
        if (typeof data.message === "string" && data.message) message = data.message;
      } catch {
        // Keep the status-based message.
      }
      throw new WordPressApiError(response.status, "", message);
    }
    let media = toMedia((await response.json()) as Record<string, unknown>);
    if (title || altText) {
      const updated = await request<Record<string, unknown>>(`/wp-json/wp/v2/media/${media.id}`, {
        method: "POST",
        body: JSON.stringify({
          ...(title ? { title } : {}),
          ...(altText ? { alt_text: altText } : {}),
        }),
      });
      media = toMedia(updated);
    }
    return media;
  }

  return {
    async getMe(): Promise<WordPressMe> {
      const data = await request<Record<string, unknown>>("/wp-json/wp/v2/users/me?context=edit");
      return {
        id: Number(data.id ?? 0),
        name: String(data.name ?? data.slug ?? ""),
        slug: String(data.slug ?? ""),
        roles: Array.isArray(data.roles) ? data.roles.filter((role): role is string => typeof role === "string") : [],
      };
    },

    async createPost(post: { title: string; content: string; status?: string }): Promise<{ id: number; link: string }> {
      const data = await request<Record<string, unknown>>("/wp-json/wp/v2/posts", {
        method: "POST",
        body: JSON.stringify({ title: post.title, content: post.content, status: post.status ?? "draft" }),
      });
      return { id: Number(data.id ?? 0), link: String(data.link ?? "") };
    },

    async listPages(perPage = 100): Promise<WordPressPage[]> {
      const data = await request<Array<Record<string, unknown>>>(
        `/wp-json/wp/v2/pages?context=edit&per_page=${Math.min(Math.max(perPage, 1), 100)}`,
      );
      return data.map(toPage);
    },

    async getPage(id: number): Promise<WordPressPage> {
      const data = await request<Record<string, unknown>>(`/wp-json/wp/v2/pages/${id}?context=edit`);
      return toPage(data);
    },

    async findPageBySlug(slug: string): Promise<WordPressPage | null> {
      const data = await request<Array<Record<string, unknown>>>(
        `/wp-json/wp/v2/pages?context=edit&slug=${encodeURIComponent(slug)}`,
      );
      return data.length ? toPage(data[0]) : null;
    },

    async createPage(input: WordPressPageInput): Promise<WordPressPage> {
      const data = await request<Record<string, unknown>>("/wp-json/wp/v2/pages", {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          content: input.content,
          ...(input.slug ? { slug: input.slug } : {}),
          status: input.status ?? "draft",
        }),
      });
      return toPage(data);
    },

    async updatePage(id: number, input: Partial<WordPressPageInput>): Promise<WordPressPage> {
      const data = await request<Record<string, unknown>>(`/wp-json/wp/v2/pages/${id}`, {
        method: "POST",
        body: JSON.stringify({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        }),
      });
      return toPage(data);
    },

    async listMedia(perPage = 100): Promise<WordPressMedia[]> {
      const data = await request<Array<Record<string, unknown>>>(
        `/wp-json/wp/v2/media?context=edit&per_page=${Math.min(Math.max(perPage, 1), 100)}`,
      );
      return data.map(toMedia);
    },

    /**
     * URL-based media upload: page/post content fields are capped near
     * 50k characters in agent proposals, so binary payloads can never ride
     * inside a proposal. The agent proposes a public source URL instead;
     * after owner approval the server downloads it (size-capped) and posts
     * the bytes to the media library.
     */
    async uploadMediaFromUrl(input: { sourceUrl: string; title?: string; altText?: string }): Promise<WordPressMedia> {
      const source = assertPublicMediaUrl(input.sourceUrl);
      const download = await fetchFn(source.toString(), { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
      if (!download.ok) throw new Error(`Could not download the media source (HTTP ${download.status}).`);
      const declared = Number(download.headers.get("content-length") ?? 0);
      if (declared > MAX_MEDIA_BYTES) throw new Error("The media source exceeds the 25 MB upload limit.");
      const bytes = await download.arrayBuffer();
      if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("The media source exceeds the 25 MB upload limit.");
      const contentType = download.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
      const filename = mediaFilename(source, contentType);
      return postMediaBytes(bytes, filename, contentType, input.title, input.altText);
    },

    /**
     * Byte-based media upload (image-generation bridge): the caller
     * already holds the image bytes — e.g. the server endpoint that
     * receives a generated image from the agent worker — so there is no
     * source URL to download. The bytes go straight to the media library
     * with the same binary POST and optional title/alt-text update as the
     * URL path; size validation is the caller's job before this call and
     * is re-checked here against the same cap.
     */
    async uploadMediaBytes(input: WordPressMediaBytesInput): Promise<WordPressMedia> {
      const size = input.bytes.byteLength;
      if (!size) throw new Error("The media upload is empty.");
      if (size > MAX_MEDIA_BYTES) throw new Error("The media source exceeds the 25 MB upload limit.");
      const filename = input.filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
      if (!filename.includes(".")) throw new Error("The media filename must include an extension.");
      return postMediaBytes(input.bytes, filename, input.contentType, input.title, input.altText);
    },

    async getSettings(): Promise<WordPressSettings> {
      const data = await request<Record<string, unknown>>("/wp-json/wp/v2/settings");
      return toSettings(data);
    },

    async updateSettings(update: WordPressSettingsUpdate): Promise<WordPressSettings> {
      const data = await request<Record<string, unknown>>("/wp-json/wp/v2/settings", {
        method: "POST",
        body: JSON.stringify({
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.description !== undefined ? { description: update.description } : {}),
          ...(update.showOnFront !== undefined ? { show_on_front: update.showOnFront } : {}),
          ...(update.pageOnFront !== undefined ? { page_on_front: update.pageOnFront } : {}),
        }),
      });
      return toSettings(data);
    },

    async listMenus(): Promise<WordPressMenu[]> {
      const data = await request<Array<Record<string, unknown>>>("/wp-json/wp/v2/menus?context=edit&per_page=100");
      return data.map((menu) => ({
        id: Number(menu.id ?? 0),
        name: String(menu.name ?? ""),
        slug: String(menu.slug ?? ""),
        locations: Array.isArray(menu.locations) ? menu.locations.filter((loc): loc is string => typeof loc === "string") : [],
      }));
    },

    async listMenuItems(menuId: number): Promise<WordPressMenuItem[]> {
      const data = await request<Array<Record<string, unknown>>>(
        `/wp-json/wp/v2/menu-items?context=edit&menus=${menuId}&per_page=100`,
      );
      return data
        .map((item) => ({
          id: Number(item.id ?? 0),
          title: rendered(item.title),
          url: String(item.url ?? ""),
          parent: Number(item.parent ?? 0),
          order: Number(item.menu_order ?? 0),
        }))
        .sort((a, b) => a.order - b.order);
    },

    async createMenuItem(menuId: number, item: { title: string; url: string; parent?: number; order: number }): Promise<WordPressMenuItem> {
      const data = await request<Record<string, unknown>>("/wp-json/wp/v2/menu-items", {
        method: "POST",
        body: JSON.stringify({
          title: item.title,
          url: item.url,
          menus: menuId,
          parent: item.parent ?? 0,
          menu_order: item.order,
          status: "publish",
        }),
      });
      return {
        id: Number(data.id ?? 0),
        title: rendered(data.title),
        url: String(data.url ?? ""),
        parent: Number(data.parent ?? 0),
        order: Number(data.menu_order ?? 0),
      };
    },

    async deleteMenuItem(id: number): Promise<void> {
      await request<Record<string, unknown>>(`/wp-json/wp/v2/menu-items/${id}?force=true`, { method: "DELETE" });
    },

    /**
     * Rebuild planning snapshot: site identity from the wp-json index,
     * homepage settings from /wp/v2/settings, and menus when the site
     * exposes them. Older cores (or hosts that shield the index behind an
     * HTML bot wall) degrade to nulls instead of throwing, so a rebuild
     * plan can still be drafted from whatever answered.
     */
    async getSiteProfile(): Promise<WordPressSiteProfile> {
      let name: string | null = null;
      let description: string | null = null;
      let home: string | null = null;
      try {
        const index = await request<Record<string, unknown>>("/wp-json/");
        name = typeof index.name === "string" ? index.name : null;
        description = typeof index.description === "string" ? index.description : null;
        home = typeof index.home === "string" ? index.home : null;
      } catch {
        // Index unreadable (non-JSON response or route blocked): degrade.
      }
      let settings: WordPressSettings | null = null;
      try {
        settings = await this.getSettings();
      } catch {
        settings = null;
      }
      let menus: WordPressMenu[] | null = null;
      try {
        menus = await this.listMenus();
      } catch {
        // /wp/v2/menus arrived in WordPress 5.9; older cores 404 here.
        menus = null;
      }
      return { name, description, home, settings, menus };
    },
  };
}

export type WordPressClient = ReturnType<typeof createWordPressClient>;
