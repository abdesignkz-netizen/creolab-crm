import { ApiError } from "../errors.ts";

export type RateLimitHit = { allowed: boolean; count: number };

export type RateLimitStore = {
  hit(key: string, limit: number, windowMs: number): RateLimitHit;
  reset(): void;
};

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; reset: number }>();

  private readonly maxBuckets: number;
  private readonly clock: () => number;
  constructor(maxBuckets = 20_000, clock = Date.now) {
    this.maxBuckets = maxBuckets;
    this.clock = clock;
  }
  private nextSweep = 0;

  hit(key: string, limit: number, windowMs: number): RateLimitHit {
    const now = this.clock();
    if (now >= this.nextSweep) {
      for (const [id, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(id);
      this.nextSweep = now + Math.min(60_000, windowMs);
    }
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      // Do not evict an active limiter: an attacker could otherwise reset it with new keys.
      if (!bucket && this.buckets.size >= this.maxBuckets) return { allowed: false, count: limit + 1 };
      this.buckets.set(key, { count: 1, reset: now + windowMs });
      return { allowed: true, count: 1 };
    }
    bucket.count = Math.min(bucket.count + 1, limit + 1);
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
