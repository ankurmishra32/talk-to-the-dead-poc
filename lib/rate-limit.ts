// Rate limiting for the /api/chat route.
//
// Two limits, both keyed on a verified Firebase UID:
//
//   1. Token bucket / fixed-window cap on requests (checkRequestRate).
//      Default 10/min with a burst of 5. Smooths typical chatting while
//      capping sustained scripted abuse.
//
//   2. Concurrency cap on in-flight streams (acquireStreamSlot /
//      releaseStreamSlot). Default 2 per UID, 10 globally. Once a request
//      is past the rate check, what matters for protecting the model server
//      is how many connections that UID (and the server overall) holds open.
//
// Backend selection (CHANGED for serverless):
//
//   - If UPSTASH_REDIS_REST_URL is set (and optionally
//     UPSTASH_REDIS_REST_TOKEN), limits are enforced with a shared Upstash
//     Redis store, so the counters are the same across every serverless
//     instance instead of resetting on each cold start. See DEPLOYMENT.md.
//
//   - If Redis is not configured, or a Redis call fails, we fall back to the
//     in-process limiter. On a single server (local dev) that is exact. On
//     serverless it degrades to "per-instance, resets on cold start" —
//     strictly better than no limit, and the app never breaks because Redis
//     is down.
//
// The chat route's callsites don't change: they take a UID and receive
// { allowed, retryAfterSec } or { acquired }.
//
// All limits are env-var tunable. Defaults are loose enough that a real user
// chatting normally never hits them. Setting a limit to 0 / negative disables
// it (mirrors the in-memory behavior).

import { Redis } from "@upstash/redis";
import { createLogger } from "./logger";

const logger = createLogger("rate-limit");

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const PER_MINUTE = () => envInt("RATE_LIMIT_PER_MINUTE", 10);
const BURST = () => envInt("RATE_LIMIT_BURST", 5);
const CONCURRENCY_PER_UID = () => envInt("RATE_LIMIT_CONCURRENCY_PER_UID", 2);
const CONCURRENCY_GLOBAL = () => envInt("RATE_LIMIT_CONCURRENCY_GLOBAL", 10);

function limitsDisabled(): boolean {
  return PER_MINUTE() <= 0 || BURST() <= 0;
}

// ---------------------------------------------------------------------------
// In-memory backend (fallback / local dev)
// ---------------------------------------------------------------------------

type Bucket = { tokens: number; lastRefill: number };

const requestBuckets = new Map<string, Bucket>();
const streamCounts = new Map<string, number>();
let globalStreamCount = 0;

const GC_INTERVAL_MS = 10 * 60 * 1000;
const IDLE_BUCKET_MS = 60 * 60 * 1000;
let gcScheduled = false;

function scheduleGc(): void {
  if (gcScheduled) return;
  gcScheduled = true;
  setInterval(() => {
    const now = Date.now();
    for (const [uid, bucket] of requestBuckets) {
      if (now - bucket.lastRefill > IDLE_BUCKET_MS) {
        requestBuckets.delete(uid);
      }
    }
    for (const [uid, count] of streamCounts) {
      if (count <= 0) streamCounts.delete(uid);
    }
  }, GC_INTERVAL_MS).unref?.();
}

const memoryRate = (uid: string): { allowed: boolean; retryAfterSec: number } => {
  if (limitsDisabled()) return { allowed: true, retryAfterSec: 0 };

  scheduleGc();
  const perMinute = PER_MINUTE();
  const burst = BURST();
  const now = Date.now();
  const ratePerMs = perMinute / 60_000;

  let bucket = requestBuckets.get(uid);
  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    requestBuckets.set(uid, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * ratePerMs);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000));
    return { allowed: false, retryAfterSec };
  }

  bucket.tokens -= 1;
  return { allowed: true, retryAfterSec: 0 };
};

const memoryAcquire = (uid: string): { acquired: boolean } => {
  scheduleGc();
  const perUid = CONCURRENCY_PER_UID();
  const global = CONCURRENCY_GLOBAL();
  if (perUid <= 0 && global <= 0) return { acquired: true };

  const current = streamCounts.get(uid) ?? 0;
  if ((perUid > 0 && current >= perUid) || (global > 0 && globalStreamCount >= global)) {
    return { acquired: false };
  }

  streamCounts.set(uid, current + 1);
  globalStreamCount += 1;
  return { acquired: true };
};

const memoryRelease = (uid: string): void => {
  const current = streamCounts.get(uid) ?? 0;
  if (current <= 1) {
    streamCounts.delete(uid);
  } else {
    streamCounts.set(uid, current - 1);
  }
  globalStreamCount = Math.max(0, globalStreamCount - 1);
};

// ---------------------------------------------------------------------------
// Upstash Redis backend (shared across serverless instances)
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;
const RATE_KEY_TTL_S = 120;
const CONCURRENCY_KEY_TTL_S = 300;

