/**
 * Brand kit extraction: read a business website and propose a brand kit
 * (Lead Desk model — "paste the website, the agency reads it"). The parser
 * is pure so it is unit-testable; the API route fetches the page and the
 * owner reviews the proposal before saving. Nothing here persists data.
 */

export type BrandExtraction = {
  website_url: string;
  logo_url: string;
  colors: string[];
  fonts: string[];
  phone: string;
  instagram_username: string;
  tagline: string;
};

const RESERVED_INSTAGRAM_PATHS = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv", "highlights", "about", "developer", "legal"]);

/** Accept only public http(s) URLs: no localhost, no private/link-local IP
 *  literals, no credentials. Returns the normalized URL or null. */
export function validateWebsiteUrl(raw: string): string | null {
  let candidate = raw.trim();
  // Owners paste bare domains ("example.com") as often as full URLs; treat a
  // scheme-less, space-less host with a dot as https. Anything else without a
  // scheme stays invalid, and explicit non-http(s) schemes are still rejected
  // by the protocol check below.
  if (candidate && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate) && !/\s/.test(candidate) && candidate.includes(".")) {
    candidate = `https://${candidate}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") return null;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return null;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return null;
  return url.toString();
}

function metaContent(html: string, key: string): string {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(pattern)?.[0];
  if (!tag) return "";
  return (tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "").trim();
}

function resolveUrl(candidate: string, base: string): string {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return "";
  }
}

function normalizeHex(hex: string): string {
  const value = hex.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(value)) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return value;
}

export function extractBrandFromHtml(html: string, pageUrl: string): BrandExtraction {
  // Logo: Open Graph image first (usually the brand mark or hero), then icon.
  let logo = metaContent(html, "og:image");
  if (!logo) {
    const iconTag = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i)?.[0];
    logo = iconTag?.match(/href=["']([^"']+)["']/i)?.[1] ?? "";
  }

  // Colors: theme-color plus the most frequent hex colors in style content.
  const colorCounts = new Map<string, number>();
  const theme = metaContent(html, "theme-color");
  if (/^#[0-9a-f]{3,8}$/i.test(theme)) colorCounts.set(normalizeHex(theme.slice(0, 7)), 100);
  const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + "\n" +
    [...html.matchAll(/style=["']([^"']*)["']/gi)].map((m) => m[1]).join("\n");
  for (const match of styleText.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
    const hex = normalizeHex(match[0]);
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }
  const colors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([hex]) => hex);

  // Fonts: Google Fonts families, then font-family declarations.
  const fonts: string[] = [];
  const addFont = (name: string) => {
    const cleaned = name.replace(/["']/g, "").split(",")[0].trim();
    if (cleaned && cleaned.length <= 60 && !/^(inherit|initial|sans-serif|serif|monospace|system-ui)$/i.test(cleaned) && !fonts.includes(cleaned)) fonts.push(cleaned);
  };
  for (const match of html.matchAll(/fonts\.googleapis\.com\/css2?\?[^"']+/gi)) {
    for (const family of new URLSearchParams(match[0].split("?")[1] ?? "").getAll("family")) addFont(family.split(":")[0].replace(/\+/g, " "));
  }
  for (const match of styleText.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) addFont(match[1]);
  // fonts is capped below after both sources merge.

  // Phone: first US-style number in the page text.
  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const phone = textOnly.match(/(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/)?.[0] ?? "";

  // Instagram: first profile link that is not a post/reel/system path.
  let instagram = "";
  for (const match of html.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?:["'?#\s]|$)/gi)) {
    const handle = match[1].replace(/\.$/, "");
    if (!RESERVED_INSTAGRAM_PATHS.has(handle.toLowerCase())) { instagram = handle; break; }
  }

  // Tagline: site name or the title's leading segment.
  const siteName = metaContent(html, "og:site_name");
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const tagline = (siteName || title.split(/[|»–—-]/)[0].trim()).slice(0, 120);

  return {
    website_url: pageUrl,
    logo_url: logo ? resolveUrl(logo, pageUrl) : "",
    colors,
    fonts: fonts.slice(0, 4),
    phone,
    instagram_username: instagram,
    tagline,
  };
}
