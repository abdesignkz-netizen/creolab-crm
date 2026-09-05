import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function hmacSha256Hex(secret: string, value: string | Buffer) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cursorPage(limit?: string | number) {
  const n = Number(limit || 30);
  return Math.min(100, Math.max(1, Number.isFinite(n) ? n : 30));
}