class RedisLimiterBackend {
  private redis: Redis;
  private down = false;

  constructor() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url) {
      throw new Error("UPSTASH_REDIS_REST_URL is required for the Redis limiter.");
    }
    this.redis = new Redis({ url, token });
  }

  private isRateEnabled(): boolean {
    return !limitsDisabled();
  }

  private isConcurrencyEnabled(): boolean {
    const perUid = CONCURRENCY_PER_UID();
    const global = CONCURRENCY_GLOBAL();
    return perUid > 0 || global > 0;
  }

  async checkRate(uid: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
    if (!this.isRateEnabled()) return { allowed: true, retryAfterSec: 0 };

    const now = Date.now();
    const window = Math.floor(now / WINDOW_MS);
    const key = `rl:rate:${uid}:${window}`;

    // Fixed window: INCR then, on the first hit, set a TTL so the key
    // doesn't accumulate. The window changes every minute, so old keys are
    // simply never touched again and expire via TTL.
    const count = await this.redis.incr(key);
    if (count === 1) {
      // Best effort — an EXPIRE failure is not fatal.
      await this.redis.expire(key, RATE_KEY_TTL_S).catch(() => {});
    }

    if (count > PER_MINUTE()) {
      const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000));
      return { allowed: false, retryAfterSec };
    }

    return { allowed: true, retryAfterSec: 0 };
  }

  async acquire(uid: string): Promise<{ acquired: boolean }> {
    const perUid = CONCURRENCY_PER_UID();
    const global = CONCURRENCY_GLOBAL();
    if (perUid <= 0 && global <= 0) return { acquired: true };

    const perKey = `rl:conc:${uid}`;
    const globalKey = "rl:conc:global";

    const perCount = await this.redis.incr(perKey);
    const globalCount = await this.redis.incr(globalKey);

    const overPerUid = perUid > 0 && perCount > perUid;
    const overGlobal = global > 0 && globalCount > global;

    if (overPerUid || overGlobal) {
      // Roll back both counters so accounting stays balanced.
      await this.redis.decr(perKey);
      await this.redis.decr(globalKey);
      return { acquired: false };
    }

    // Refresh TTL on the held slots (best effort).
    await this.redis.expire(perKey, CONCURRENCY_KEY_TTL_S).catch(() => {});
    await this.redis.expire(globalKey, CONCURRENCY_KEY_TTL_S).catch(() => {});

    return { acquired: true };
  }

  async release(uid: string): Promise<void> {
    await this.redis.decr(`rl:conc:${uid}`);
    await this.redis.decr("rl:conc:global");
  }

  // Marks the backend as down after a failure so we stop hammering it.
  markDown(): void {
    this.down = true;
  }

  isDown(): boolean {
    return this.down;
  }
}

// ---------------------------------------------------------------------------
// Selection layer (matches the exported API used by pages/api/chat.ts)
// ---------------------------------------------------------------------------

// Redis gains are only realized when a shared store is actually configured.
// We pick lazily on first use (env is fully loaded by then) and fall back to
// the in-memory limiter if Redis is absent or fails.
let usingRedis = false;
let redisBackend: RedisLimiterBackend | null = null;

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL);
}

async function checkRate(uid: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  if (redisConfigured() && !usingRedis) {
    try {
      redisBackend = new RedisLimiterBackend();
      usingRedis = true;
      logger.info("Using shared Upstash Redis rate limiter");
    } catch (err) {
      logger.warn("Failed to init Upstash Redis limiter; using in-memory fallback", err);
      usingRedis = false;
    }
  }

  if (usingRedis && redisBackend && !redisBackend.isDown()) {
    try {
      return await redisBackend.checkRate(uid);
    } catch (err) {
      logger.error("Redis rate check failed; falling back to in-memory limiter", err);
      redisBackend.markDown();
    }
  }

  return memoryRate(uid);
}

async function acquire(uid: string): Promise<{ acquired: boolean }> {
  if (usingRedis && redisBackend && !redisBackend.isDown()) {
    try {
      return await redisBackend.acquire(uid);
    } catch (err) {
      logger.error("Redis acquire failed; falling back to in-memory limiter", err);
      redisBackend.markDown();
    }
  }

  return memoryAcquire(uid);
}

async function release(uid: string): Promise<void> {
  if (usingRedis && redisBackend && !redisBackend.isDown()) {
    try {
      await redisBackend.release(uid);
    } catch (err) {
      logger.error("Redis release failed; falling back to in-memory limiter", err);
      redisBackend.markDown();
    }
    return;
  }

  memoryRelease(uid);
}

export async function checkRequestRate(
  uid: string
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  return checkRate(uid);
}

export async function acquireStreamSlot(uid: string): Promise<{ acquired: boolean }> {
  return acquire(uid);
}

export async function releaseStreamSlot(uid: string): Promise<void> {
  return release(uid);
}
