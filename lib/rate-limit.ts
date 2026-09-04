// In-memory rate limiter for the /api/chat route.
//
// Two limits, both per Firebase UID:
//
//   1. Token bucket on requests (checkRequestRate).
//      Smooths bursts while capping sustained rate. Default 10/min
//      with a burst of 5. The bucket is lazy-refilled on each call;
//      no background timer.
//
//   2. Concurrency cap on in-flight streams (acquireStreamSlot /
//      releaseStreamSlot). Default 2 per UID, 10 globally. Once a
//      request is past the rate check, what matters for protecting the
//      local model server is how many connections that UID is holding open.
//
// LIMITATIONS (intentional, for a personal project):
//
//   - State is in-process. On a single server this is fine. On
//     serverless (Vercel), each cold start gets a fresh Map, so the
//     limit becomes "per-instance, resets on cold start." Strictly
//     better than no limit and acceptable for a personal project.
//
//   - When the project goes live at scale, swap this module for a
//     Redis-backed implementation (e.g. Upstash free tier). The
//     chat route's callsites don't change — they take a UID and
//     return { allowed, retryAfterSec } or { acquired }.
//
//   - Unauthenticated traffic is NOT rate-limited here. The auth
//     roundtrip (verifyAccessToken) is itself a global rate limit on
//     unauthenticated bursts — each attempt is a fetch to Google.
//
//   - All limits are env-var tunable. Defaults are loose enough that
//     a real user chatting normally never hits them.

type Bucket = { tokens: number; lastRefill: number };

const requestBuckets = new Map<string, Bucket>();
const streamCounts = new Map<string, number>();

let globalStreamCount = 0;

// Periodic GC so the Maps don't grow unboundedly with abandoned UIDs.
// Runs every 10 minutes. Buckets that have refilled to burst capacity
// and have not been touched in an hour are dropped; idle stream
// counts (shouldn't happen because releaseStreamSlot runs in
// finally, but defense in depth) are dropped too.
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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function checkRequestRate(
  uid: string
): { allowed: boolean; retryAfterSec: number } {
  scheduleGc();

  const perMinute = envInt("RATE_LIMIT_PER_MINUTE", 10);
  const burst = envInt("RATE_LIMIT_BURST", 5);

  // Zero / negative config means "off".
  if (perMinute <= 0 || burst <= 0) {
    return { allowed: true, retryAfterSec: 0 };
  }

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
    // Time until the bucket has 1 full token.
    const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000));
    return { allowed: false, retryAfterSec };
  }

  bucket.tokens -= 1;
  return { allowed: true, retryAfterSec: 0 };
}

export function acquireStreamSlot(
  uid: string
): { acquired: boolean } {
  scheduleGc();

  const perUid = envInt("RATE_LIMIT_CONCURRENCY_PER_UID", 2);
  const global = envInt("RATE_LIMIT_CONCURRENCY_GLOBAL", 10);

  // Zero / negative config means "off".
  if (perUid <= 0 && global <= 0) {
    return { acquired: true };
  }

  const current = streamCounts.get(uid) ?? 0;
  if ((perUid > 0 && current >= perUid) || (global > 0 && globalStreamCount >= global)) {
    return { acquired: false };
  }

  streamCounts.set(uid, current + 1);
  globalStreamCount += 1;
  return { acquired: true };
}

export function releaseStreamSlot(uid: string): void {
  const current = streamCounts.get(uid) ?? 0;
  if (current <= 1) {
    streamCounts.delete(uid);
  } else {
    streamCounts.set(uid, current - 1);
  }
  globalStreamCount = Math.max(0, globalStreamCount - 1);
}
