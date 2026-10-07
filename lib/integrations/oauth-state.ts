import crypto from "node:crypto";
import { randomToken } from "../secrets";

function signingKey() {
  const raw = process.env.COMPANYOS_ENCRYPTION_KEY;
  if (!raw) throw new Error("COMPANYOS_ENCRYPTION_KEY is not configured.");
  return crypto.createHash("sha256").update(raw).digest();
}

export function createSignedState() {
  const value = randomToken(24);
  const signature = crypto.createHmac("sha256", signingKey()).update(value).digest("base64url");
  return `${value}.${signature}`;
}

export function verifySignedState(value: string) {
  const [state, signature] = value.split(".");
  if (!state || !signature) return false;
  const expected = crypto.createHmac("sha256", signingKey()).update(state).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
