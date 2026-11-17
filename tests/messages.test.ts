import { describe, it, expect } from "vitest";
import {
  appendUniqueMessage,
  mapMessageDocs,
  reconcileMessages,
  isPersistedId,
  trimHistory,
  toMillis,
  settledReplies,
  swapMessageId,
} from "../lib/messages";
import type {
  ChatMessage,
  FirestoreDocLike,
  FirestoreChangeLike,
} from "../lib/types";

function snap(
  id: string,
  data: { role?: string; content?: string; createdAt?: unknown; interrupted?: unknown }
): FirestoreDocLike {
  return { id, data: () => data };
}

function change(
  type: FirestoreChangeLike["type"],
  doc: FirestoreDocLike
): FirestoreChangeLike {
  return { type, doc };
}

describe("isPersistedId", () => {
  it("returns false for undefined", () => {
    expect(isPersistedId(undefined)).toBe(false);
  });

  it("returns false for local- prefixed ids", () => {
    expect(isPersistedId("local-123")).toBe(false);
  });

  it("returns true for real Firestore ids", () => {
    expect(isPersistedId("abc123")).toBe(true);
  });
});

describe("mapMessageDocs", () => {
  it("maps valid docs and reverses desc order to chronological", () => {
    const docs = [
      snap("newer", { role: "assistant", content: "hi" }),
      snap("older", { role: "user", content: "hello" }),
    ];
    expect(mapMessageDocs(docs)).toEqual([
      { id: "older", role: "user", content: "hello" },
      { id: "newer", role: "assistant", content: "hi" },
    ]);
  });

  it("drops malformed docs silently", () => {
    const docs = [
      snap("good", { role: "user", content: "ok" }),
      snap("bad-role", { role: "system", content: "x" }),
      snap("bad-no-content", { role: "user" }),
    ];
    expect(mapMessageDocs(docs)).toEqual([
      { id: "good", role: "user", content: "ok" },
    ]);
  });
});

describe("appendUniqueMessage", () => {
  it("appends a new message", () => {
    const prev: ChatMessage[] = [{ id: "a", role: "user", content: "hi" }];
    const next = appendUniqueMessage(prev, {
      id: "b",
      role: "assistant",
      content: "yo",
    });
    expect(next).toEqual([
      { id: "a", role: "user", content: "hi" },
      { id: "b", role: "assistant", content: "yo" },
    ]);
  });

  it("does not duplicate an id that is already present (done vs onSnapshot race)", () => {
    const prev: ChatMessage[] = [
      { id: "a", role: "user", content: "hi" },
      { id: "b", role: "assistant", content: "yo" },
    ];
    const next = appendUniqueMessage(prev, {
      id: "b",
      role: "assistant",
      content: "yo",
    });
    expect(next).toBe(prev);
  });

  it("gives a unique temp id when no id is supplied", () => {
    const prev: ChatMessage[] = [
      { id: "a", role: "user", content: "hi" },
      { id: "a2", role: "user", content: "hi" },
    ];
    const next = appendUniqueMessage(prev, {
      id: undefined,
      role: "assistant",
      content: "partial",
    });
    expect(next).toHaveLength(3);
    expect(next[2].id).toBeDefined();
    expect(next[2].id!.startsWith("local-")).toBe(true);
  });
});

