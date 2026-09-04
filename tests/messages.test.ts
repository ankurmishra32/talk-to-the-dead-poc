import { describe, it, expect } from "vitest";
import {
  appendUniqueMessage,
  mapMessageDocs,
  reconcileMessages,
  isPersistedId,
} from "../lib/messages";
import type {
  ChatMessage,
  FirestoreDocLike,
  FirestoreChangeLike,
} from "../lib/types";

function snap(
  id: string,
  data: { role?: string; content?: string }
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
