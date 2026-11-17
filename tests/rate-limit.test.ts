import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake Upstash Redis: an in-memory store with incr/decr/expire and a switch
// to make every call fail (simulating an outage). Shared via vi.hoisted so the
// mocked module and the tests see the same instance.
// ---------------------------------------------------------------------------
const fake = vi.hoisted(() => {
  const state = {
    store: new Map<string, number>(),
    ttls: new Map<string, number>(),
    failing: false,
    calls: [] as string[],
  };
  class FakeRedis {
    constructor() {}
    private check(op: string, key: string) {
      state.calls.push(`${op} ${key}`);
      if (state.failing) throw new Error("redis down");
    }
    async incr(key: string) {
      this.check("incr", key);
      const v = (state.store.get(key) ?? 0) + 1;
      state.store.set(key, v);
      return v;
    }
    async decr(key: string) {
      this.check("decr", key);
      const v = (state.store.get(key) ?? 0) - 1;
      state.store.set(key, v);
      return v;
    }
    async expire(key: string, seconds: number) {
      this.check("expire", key);
      state.ttls.set(key, seconds);
      return 1;
    }
  }
  return { state, FakeRedis };
});

vi.mock("@upstash/redis", () => ({ Redis: fake.FakeRedis }));

type RateLimit = typeof import("../lib/rate-limit");