describe("reconcileMessages", () => {
  const prevOf = (items: ChatMessage[]) => items;

  it("returns prev unchanged when there are no changes", () => {
    const prev = prevOf([{ id: "a", role: "user", content: "hi" }]);
    expect(reconcileMessages(prev, [], new Set())).toBe(prev);
  });

  it("adds a new added doc", () => {
    const prev = prevOf([{ id: "a", role: "user", content: "hi" }]);
    const changes = [change("added", snap("b", { role: "assistant", content: "yo" }))];
    expect(reconcileMessages(prev, changes, new Set())).toEqual([
      { id: "a", role: "user", content: "hi" },
      { id: "b", role: "assistant", content: "yo" },
    ]);
  });

  it("updates a modified doc without reordering", () => {
    const prev = prevOf([{ id: "a", role: "user", content: "old" }]);
    const changes = [change("modified", snap("a", { role: "user", content: "new" }))];
    expect(reconcileMessages(prev, changes, new Set())).toEqual([
      { id: "a", role: "user", content: "new" },
    ]);
  });

  it("removes a removed doc", () => {
    const prev = prevOf([
      { id: "a", role: "user", content: "hi" },
      { id: "b", role: "assistant", content: "yo" },
    ]);
    const changes = [change("removed", snap("a", {}))];
    expect(reconcileMessages(prev, changes, new Set())).toEqual([
      { id: "b", role: "assistant", content: "yo" },
    ]);
  });

  it("ignores changes to ids in dirtyIds (local unsaved wins)", () => {
    const prev = prevOf([{ id: "a", role: "user", content: "local-draft" }]);
    const changes = [change("modified", snap("a", { role: "user", content: "remote" }))];
    expect(reconcileMessages(prev, changes, new Set(["a"]))).toBe(prev);
  });

  it("drops a doc that becomes malformed", () => {
    const prev = prevOf([
      { id: "a", role: "user", content: "hi" },
      { id: "b", role: "assistant", content: "yo" },
    ]);
    const changes = [change("modified", snap("b", { role: "wat" }))];
    expect(reconcileMessages(prev, changes, new Set())).toEqual([
      { id: "a", role: "user", content: "hi" },
    ]);
  });
});

// Minimal stand-in for a Firestore Timestamp (only toMillis is read).
const ts = (ms: number) => ({ toMillis: () => ms });

