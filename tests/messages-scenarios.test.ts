// Scenario tests: full chat timelines built from the lib/messages helpers,
// composed the same way components/Chat.tsx composes them.
import { describe, it, expect } from "vitest";
import {
  appendUniqueMessage,
  mapMessageDocs,
  reconcileMessages,
  settledReplies,
  matchSettledReplies,
  applySettledReplies,
  prependOlder,
  swapMessageId,
  trimHistory,
  HISTORY_LIMITS,
  type PendingReply,
} from "../lib/messages";
import type { ChatMessage, FirestoreChangeLike, FirestoreDocLike } from "../lib/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type DocData = {
  role?: string;
  content?: string;
  createdAt?: unknown;
  interrupted?: unknown;
};
const ts = (ms: number) => ({ toMillis: () => ms });
const doc = (id: string, data: DocData): FirestoreDocLike => ({ id, data: () => data });
const added = (id: string, data: DocData): FirestoreChangeLike => ({ type: "added", doc: doc(id, data) });
const modified = (id: string, data: DocData): FirestoreChangeLike => ({ type: "modified", doc: doc(id, data) });
const removed = (id: string): FirestoreChangeLike => ({ type: "removed", doc: doc(id, {}) });

/**
 * A tiny model of Chat.tsx's state: `messages`, `pendingReplies` (the ref),
 * `dirty` ids, plus the exact transformations each event performs.
 */
class ChatSim {
  messages: ChatMessage[] = [];
  pending: PendingReply[] = [];
  dirty = new Set<string>();
  private replySeq = 0;

  /** Initial getDocs page (desc order from Firestore). */
  loadFirstPage(descDocs: FirestoreDocLike[]) {
    this.messages = mapMessageDocs(descDocs);
  }

  /** onSnapshot callback (Chat.tsx loadMessages → onSnapshot). */
  snapshot(changes: FirestoreChangeLike[]) {
    const settled = matchSettledReplies(changes, this.pending);
    if (settled.length > 0) {
      const done = new Set(settled.map((p) => p.localId));
      this.pending = this.pending.filter((p) => !done.has(p.localId));
    }
    this.messages = reconcileMessages(
      applySettledReplies(this.messages, settled),
      changes,
      this.dirty
    );
  }

  /** send(): optimistic user message with a pre-assigned doc id. */
  sendUser(id: string, content: string, browserNowMs: number) {
    const userMessage: ChatMessage = { id, role: "user", content, createdAtMs: browserNowMs };
    this.messages = appendUniqueMessage(this.messages, userMessage);
    return userMessage;
  }

  /** commitReply() at "done" or after Stop. Returns the temporary id. */
  commitReply(text: string, interrupted: boolean): string | null {
    if (!text) return null;
    const localId = `local-reply-${++this.replySeq}`;
    this.pending = [...this.pending, { localId, text }];
    const m: ChatMessage = { id: localId, role: "assistant", content: text };
    if (interrupted) m.interrupted = true;
    this.messages = [...this.messages, m];
    return localId;
  }

  /** SSE "id" event. */
  idEvent(fromId: string, toId: string) {
    this.pending = this.pending.filter((p) => p.localId !== fromId);
    this.messages = swapMessageId(this.messages, fromId, toId);
  }

  /** loadOlder(): prepend an older page (desc docs). */
  loadOlder(descDocs: FirestoreDocLike[]) {
    const older = mapMessageDocs(descDocs);
    this.messages = prependOlder(this.messages, older);
  }

  ids() {
    return this.messages.map((m) => m.id);
  }
  contents() {
    return this.messages.map((m) => m.content);
  }
}

function expectNoDuplicateIds(messages: ChatMessage[]) {
  const ids = messages.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
}

// ---------------------------------------------------------------------------
// Initial load + listener first snapshot
// ---------------------------------------------------------------------------

