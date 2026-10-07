export const OWNER_SESSION_COOKIE = "companyos_owner_session";
export const OWNER_SESSION_SECONDS = 12 * 60 * 60;

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function verifyOwnerToken(candidate: string, expected = process.env.COMPANYOS_ADMIN_TOKEN) {
  if (!expected || !candidate) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function createOwnerSession(secret = process.env.COMPANYOS_ADMIN_TOKEN) {
  if (!secret) throw new Error("COMPANYOS_ADMIN_TOKEN is not configured.");
  const expiresAt = Math.floor(Date.now() / 1000) + OWNER_SESSION_SECONDS;
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const payload = `v1.${expiresAt}.${nonce}`;
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyOwnerSession(value: string | undefined, secret = process.env.COMPANYOS_ADMIN_TOKEN) {
  if (!value || !secret || value.length > 256) return false;
  const [version, expiry, nonce, signature, ...extra] = value.split(".");
  if (version !== "v1" || !expiry || !nonce || !signature || extra.length || !/^\d{10}$/.test(expiry)) return false;
  const expiresAt = Number(expiry);
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now || expiresAt > now + OWNER_SESSION_SECONDS) return false;
  try {
    const payload = `${version}.${expiry}.${nonce}`;
    return await crypto.subtle.verify("HMAC", await sessionKey(secret), decodeBase64Url(signature), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}
