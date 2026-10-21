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
      url: envUrl.replace(/\/+$/, ""),
      username: envUser,
      application_password: envPass,
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

export async function createWordPressPost(post: {
  title: string;
  content: string;
  status?: "draft" | "publish" | "pending" | "future" | "private";
}): Promise<{ id: number; link: string }> {
  const credentials = await getWordPressCredentials();
  if (!credentials) throw new Error("WordPress credentials are not configured.");

  const response = await fetch(`${credentials.url}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: authHeader(credentials),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      title: post.title,
      content: post.content,
      status: post.status ?? "draft",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WordPress API error (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as { id: number; link: string };
  return { id: data.id, link: data.link };
}