describe("initial load + first live snapshot", () => {
  it("re-delivered docs (all 'added' again) cause no change", () => {
    const docs = [
      doc("m3", { role: "assistant", content: "c", createdAt: ts(300) }),
      doc("m2", { role: "user", content: "b", createdAt: ts(200) }),
      doc("m1", { role: "assistant", content: "a", createdAt: ts(100) }),
    ];
    const chat = new ChatSim();
    chat.loadFirstPage(docs);
    const before = chat.messages;
    chat.snapshot(docs.map((d) => added(d.id, d.data())));
    expect(chat.messages).toBe(before); // same reference: nothing mutated
    expect(chat.ids()).toEqual(["m1", "m2", "m3"]);
  });

  it("a doc with the same timestamp as the oldest loaded one is inserted after it", () => {
    const chat = new ChatSim();
    chat.loadFirstPage([
      doc("m2", { role: "user", content: "b", createdAt: ts(200) }),
      doc("m1", { role: "assistant", content: "a", createdAt: ts(100) }),
    ]);
    // >= boundary query also returns m0, which shares m1's timestamp.
    chat.snapshot([added("m0", { role: "user", content: "z", createdAt: ts(100) })]);
    expect(chat.ids()).toEqual(["m1", "m0", "m2"]);
    expectNoDuplicateIds(chat.messages);
  });
});

// ---------------------------------------------------------------------------
// A normal turn
// ---------------------------------------------------------------------------

