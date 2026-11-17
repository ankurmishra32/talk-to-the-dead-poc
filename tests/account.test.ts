// deleteAccount / deletePersonaWithData against an in-memory fake of the
// Firebase SDK calls lib/account.ts uses. Every call is logged in order.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Where = { field: string; op: string; value: unknown };
type FakeDoc = { id: string; data: Record<string, unknown> };

const h = vi.hoisted(() => {
  const state = {
    // collection path -> docs
    store: new Map<string, FakeDoc[]>(),
    log: [] as string[],
    commitSizes: [] as number[],
    failOn: null as null | ((op: string, path: string) => Error | null),
  };
  return { state };
});

function maybeFail(op: string, path: string) {
  const err = h.state.failOn?.(op, path);
  if (err) throw err;
}

vi.mock("../firebase/config", () => ({ db: { fake: true }, auth: {} }));

vi.mock("firebase/firestore", () => {
  const collection = (_db: unknown, ...segments: string[]) => ({ kind: "col", path: segments.join("/") });
  const doc = (_db: unknown, ...segments: string[]) => ({ kind: "doc", path: segments.join("/") });
  const where = (field: string, op: string, value: unknown) => ({ field, op, value });
  const query = (col: { path: string }, ...wheres: Where[]) => ({ path: col.path, wheres });
  const getDocs = async (q: { path: string; wheres: Where[] }) => {
    h.state.log.push(`getDocs ${q.path} ${q.wheres.map((w) => `${w.field}${w.op}${String(w.value)}`).join(",")}`);
    maybeFail("getDocs", q.path);
    const docs = (h.state.store.get(q.path) ?? []).filter((d) =>
      q.wheres.every((w) => w.op === "==" && d.data[w.field] === w.value)
    );
    return {
      empty: docs.length === 0,
      docs: docs.map((d) => ({ id: d.id, ref: { kind: "doc", path: `${q.path}/${d.id}` } })),
    };
  };
  const removeByPath = (path: string) => {
    const idx = path.lastIndexOf("/");
    const col = path.slice(0, idx);
    const id = path.slice(idx + 1);
    h.state.store.set(col, (h.state.store.get(col) ?? []).filter((d) => d.id !== id));
  };
  const deleteDoc = async (ref: { path: string }) => {
    h.state.log.push(`deleteDoc ${ref.path}`);
    maybeFail("deleteDoc", ref.path);
    removeByPath(ref.path);
  };
  const writeBatch = () => {
    const refs: Array<{ path: string }> = [];
    return {
      delete: (ref: { path: string }) => refs.push(ref),
      commit: async () => {
        const col = refs[0]?.path.split("/").slice(0, -1).join("/") ?? "";
        h.state.log.push(`commit ${col} x${refs.length}`);
        maybeFail("commit", col);
        h.state.commitSizes.push(refs.length);
        refs.forEach((r) => removeByPath(r.path));
      },
    };
  };
  return { collection, doc, where, query, getDocs, deleteDoc, writeBatch };
});

vi.mock("firebase/auth", () => ({
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  reauthenticateWithCredential: async (_user: unknown, cred: { password: string }) => {
    h.state.log.push("reauth");
    maybeFail("reauth", "");
    if (cred.password !== "right") {
      throw Object.assign(new Error("Firebase: Error (auth/invalid-credential)."), { code: "auth/invalid-credential" });
    }
  },
  deleteUser: async () => {
    h.state.log.push("deleteUser");
    maybeFail("deleteUser", "");
  },
}));

import { deleteAccount, deletePersonaWithData } from "../lib/account";

const UID = "u1";
const user = { uid: UID, email: "a@b.c" } as unknown as import("firebase/auth").User;
const put = (col: string, docs: FakeDoc[]) => h.state.store.set(col, docs);
const count = (col: string) => (h.state.store.get(col) ?? []).length;
const fsError = (code: string) => Object.assign(new Error(code), { code });

function seed() {
  put("personas", [
    { id: "p1", data: { userId: UID } },
    { id: "p2", data: { userId: UID } },
    { id: "px", data: { userId: "other" } },
  ]);
  put("memories", [
    { id: "m1", data: { userId: UID, personaId: "p1" } },
    { id: "m2", data: { userId: UID, personaId: "p2" } },
    { id: "mx", data: { userId: "other", personaId: "px" } },
  ]);
  put("conversations/p1/messages", [
    { id: "c1", data: { userId: UID } },
    { id: "c2", data: { userId: UID } },
  ]);
  put("conversations/p2/messages", [{ id: "c3", data: { userId: UID } }]);
  put("users", [{ id: UID, data: { uid: UID } }]);
}

beforeEach(() => {
  h.state.store = new Map();
  h.state.log = [];
  h.state.commitSizes = [];
  h.state.failOn = null;
});

