import { query } from "../db";
import { decryptSecret } from "../secrets";

export type WordPressCredentials = {
  url: string;
  username: string;
  application_password: string;
};

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
    return decryptSecret<WordPressCredentials>(result.rows[0].encrypted_value);
  } catch {
    return null;
  }
}

function authHeader(credentials: WordPressCredentials): string {
  const token = Buffer.from(`${credentials.username}:${credentials.application_password}`).toString("base64");
  return `Basic ${token}`;
}

export async function checkWordPressHealth(): Promise<{ healthy: boolean; siteName?: string; message: string }> {
  const credentials = await getWordPressCredentials();
  if (!credentials) {
    return { healthy: false, message: "WordPress credentials are not configured." };
  }

  try {
    const response = await fetch(`${credentials.url}/wp-json/wp/v2/users/me`, {
      headers: {
        Authorization: authHeader(credentials),
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return { healthy: false, message: `WordPress REST API responded with status ${response.status}.` };
    }

    const data = (await response.json()) as { id?: number; name?: string; slug?: string };
    return {
      healthy: true,
      siteName: data.name ?? data.slug ?? credentials.username,
      message: `Authenticated successfully as ${data.name ?? data.slug ?? credentials.username}`,
    };
  } catch (error) {
    return { healthy: false, message: error instanceof Error ? error.message : "Failed to connect to WordPress." };
  }
}

export async function createOrUpdateWordPressPage(page: {
  page_id?: number;
  title: string;
  content: string;
  slug?: string;
  status?: "draft" | "publish" | "pending" | "future" | "private";
}): Promise<{ id: number; link: string; updated: boolean }> {
  const credentials = await getWordPressCredentials();
  if (!credentials) throw new Error("WordPress credentials are not configured.");

  // If page_id is provided, update that specific page
  if (page.page_id) {
    const response = await fetch(`${credentials.url}/wp-json/wp/v2/pages/${page.page_id}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(credentials),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        title: page.title,
        content: page.content,
        status: page.status ?? "draft",
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`WordPress API error updating page ${page.page_id} (${response.status}): ${errorBody}`);
    }
    const data = (await response.json()) as { id: number; link: string };
    return { id: data.id, link: data.link, updated: true };
  }

  // Otherwise, search for an existing page with a matching title or slug
  const searchSlug = page.slug || page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  try {
    const searchResponse = await fetch(`${credentials.url}/wp-json/wp/v2/pages?search=${encodeURIComponent(page.title)}&per_page=5`, {
      headers: {
        Authorization: authHeader(credentials),
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (searchResponse.ok) {
      const existingPages = (await searchResponse.json()) as Array<{ id: number; link: string; title?: { rendered?: string }; slug?: string }>;
      const match = existingPages.find((p) => p.slug === searchSlug || p.title?.rendered?.toLowerCase() === page.title.toLowerCase());
      if (match) {
        // Update the existing page!
        const updateRes = await fetch(`${credentials.url}/wp-json/wp/v2/pages/${match.id}`, {
          method: "POST",
          headers: {
            Authorization: authHeader(credentials),
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            title: page.title,
            content: page.content,
            status: page.status ?? "draft",
          }),
        });
        if (updateRes.ok) {
          const data = (await updateRes.json()) as { id: number; link: string };
          return { id: data.id, link: data.link, updated: true };
        }
      }
    }
  } catch {
    // Continue to create if search fails
  }

  // Create new page
  const response = await fetch(`${credentials.url}/wp-json/wp/v2/pages`, {
    method: "POST",
    headers: {
      Authorization: authHeader(credentials),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      title: page.title,
      content: page.content,
      status: page.status ?? "draft",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WordPress API error creating page (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as { id: number; link: string };
  return { id: data.id, link: data.link, updated: false };
}

export async function createWordPressPost(post: {
  page_id?: number;
  title: string;
  content: string;
  slug?: string;
  status?: "draft" | "publish" | "pending" | "future" | "private";
}): Promise<{ id: number; link: string; updated?: boolean }> {
  // Delegate to createOrUpdateWordPressPage so all website landing pages are WordPress Pages
  const res = await createOrUpdateWordPressPage(post);
  return { id: res.id, link: res.link, updated: res.updated };
}
