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
// After a Redis error, use the in-memory limiter for this long, then try
// Redis again (instead of staying on memory until the instance restarts).
const REDIS_RETRY_MS = 30_000;

// Fixed-window counter: increments `key` and sets its TTL when the key is
// created. Returns the new count.
async function incrWindow(redis: Redis, key: string, ttlSec: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSec).catch(() => {});
  }
  return count;
}

class RedisLimiterBackend {
  private redis: Redis;
  private downUntil = 0;

  constructor() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url) {
      throw new Error("UPSTASH_REDIS_REST_URL is required for the Redis limiter.");
    }
    this.redis = new Redis({ url, token });
  }

  // Two fixed windows approximate the in-memory token bucket:
  //   - per minute: at most RATE_LIMIT_PER_MINUTE requests;
  //   - burst: at most RATE_LIMIT_BURST requests per (burst / rate) — the
  //     time the bucket takes to refill — so a burst can't use the whole
  //     minute's allowance back-to-back.
  async checkRate(uid: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
    if (limitsDisabled()) return { allowed: true, retryAfterSec: 0 };

    const perMinute = PER_MINUTE();
    const burst = BURST();
    const now = Date.now();
    const burstWindowMs = Math.max(1_000, Math.round((burst * WINDOW_MS) / perMinute));

    const minuteCount = await incrWindow(
      this.redis,
      `rl:rate:${uid}:${Math.floor(now / WINDOW_MS)}`,
      RATE_KEY_TTL_S
    );
    const burstCount = await incrWindow(
      this.redis,
      `rl:burst:${uid}:${Math.floor(now / burstWindowMs)}`,
      Math.ceil((2 * burstWindowMs) / 1000)
    );

    const waits: number[] = [];
    if (minuteCount > perMinute) waits.push(WINDOW_MS - (now % WINDOW_MS));
    if (burstCount > burst) waits.push(burstWindowMs - (now % burstWindowMs));
    if (waits.length > 0) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(Math.max(...waits) / 1000)) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  async acquire(uid: string): Promise<{ acquired: boolean }> {
    const perUid = CONCURRENCY_PER_UID();
    const global = CONCURRENCY_GLOBAL();
    const perKey = `rl:conc:${uid}`;
    const globalKey = "rl:conc:global";

    // The TTL is set only when a key is created, never refreshed. A slot
    // leaked by a crashed instance therefore clears when the key expires,
    // instead of being kept alive forever by other users' traffic.
    const perCount = await incrWindow(this.redis, perKey, CONCURRENCY_KEY_TTL_S);
    let globalCount: number;
    try {
      globalCount = await incrWindow(this.redis, globalKey, CONCURRENCY_KEY_TTL_S);
    } catch (err) {
      // Undo the per-uid increment so it doesn't leak, then let the caller
      // fall back to the in-memory limiter.
      await this.decrFloored(perKey).catch(() => {});
      throw err;
    }

    const overPerUid = perUid > 0 && perCount > perUid;
    const overGlobal = global > 0 && globalCount > global;
    if (overPerUid || overGlobal) {
      await this.decrFloored(perKey);
      await this.decrFloored(globalKey);
      return { acquired: false };
    }
    return { acquired: true };
  }

  async release(uid: string): Promise<void> {
    await this.decrFloored(`rl:conc:${uid}`);
    await this.decrFloored("rl:conc:global");
  }

  // Decrements without going below 0. A key can expire while a long stream
  // is running; a plain decrement would then go to -1 and grant one slot
  // above the cap.
  private async decrFloored(key: string): Promise<void> {
    const value = await this.redis.decr(key);
    if (value < 0) await this.redis.incr(key);
  }

  markDown(): void {
    this.downUntil = Date.now() + REDIS_RETRY_MS;
  }

  isDown(): boolean {
    return Date.now() < this.downUntil;
  }
}

// ---------------------------------------------------------------------------
// Selection layer (matches the exported API used by pages/api/chat.ts)
// ---------------------------------------------------------------------------

// Created lazily on first use of ANY limiter call (env is fully loaded by
// then). null when Redis isn't configured or failed to initialise.
let redisBackend: RedisLimiterBackend | null | undefined;

function getRedis(): RedisLimiterBackend | null {
  if (redisBackend === undefined) {
    redisBackend = null;
    if (process.env.UPSTASH_REDIS_REST_URL) {
      try {
        redisBackend = new RedisLimiterBackend();
        logger.info("Using shared Upstash Redis rate limiter");
      } catch (err) {
        logger.warn("Failed to init Upstash Redis limiter; using in-memory fallback", err);
      }
    }
  }
  return redisBackend && !redisBackend.isDown() ? redisBackend : null;
}

// Slots each uid currently holds in Redis, so a slot is released in the
// backend that granted it even if Redis was marked down in between.
const redisSlots = new Map<string, number>();

async function checkRate(uid: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const redis = getRedis();
  if (redis) {
    try {
      return await redis.checkRate(uid);
    } catch (err) {
      logger.error("Redis rate check failed; falling back to in-memory limiter", err);
      redis.markDown();
    }
  }
  return memoryRate(uid);
}

async function acquire(uid: string): Promise<{ acquired: boolean }> {
  const perUid = CONCURRENCY_PER_UID();
  const global = CONCURRENCY_GLOBAL();
  if (perUid <= 0 && global <= 0) return { acquired: true };

  const redis = getRedis();
  if (redis) {
    try {
      const result = await redis.acquire(uid);
      if (result.acquired) redisSlots.set(uid, (redisSlots.get(uid) ?? 0) + 1);
      return result;
    } catch (err) {
      logger.error("Redis acquire failed; falling back to in-memory limiter", err);
      redis.markDown();
    }
  }
  return memoryAcquire(uid);
}

async function release(uid: string): Promise<void> {
  const held = redisSlots.get(uid) ?? 0;
  if (held > 0) {
    if (held === 1) redisSlots.delete(uid);
    else redisSlots.set(uid, held - 1);
    // Released in Redis even if it was marked down since; if Redis is still
    // unreachable the key's TTL recovers the slot.
    if (redisBackend) {
      try {
        await redisBackend.release(uid);
      } catch (err) {
        logger.error("Redis release failed; slot will be recovered by its TTL", err);
        redisBackend.markDown();
      }
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