describe("reconcileMessages time ordering", () => {
  it("inserts a new doc by createdAt rather than always appending", () => {
    const prev: ChatMessage[] = [
      { id: "a", role: "user", content: "1", createdAtMs: 100 },
      { id: "c", role: "user", content: "3", createdAtMs: 300 },
    ];
    const changes = [change("added", snap("b", { role: "assistant", content: "2", createdAt: ts(200) }))];
    expect(reconcileMessages(prev, changes, new Set()).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("appends when the newest message has no timestamp (local-only)", () => {
    const prev: ChatMessage[] = [
      { id: "a", role: "user", content: "1", createdAtMs: 100 },
      { id: "local-x", role: "assistant", content: "partial" },
    ];
    const changes = [change("added", snap("b", { role: "user", content: "2", createdAt: ts(50) }))];
    expect(reconcileMessages(prev, changes, new Set()).map((m) => m.id)).toEqual(["a", "local-x", "b"]);
  });

  it("replaces an optimistic browser-clock timestamp with the server one", () => {
    // Browser clock ahead: optimistic 9_000, server says 1_000.
    const prev: ChatMessage[] = [{ id: "u", role: "user", content: "hi", createdAtMs: 9_000 }];
    const confirmed = reconcileMessages(
      prev,
      [change("modified", snap("u", { role: "user", content: "hi", createdAt: ts(1_000) }))],
      new Set()
    );
    expect(confirmed[0].createdAtMs).toBe(1_000);
    // The reply (server time 2_000) now lands after the user message.
    const withReply = reconcileMessages(
      confirmed,
      [change("added", snap("r", { role: "assistant", content: "yo", createdAt: ts(2_000) }))],
      new Set()
    );
    expect(withReply.map((m) => m.id)).toEqual(["u", "r"]);
  });

  it("keeps the known timestamp while the server one is pending (null)", () => {
    const prev: ChatMessage[] = [{ id: "u", role: "user", content: "hi", createdAtMs: 5 }];
    const next = reconcileMessages(
      prev,
      [change("modified", snap("u", { role: "user", content: "edited", createdAt: null }))],
      new Set()
    );
    expect(next[0]).toEqual({ id: "u", role: "user", content: "edited", createdAtMs: 5 });
  });
});

describe("toMillis", () => {
  it("reads Timestamps and Dates, and ignores anything else", () => {
    expect(toMillis(ts(42))).toBe(42);
    expect(toMillis(new Date(7))).toBe(7);
    expect(toMillis(null)).toBeUndefined();
    expect(toMillis("2024-01-01")).toBeUndefined();
  });
});

describe("trimHistory", () => {
  const limits = { maxMessages: 3, maxMessageChars: 10, maxTotalChars: 25 };
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string) => ({ role: "assistant" as const, content });

  it("keeps only the newest maxMessages, in chronological order", () => {
    expect(trimHistory([u("1"), a("2"), u("3"), a("4"), u("5")], limits)).toEqual([
      u("3"),
      a("4"),
      u("5"),
    ]);
  });

  it("strips extra fields such as ids", () => {
    const withId = { id: "x", createdAtMs: 1, role: "user" as const, content: "hi" };
    expect(trimHistory([withId], limits)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("shortens an over-long message instead of failing", () => {
    const [m] = trimHistory([a("x".repeat(50))], limits);
    expect(m.content).toHaveLength(10);
    expect(m.content.endsWith("…")).toBe(true);
  });

  it("stops before exceeding the total character budget", () => {
    // 10 + 10 + 10 > 25, so only the two newest fit.
    const out = trimHistory([u("a".repeat(10)), a("b".repeat(10)), u("c".repeat(10))], limits);
    expect(out.map((m) => m.content[0])).toEqual(["b", "c"]);
  });

  it("skips empty messages", () => {
    expect(trimHistory([u("hi"), a("   "), u("there")], limits)).toEqual([u("hi"), u("there")]);
  });

  it("always keeps the newest message", () => {
    expect(trimHistory([u("x".repeat(50))], { ...limits, maxTotalChars: 1 })).toHaveLength(1);
  });

  it("a 60-message chat of 4k replies stays within the default limits", () => {
    const long = Array.from({ length: 60 }, (_, i) => (i % 2 ? a("r".repeat(4_000)) : u("q")));
    long.push(u("latest"));
    const out = trimHistory(long);
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(total).toBeLessThanOrEqual(24_000);
    expect(out[out.length - 1]).toEqual(u("latest"));
  });
});

describe("interrupted replies", () => {
  it("maps the interrupted flag from docs", () => {
    const [m] = mapMessageDocs([snap("r", { role: "assistant", content: "par", interrupted: true })]);
    expect(m.interrupted).toBe(true);
  });

  it("does not set interrupted on normal replies", () => {
    const [m] = mapMessageDocs([snap("r", { role: "assistant", content: "full" })]);
    expect(m.interrupted).toBeUndefined();
  });
});

describe("settledReplies", () => {
  const added = (id: string, content: string, role = "assistant") =>
    change("added", snap(id, { role, content }));

  it("settles a completed reply whose saved text is identical", () => {
    const pending = [{ localId: "local-reply-1", text: "hello there" }];
    expect(settledReplies([added("x", "hello there")], pending)).toEqual(["local-reply-1"]);
  });

  it("settles a stopped reply when the server saved a few more tokens", () => {
    const pending = [{ localId: "local-reply-1", text: "hello" }];
    expect(settledReplies([added("x", "hello there")], pending)).toEqual(["local-reply-1"]);
  });

  it("ignores user docs, modified docs, and unrelated text", () => {
    const pending = [{ localId: "local-reply-1", text: "hello" }];
    expect(
      settledReplies(
        [
          added("u", "hello", "user"),
          change("modified", snap("m", { role: "assistant", content: "hello" })),
          added("z", "something else"),
        ],
        pending
      )
    ).toEqual([]);
  });

  it("lets each saved doc settle only one pending reply", () => {
    const pending = [
      { localId: "a", text: "same" },
      { localId: "b", text: "same" },
    ];
    expect(settledReplies([added("x", "same")], pending)).toEqual(["a"]);
    expect(settledReplies([added("x", "same"), added("y", "same")], pending)).toEqual(["a", "b"]);
  });

  it("returns nothing when no replies are pending", () => {
    expect(settledReplies([added("x", "hi")], [])).toEqual([]);
  });
});

describe("swapMessageId", () => {
  const local: ChatMessage = { id: "local-reply-1", role: "assistant", content: "hi" };

  it("renames the temporary id to the real one", () => {
    expect(swapMessageId([local], "local-reply-1", "real")).toEqual([{ ...local, id: "real" }]);
  });

  it("drops the temporary copy if the saved one already arrived", () => {
    const saved: ChatMessage = { id: "real", role: "assistant", content: "hi" };
    expect(swapMessageId([local, saved], "local-reply-1", "real")).toEqual([saved]);
  });

  it("is a no-op when the temporary id is gone", () => {
    const prev: ChatMessage[] = [{ id: "real", role: "assistant", content: "hi" }];
    expect(swapMessageId(prev, "local-reply-1", "real")).toBe(prev);
  });
});
