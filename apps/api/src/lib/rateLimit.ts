import { ApiError } from "../errors.ts";

export type RateLimitHit = { allowed: boolean; count: number };

export type RateLimitStore = {
  hit(key: string, limit: number, windowMs: number): RateLimitHit;
  reset(): void;
};

class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; reset: number }>();

  hit(key: string, limit: number, windowMs: number): RateLimitHit {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.reset < now) {
      this.buckets.set(key, { count: 1, reset: now + windowMs });
      return { allowed: true, count: 1 };
    }
    bucket.count += 1;
    return { allowed: bucket.count <= limit, count: bucket.count };
  }

  reset() {
    this.buckets.clear();
  }
}

let store: RateLimitStore = new MemoryRateLimitStore();

export function setRateLimitStore(next: RateLimitStore) {
  store = next;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000) {
  const result = store.hit(key, limit, windowMs);
  if (!result.allowed) {
    throw new ApiError(429, "rate_limited", "Слишком много запросов");
  }
}

export function resetRateLimits() {
  store.reset();
}

/** Client IP after Express trust proxy. Never read X-Forwarded-For here. */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}