describe("deleteAccount", () => {
  it("re-authenticates first and stops on a wrong password", async () => {
    seed();
    await expect(deleteAccount(user, "wrong")).rejects.toMatchObject({ code: "auth/invalid-credential" });
    expect(h.state.log).toEqual(["reauth"]);
    expect(count("personas")).toBe(3);
  });

  it("throws without an email (cannot re-authenticate)", async () => {
    await expect(deleteAccount({ uid: UID, email: null } as unknown as import("firebase/auth").User, "right")).rejects.toThrow();
    expect(h.state.log).toEqual([]);
  });

  it("deletes all of the user's data, only theirs, and the auth user last", async () => {
    seed();
    await deleteAccount(user, "right");
    expect(count("personas")).toBe(1); // other user's persona stays
    expect(count("memories")).toBe(1);
    expect(count("conversations/p1/messages")).toBe(0);
    expect(count("conversations/p2/messages")).toBe(0);
    expect(count("users")).toBe(0);
    expect(h.state.log[0]).toBe("reauth");
    expect(h.state.log[h.state.log.length - 1]).toBe("deleteUser");
  });

  it("message queries filter on userId (required by the rules)", async () => {
    seed();
    await deleteAccount(user, "right");
    const messageQueries = h.state.log.filter((l) => l.startsWith("getDocs conversations/"));
    expect(messageQueries).toEqual([
      `getDocs conversations/p1/messages userId==${UID}`,
      `getDocs conversations/p2/messages userId==${UID}`,
    ]);
  });

  it("splits more than 450 deletes into several batch commits", async () => {
    put("personas", []);
    put("memories", Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, data: { userId: UID } })));
    put("users", [{ id: UID, data: {} }]);
    await deleteAccount(user, "right");
    expect(h.state.commitSizes).toEqual([450, 450, 100]);
    expect(count("memories")).toBe(0);
  });

  it("a failure partway leaves the auth user in place, and a retry finishes the job", async () => {
    seed();
    h.state.failOn = (op, path) => (op === "commit" && path === "conversations/p2/messages" ? fsError("unavailable") : null);
    await expect(deleteAccount(user, "right")).rejects.toMatchObject({ code: "unavailable" });
    expect(h.state.log).not.toContain("deleteUser");
    expect(count("memories")).toBe(1); // already removed before the failure
    expect(count("personas")).toBe(3); // persona docs not yet removed

    h.state.failOn = null;
    h.state.log = [];
    await deleteAccount(user, "right");
    expect(count("personas")).toBe(1);
    expect(count("conversations/p2/messages")).toBe(0);
    expect(h.state.log[h.state.log.length - 1]).toBe("deleteUser");
  });

  it("works for a user with no data at all", async () => {
    await deleteAccount(user, "right");
    expect(h.state.log).toContain("deleteUser");
  });

  // Regression (fixed today): lib/account.ts swallows ANY error from deleting users/{uid}
  // (`.catch(() => {})`, commented "may not exist"). But deleteDoc on a
  // missing doc already succeeds, so the catch only hides real failures
  // (permission-denied, offline). The auth account is then deleted anyway,
  // leaving a profile doc (name, phone, email) that nobody can ever delete.
  it("does not delete the auth user if deleting the profile fails", async () => {
    seed();
    h.state.failOn = (op, path) => (op === "deleteDoc" && path === `users/${UID}` ? fsError("permission-denied") : null);
    await expect(deleteAccount(user, "right")).rejects.toBeTruthy();
    expect(h.state.log).not.toContain("deleteUser");
  });

  it("known gap: messages under personas deleted earlier are not found", async () => {
    // Orphaned conversation (its persona doc is already gone).
    put("conversations/gone/messages", [{ id: "o1", data: { userId: UID } }]);
    await deleteAccount(user, "right");
    expect(count("conversations/gone/messages")).toBe(1);
  });
});

describe("deletePersonaWithData", () => {
  it("deletes the persona's memories and messages, then the persona doc", async () => {
    seed();
    await deletePersonaWithData(UID, "p1");
    expect(count("conversations/p1/messages")).toBe(0);
    expect((h.state.store.get("memories") ?? []).map((d) => d.id)).toEqual(["m2", "mx"]);
    expect((h.state.store.get("personas") ?? []).map((d) => d.id)).toEqual(["p2", "px"]);
    expect(h.state.log[h.state.log.length - 1]).toBe("deleteDoc personas/p1");
  });

  it("memory query filters on both userId and personaId", async () => {
    seed();
    await deletePersonaWithData(UID, "p1");
    expect(h.state.log[0]).toBe(`getDocs memories userId==${UID},personaId==p1`);
  });

  it("a failure deleting messages leaves the persona doc so the user can retry", async () => {
    seed();
    h.state.failOn = (op) => (op === "commit" && h.state.log.some((l) => l.includes("conversations/p1")) ? fsError("unavailable") : null);
    await expect(deletePersonaWithData(UID, "p1")).rejects.toBeTruthy();
    expect((h.state.store.get("personas") ?? []).some((d) => d.id === "p1")).toBe(true);
    h.state.failOn = null;
    await deletePersonaWithData(UID, "p1");
    expect((h.state.store.get("personas") ?? []).some((d) => d.id === "p1")).toBe(false);
  });

  it("deleting a persona with no memories or messages just deletes the doc", async () => {
    put("personas", [{ id: "solo", data: { userId: UID } }]);
    await deletePersonaWithData(UID, "solo");
    expect(count("personas")).toBe(0);
  });
});