describe("a normal turn", () => {
  function startTurn(browserNow = 1_000) {
    const chat = new ChatSim();
    chat.loadFirstPage([doc("old", { role: "assistant", content: "earlier", createdAt: ts(500) })]);
    chat.sendUser("u1", "hello", browserNow);
    // Latency-compensated local snapshot: serverTimestamp still pending (null).
    chat.snapshot([added("u1", { role: "user", content: "hello", createdAt: null })]);
    // Server-confirmed snapshot.
    chat.snapshot([modified("u1", { role: "user", content: "hello", createdAt: ts(1_000) })]);
    return chat;
  }

  it("keeps a single user message through pending and confirmed snapshots", () => {
    const chat = startTurn();
    expect(chat.ids()).toEqual(["old", "u1"]);
    expect(chat.messages[1].createdAtMs).toBe(1_000);
  });

  it("(a) id event first, then the listener's 'added' — shows the reply once", () => {
    const chat = startTurn();
    const localId = chat.commitReply("namaste beta", false)!;
    chat.idEvent(localId, "r1");
    chat.snapshot([added("r1", { role: "assistant", content: "namaste beta", createdAt: ts(2_000) })]);
    expect(chat.ids()).toEqual(["old", "u1", "r1"]);
    expect(chat.messages[2].createdAtMs).toBe(2_000);
    expect(chat.pending).toEqual([]);
  });

  it("(b) listener's 'added' first, then the id event — shows the reply once", () => {
    const chat = startTurn();
    const localId = chat.commitReply("namaste beta", false)!;
    chat.snapshot([added("r1", { role: "assistant", content: "namaste beta", createdAt: ts(2_000) })]);
    expect(chat.ids()).toEqual(["old", "u1", "r1"]);
    chat.idEvent(localId, "r1");
    expect(chat.ids()).toEqual(["old", "u1", "r1"]);
    expect(chat.pending).toEqual([]);
  });

  it("history sent for the next turn contains each message once, without ids", () => {
    const chat = startTurn();
    const localId = chat.commitReply("namaste beta", false)!;
    chat.idEvent(localId, "r1");
    const next = chat.sendUser("u2", "kaise ho?", 3_000);
    const history = trimHistory([...chat.messages.slice(0, -1), next]);
    expect(history).toEqual([
      { role: "assistant", content: "earlier" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "namaste beta" },
      { role: "user", content: "kaise ho?" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stop mid-stream
// ---------------------------------------------------------------------------

describe("Stop mid-stream", () => {
  it("saved copy longer than what was shown replaces the local partial", () => {
    const chat = new ChatSim();
    chat.sendUser("u1", "hi", 1_000);
    chat.snapshot([modified("u1", { role: "user", content: "hi", createdAt: ts(1_000) })]);
    chat.commitReply("Arre be", true);
    chat.snapshot([
      added("r1", { role: "assistant", content: "Arre beta, su", createdAt: ts(1_500), interrupted: true }),
    ]);
    expect(chat.ids()).toEqual(["u1", "r1"]);
    expect(chat.messages[1]).toMatchObject({ content: "Arre beta, su", interrupted: true });
    expect(chat.pending).toEqual([]);
  });

  it("two stopped replies pending at once each settle to their own saved copy", () => {
    const chat = new ChatSim();
    chat.sendUser("u1", "one", 1_000);
    chat.commitReply("First part", true);
    chat.sendUser("u2", "two", 2_000);
    chat.commitReply("Second part", true);
    chat.snapshot([
      added("r2", { role: "assistant", content: "Second part and more", createdAt: ts(2_500), interrupted: true }),
      added("r1", { role: "assistant", content: "First part and more", createdAt: ts(1_500), interrupted: true }),
    ]);
    expectNoDuplicateIds(chat.messages);
    expect(chat.contents()).toEqual(["one", "First part and more", "two", "Second part and more"]);
    expect(chat.pending).toEqual([]);
  });

  // Regression (fixed today): settledReplies matches by prefix against the OLDEST pending reply
  // first. If a stopped reply's saved copy has not arrived yet (e.g. the
  // save failed, or is slow) and a later reply that happens to start with
  // the same words arrives, the later doc settles the WRONG pending entry:
  // the older local partial disappears from the screen, and the newer local
  // copy stays as a duplicate of the saved one.
  it("a later reply sharing the stopped reply's opening words does not settle it", () => {
    const chat = new ChatSim();
    chat.sendUser("u1", "one", 1_000);
    chat.commitReply("Beta", true); // stopped after one word; save is slow / failed
    chat.sendUser("u2", "two", 2_000);
    chat.commitReply("Beta, khana kha liya?", false); // completed reply, id event not yet seen
    chat.snapshot([
      added("r2", { role: "assistant", content: "Beta, khana kha liya?", createdAt: ts(2_500) }),
    ]);
    // Expected: the completed reply's local copy is replaced by r2; the
    // stopped partial "Beta" is still on screen.
    expect(chat.contents()).toEqual(["one", "Beta", "two", "Beta, khana kha liya?"]);
  });

  it("a stopped reply with no text commits nothing", () => {
    const chat = new ChatSim();
    expect(chat.commitReply("", true)).toBeNull();
    expect(chat.messages).toEqual([]);
    expect(chat.pending).toEqual([]);
  });

  it("server saves a partial the client never displayed: it just appears", () => {
    const chat = new ChatSim();
    chat.sendUser("u1", "hi", 1_000);
    chat.snapshot([modified("u1", { role: "user", content: "hi", createdAt: ts(1_000) })]);
    chat.snapshot([added("r1", { role: "assistant", content: "Ar", createdAt: ts(1_200), interrupted: true })]);
    expect(chat.ids()).toEqual(["u1", "r1"]);
  });
});

// ---------------------------------------------------------------------------
// Clock skew
// ---------------------------------------------------------------------------

describe("browser clock skew", () => {
  it("clock ahead: confirmed server time replaces the optimistic one before the reply lands", () => {
    const chat = new ChatSim();
    chat.sendUser("u1", "hi", 99_000); // browser is far ahead
    chat.snapshot([modified("u1", { role: "user", content: "hi", createdAt: ts(1_000) })]);
    // A reply from another device / tab, arriving via the listener only.
    chat.snapshot([added("r1", { role: "assistant", content: "yo", createdAt: ts(2_000) })]);
    expect(chat.ids()).toEqual(["u1", "r1"]);
  });

  // Regression (fixed today): when the browser clock is BEHIND, the optimistic user message's
  // createdAtMs is too small. If the previous turn's saved (stopped) reply
  // arrives via the listener before the user message's server-confirmed
  // snapshot, insertByTime places it AFTER the new user message. The later
  // "modified" snapshot fixes the timestamp but never re-sorts, so the
  // wrong order stays until reload.
  it("clock behind: a late-arriving saved partial still lands before the next user message", () => {
    const chat = new ChatSim();
    chat.sendUser("u1", "first", 1_000);
    chat.snapshot([modified("u1", { role: "user", content: "first", createdAt: ts(1_000) })]);
    chat.commitReply("Arre", true); // Stop
    // User sends again right away; browser clock is 10 minutes behind.
    chat.sendUser("u2", "second", 2_000 - 600_000);
    // Saved partial (server time 1_500) arrives before u2's confirmation.
    chat.snapshot([added("r1", { role: "assistant", content: "Arre beta", createdAt: ts(1_500), interrupted: true })]);
    chat.snapshot([modified("u2", { role: "user", content: "second", createdAt: ts(2_000) })]);
    expect(chat.contents()).toEqual(["first", "Arre beta", "second"]);
  });
});

// ---------------------------------------------------------------------------
// Edits, deletes, dirty ids
// ---------------------------------------------------------------------------

describe("edits and deletes", () => {
  function loaded() {
    const chat = new ChatSim();
    chat.loadFirstPage([
      doc("b", { role: "assistant", content: "reply", createdAt: ts(200) }),
      doc("a", { role: "user", content: "question", createdAt: ts(100) }),
    ]);
    return chat;
  }

  it("a remote edit to a row open in the editor is ignored (local unsaved wins)", () => {
    const chat = loaded();
    chat.dirty.add("a");
    chat.snapshot([modified("a", { role: "user", content: "remote edit", createdAt: ts(100) })]);
    expect(chat.messages[0].content).toBe("question");
  });

  it("a remote edit to another row still applies while one row is dirty", () => {
    const chat = loaded();
    chat.dirty.add("a");
    chat.snapshot([modified("b", { role: "assistant", content: "reply v2", createdAt: ts(200) })]);
    expect(chat.contents()).toEqual(["question", "reply v2"]);
  });

  it("a remote delete removes the message", () => {
    const chat = loaded();
    chat.snapshot([removed("a")]);
    expect(chat.ids()).toEqual(["b"]);
  });

  it("a remote delete of a row being edited is skipped while dirty", () => {
    const chat = loaded();
    chat.dirty.add("a");
    chat.snapshot([removed("a")]);
    expect(chat.ids()).toEqual(["a", "b"]);
  });

  it("an edit keeps the message's position and timestamp", () => {
    const chat = loaded();
    chat.snapshot([modified("a", { role: "user", content: "question (edited)", createdAt: ts(100) })]);
    expect(chat.ids()).toEqual(["a", "b"]);
    expect(chat.messages[0].createdAtMs).toBe(100);
  });

  it("a message whose doc becomes malformed is dropped", () => {
    const chat = loaded();
    chat.snapshot([modified("b", { role: "system", content: "x" })]);
    expect(chat.ids()).toEqual(["a"]);
  });

  it("removal of an unknown id is a no-op (same reference)", () => {
    const chat = loaded();
    const before = chat.messages;
    chat.snapshot([removed("nope")]);
    expect(chat.messages).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("loadOlder + live additions", () => {
  it("older page goes before the first page; live additions go to the end", () => {
    const chat = new ChatSim();
    chat.loadFirstPage([
      doc("m4", { role: "assistant", content: "4", createdAt: ts(400) }),
      doc("m3", { role: "user", content: "3", createdAt: ts(300) }),
    ]);
    chat.loadOlder([
      doc("m2", { role: "assistant", content: "2", createdAt: ts(200) }),
      doc("m1", { role: "user", content: "1", createdAt: ts(100) }),
    ]);
    chat.snapshot([added("m5", { role: "user", content: "5", createdAt: ts(500) })]);
    expect(chat.ids()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  // Regression (fixed today): the live listener covers createdAt >= the oldest first-page doc.
  // A doc that shares that exact timestamp but sorted just past the first
  // page is delivered by the listener AND returned again by loadOlder
  // (startAfter(cursor) returns it). Chat.tsx's loadOlder prepends without
  // de-duplicating, so the message shows twice (and React gets duplicate keys).
  it("loadOlder does not duplicate a doc the live listener already delivered", () => {
    const chat = new ChatSim();
    chat.loadFirstPage([
      doc("m3", { role: "user", content: "3", createdAt: ts(300) }),
      doc("m2", { role: "assistant", content: "2", createdAt: ts(200) }),
    ]);
    // Listener (>= 200) also returns m1b, which has the same timestamp as m2.
    chat.snapshot([added("m1b", { role: "user", content: "same-ms", createdAt: ts(200) })]);
    // loadOlder(startAfter m2) returns m1b again, plus older m1.
    chat.loadOlder([
      doc("m1b", { role: "user", content: "same-ms", createdAt: ts(200) }),
      doc("m1", { role: "user", content: "1", createdAt: ts(100) }),
    ]);
    expectNoDuplicateIds(chat.messages);
  });
});

// ---------------------------------------------------------------------------
// swapMessageId / settledReplies edge cases
// ---------------------------------------------------------------------------

describe("reply settling edge cases", () => {
  it("settledReplies ignores assistant docs without string content", () => {
    expect(settledReplies([added("x", { role: "assistant" })], [{ localId: "l", text: "a" }])).toEqual([]);
  });

  it("a pending entry with empty text is never settled", () => {
    expect(settledReplies([added("x", { role: "assistant", content: "hi" })], [{ localId: "l", text: "" }])).toEqual([]);
  });

  it("swapMessageId keeps other messages untouched", () => {
    const prev: ChatMessage[] = [
      { id: "u1", role: "user", content: "q" },
      { id: "local-reply-1", role: "assistant", content: "a" },
    ];
    const next = swapMessageId(prev, "local-reply-1", "r1");
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toEqual({ id: "r1", role: "assistant", content: "a" });
  });
});

// ---------------------------------------------------------------------------
// trimHistory with realistic mixes
// ---------------------------------------------------------------------------

describe("trimHistory mixes", () => {
  it("mixed long, empty, and short messages stay within limits and keep the newest", () => {
    const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: "user", content: i % 7 === 0 ? "   " : `q${i}` });
      msgs.push({ role: "assistant", content: i % 3 === 0 ? "x".repeat(9_000) : `a${i}` });
    }
    msgs.push({ role: "user", content: "latest" });
    const out = trimHistory(msgs);
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(out.length).toBeLessThanOrEqual(HISTORY_LIMITS.maxMessages);
    expect(total).toBeLessThanOrEqual(HISTORY_LIMITS.maxTotalChars);
    expect(out.every((m) => m.content.trim().length > 0)).toBe(true);
    expect(out.every((m) => m.content.length <= HISTORY_LIMITS.maxMessageChars)).toBe(true);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "latest" });
  });

  it("an all-empty history produces an empty array", () => {
    expect(trimHistory([{ role: "user", content: "" }, { role: "assistant", content: " \n" }])).toEqual([]);
  });

  // Regression (fixed today): shortening slices by UTF-16 code unit, so an emoji (a
  // surrogate pair) straddling the cut leaves a lone surrogate in the text
  // sent to the model.
  it("shortening never splits a surrogate pair", () => {
    const limits = { maxMessages: 5, maxMessageChars: 4, maxTotalChars: 100 };
    // "ab" + "😀" (2 code units) + "cd": the cut at 3 units lands inside the emoji.
    const [m] = trimHistory([{ role: "assistant", content: "ab😀cd" }], limits);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(m.content)).toBe(false);
  });
});