const ENV_KEYS = [
  "RATE_LIMIT_PER_MINUTE",
  "RATE_LIMIT_BURST",
  "RATE_LIMIT_CONCURRENCY_PER_UID",
  "RATE_LIMIT_CONCURRENCY_GLOBAL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];
const savedEnv: Record<string, string | undefined> = {};

async function load(env: Record<string, string> = {}): Promise<RateLimit> {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../lib/rate-limit");
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  fake.state.store.clear();
  fake.state.ttls.clear();
  fake.state.failing = false;
  fake.state.calls = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// In-memory limiter
// ---------------------------------------------------------------------------
describe("in-memory request rate (token bucket)", () => {
  it("allows the burst, then rejects", async () => {
    const rl = await load({ RATE_LIMIT_PER_MINUTE: "10", RATE_LIMIT_BURST: "5" });
    for (let i = 0; i < 5; i++) {
      expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    }
    const rejected = await rl.checkRequestRate("u1");
    expect(rejected.allowed).toBe(false);
    // 10/min = one token every 6s.
    expect(rejected.retryAfterSec).toBe(6);
  });

  it("refills over time at the per-minute rate", async () => {
    const rl = await load({ RATE_LIMIT_PER_MINUTE: "10", RATE_LIMIT_BURST: "5" });
    for (let i = 0; i < 5; i++) await rl.checkRequestRate("u1");
    expect((await rl.checkRequestRate("u1")).allowed).toBe(false);
    vi.advanceTimersByTime(6_000);
    expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    expect((await rl.checkRequestRate("u1")).allowed).toBe(false);
  });

  it("never refills above the burst size", async () => {
    const rl = await load({ RATE_LIMIT_PER_MINUTE: "10", RATE_LIMIT_BURST: "3" });
    await rl.checkRequestRate("u1");
    vi.advanceTimersByTime(60 * 60_000);
    for (let i = 0; i < 3; i++) {
      expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    }
    expect((await rl.checkRequestRate("u1")).allowed).toBe(false);
  });

  it("keeps buckets separate per uid", async () => {
    const rl = await load({ RATE_LIMIT_PER_MINUTE: "10", RATE_LIMIT_BURST: "1" });
    expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    expect((await rl.checkRequestRate("u1")).allowed).toBe(false);
    expect((await rl.checkRequestRate("u2")).allowed).toBe(true);
  });

  it("is disabled when per-minute or burst is 0", async () => {
    const rl = await load({ RATE_LIMIT_PER_MINUTE: "0", RATE_LIMIT_BURST: "5" });
    for (let i = 0; i < 50; i++) {
      expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    }
  });

  it("falls back to defaults for non-numeric env values", async () => {
    const rl = await load({ RATE_LIMIT_PER_MINUTE: "abc", RATE_LIMIT_BURST: "-3" });
    // defaults: burst 5
    for (let i = 0; i < 5; i++) {
      expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    }
    expect((await rl.checkRequestRate("u1")).allowed).toBe(false);
  });
});

describe("in-memory stream concurrency", () => {
  it("caps streams per uid and frees a slot on release", async () => {
    const rl = await load({ RATE_LIMIT_CONCURRENCY_PER_UID: "2", RATE_LIMIT_CONCURRENCY_GLOBAL: "10" });
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(false);
    expect((await rl.acquireStreamSlot("u2")).acquired).toBe(true);
    await rl.releaseStreamSlot("u1");
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(true);
  });

  it("caps streams globally", async () => {
    const rl = await load({ RATE_LIMIT_CONCURRENCY_PER_UID: "5", RATE_LIMIT_CONCURRENCY_GLOBAL: "2" });
    expect((await rl.acquireStreamSlot("a")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("b")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("c")).acquired).toBe(false);
    await rl.releaseStreamSlot("a");
    expect((await rl.acquireStreamSlot("c")).acquired).toBe(true);
  });

  it("does not let extra releases create free slots", async () => {
    const rl = await load({ RATE_LIMIT_CONCURRENCY_PER_UID: "1", RATE_LIMIT_CONCURRENCY_GLOBAL: "1" });
    await rl.releaseStreamSlot("a");
    await rl.releaseStreamSlot("a");
    expect((await rl.acquireStreamSlot("a")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("b")).acquired).toBe(false);
  });

  it("is unlimited when both caps are 0", async () => {
    const rl = await load({ RATE_LIMIT_CONCURRENCY_PER_UID: "0", RATE_LIMIT_CONCURRENCY_GLOBAL: "0" });
    for (let i = 0; i < 20; i++) {
      expect((await rl.acquireStreamSlot("u1")).acquired).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Redis limiter
// ---------------------------------------------------------------------------
const REDIS_ENV = {
  UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "t",
  RATE_LIMIT_PER_MINUTE: "10",
  RATE_LIMIT_BURST: "5",
  RATE_LIMIT_CONCURRENCY_PER_UID: "2",
  RATE_LIMIT_CONCURRENCY_GLOBAL: "3",
};

describe("Redis request rate (fixed window)", () => {
  it("counts in a per-minute window and sets a TTL on first use", async () => {
    // Burst = per-minute, so only the one-minute window limits here.
    const rl = await load({ ...REDIS_ENV, RATE_LIMIT_BURST: "10" });
    for (let i = 0; i < 10; i++) {
      expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
    }
    const rejected = await rl.checkRequestRate("u1");
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSec).toBe(60); // window just started at :00
    expect([...fake.state.ttls.keys()].some((k) => k.startsWith("rl:rate:u1:"))).toBe(true);
  });

  it("starts a fresh count in the next window", async () => {
    const rl = await load(REDIS_ENV);
    for (let i = 0; i < 11; i++) await rl.checkRequestRate("u1");
    vi.advanceTimersByTime(60_000);
    expect((await rl.checkRequestRate("u1")).allowed).toBe(true);
  });

  // Regression (fixed today): RATE_LIMIT_BURST is ignored in Redis mode. The PRD/README describe a
  // token bucket with burst 5; the Redis backend lets PER_MINUTE (10) requests
  // through back-to-back, so the same config behaves differently once
  // Upstash is configured.
  it("honours RATE_LIMIT_BURST like the in-memory limiter", async () => {
    const rl = await load(REDIS_ENV);
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push((await rl.checkRequestRate("u1")).allowed);
    expect(results).toEqual([true, true, true, true, true, false]);
  });
});

describe("Redis stream concurrency", () => {
  it("caps per uid, rolls back both counters on overflow, and releases", async () => {
    const rl = await load(REDIS_ENV);
    await rl.checkRequestRate("init"); // the backend is created on the first rate check
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("u1")).acquired).toBe(false);
    expect(fake.state.store.get("rl:conc:u1")).toBe(2);
    expect(fake.state.store.get("rl:conc:global")).toBe(2);
    await rl.releaseStreamSlot("u1");
    expect(fake.state.store.get("rl:conc:u1")).toBe(1);
    expect(fake.state.store.get("rl:conc:global")).toBe(1);
  });

  it("caps globally across uids", async () => {
    const rl = await load(REDIS_ENV);
    await rl.checkRequestRate("init");
    expect((await rl.acquireStreamSlot("a")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("b")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("c")).acquired).toBe(true);
    expect((await rl.acquireStreamSlot("d")).acquired).toBe(false);
    expect(fake.state.store.get("rl:conc:d")).toBe(0);
  });

  // Regression (fixed today): acquire/release only use Redis after checkRequestRate has run once,
  // because the backend is lazily created inside checkRate(). The route always
  // calls checkRequestRate first, so in practice this is masked, but a slot
  // acquired before any rate check goes to the in-memory limiter.
  it("uses Redis for slots even before the first rate check", async () => {
    const rl = await load(REDIS_ENV);
    await rl.acquireStreamSlot("u1");
    expect(fake.state.store.get("rl:conc:u1")).toBe(1);
  });

  // Regression (fixed today): release() decrements without a floor. If the key expired (TTL 300s)
  // while a long stream was running, release drives the counter to -1, which
  // then grants one extra slot above the cap.
  it("never lets a counter go negative after its key expired", async () => {
    const rl = await load(REDIS_ENV);
    await rl.checkRequestRate("init");
    await rl.acquireStreamSlot("u1");
    // Simulate TTL expiry of both keys while the stream was in flight.
    fake.state.store.delete("rl:conc:u1");
    fake.state.store.delete("rl:conc:global");
    await rl.releaseStreamSlot("u1");
    expect(fake.state.store.get("rl:conc:u1") ?? 0).toBeGreaterThanOrEqual(0);
    expect(fake.state.store.get("rl:conc:global") ?? 0).toBeGreaterThanOrEqual(0);
  });

  // Regression (fixed today): every successful acquire refreshes the TTL on the single shared
  // global key. A slot leaked by a crashed instance (never released) is
  // therefore never expired while other traffic keeps arriving, and the
  // global cap fills up permanently (all users get 503).
  it("does not keep leaked global slots alive by refreshing one shared TTL", async () => {
    const rl = await load(REDIS_ENV);
    await rl.checkRequestRate("init");
    await rl.acquireStreamSlot("crashed"); // never released
    // The leaked slot's own TTL would expire after 300s...
    vi.advanceTimersByTime(299_000);
    // ...but another user's acquire re-arms the shared key's TTL.
    fake.state.ttls.delete("rl:conc:global");
    await rl.acquireStreamSlot("other");
    await rl.releaseStreamSlot("other");
    // The global key now has a fresh TTL while still counting the leaked slot.
    const leakedStillCounted = fake.state.store.get("rl:conc:global") === 1;
    const ttlRefreshed = fake.state.ttls.has("rl:conc:global");
    expect(leakedStillCounted && ttlRefreshed).toBe(false);
  });
});

describe("Redis outage handling", () => {
  it("falls back to the in-memory limiter when Redis fails", async () => {
    const rl = await load(REDIS_ENV);
    fake.state.failing = true;
    const r = await rl.checkRequestRate("u1");
    expect(r.allowed).toBe(true); // memory bucket starts full
    // in-memory burst of 5 now applies
    for (let i = 0; i < 4; i++) await rl.checkRequestRate("u1");
    expect((await rl.checkRequestRate("u1")).allowed).toBe(false);
  });

  // Regression (fixed today): after a single Redis error the backend is marked down forever
  // (markDown has no recovery). Once Redis is healthy again the instance keeps
  // using per-instance memory limits until it restarts.
  it("retries Redis after it recovers", async () => {
    const rl = await load(REDIS_ENV);
    fake.state.failing = true;
    await rl.checkRequestRate("u1");
    fake.state.failing = false;
    fake.state.calls = [];
    vi.advanceTimersByTime(5 * 60_000);
    await rl.checkRequestRate("u1");
    expect(fake.state.calls.some((c) => c.startsWith("incr rl:rate:u1"))).toBe(true);
  });

  // Regression (fixed today): a slot acquired in Redis is released into the in-memory limiter if
  // Redis is marked down in between, so the Redis counters are never
  // decremented (leaked slots on the shared store).
  it("releases a Redis-acquired slot in Redis even if a later call failed", async () => {
    const rl = await load(REDIS_ENV);
    await rl.checkRequestRate("init");
    await rl.acquireStreamSlot("u1");
    expect(fake.state.store.get("rl:conc:u1")).toBe(1);
    // A different request's rate check fails once -> backend marked down.
    fake.state.failing = true;
    await rl.checkRequestRate("u2");
    fake.state.failing = false;
    await rl.releaseStreamSlot("u1");
    expect(fake.state.store.get("rl:conc:u1")).toBe(0);
  });

  // Regression (fixed today): if the per-uid incr succeeds but the global incr fails, the per-uid
  // counter is left incremented in Redis (no rollback) and the request falls
  // back to the memory limiter.
  it("rolls back the per-uid counter when the global incr fails", async () => {
    const rl = await load(REDIS_ENV);
    await rl.checkRequestRate("init");
    let n = 0;
    const origIncr = fake.FakeRedis.prototype.incr;
    vi.spyOn(fake.FakeRedis.prototype, "incr").mockImplementation(async function (this: unknown, key: string) {
      n++;
      if (key === "rl:conc:global") throw new Error("redis blip");
      return origIncr.call(this, key);
    });
    await rl.acquireStreamSlot("u1");
    expect(n).toBeGreaterThan(0);
    expect(fake.state.store.get("rl:conc:u1") ?? 0).toBe(0);
  });
});
