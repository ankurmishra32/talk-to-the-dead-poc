import { describe, it, expect } from "vitest";
import { mapPersonaDoc, reconcilePersonas } from "../lib/personas";
import type { FirestoreChangeLike, FirestoreDocLike, PersonaItem } from "../lib/types";

const OWNER = "uid-1";
const doc = (id: string, data: Record<string, unknown>): FirestoreDocLike => ({ id, data: () => data });
const change = (type: FirestoreChangeLike["type"], d: FirestoreDocLike): FirestoreChangeLike => ({ type, doc: d });
const item = (id: string, name = id): PersonaItem => ({
  id,
  name,
  ownerId: OWNER,
  relationship: null,
  theyCalledYou: null,
  languages: [],
  howTheySpoke: [],
  speechExamples: [],
  distinctiveStory: null,
});

describe("mapPersonaDoc scenarios", () => {
  it("returns null for another owner's doc", () => {
    expect(mapPersonaDoc(doc("p", { userId: "someone-else", name: "X" }), OWNER)).toBeNull();
  });

  it("returns null when userId is missing", () => {
    expect(mapPersonaDoc(doc("p", { name: "X" }), OWNER)).toBeNull();
  });

  it("coerces non-array list fields to empty arrays", () => {
    const m = mapPersonaDoc(
      doc("p", { userId: OWNER, name: "X", languages: "Hindi", howTheySpoke: null, speechExamples: {} }),
      OWNER
    )!;
    expect(m.languages).toEqual([]);
    expect(m.howTheySpoke).toEqual([]);
    expect(m.speechExamples).toEqual([]);
  });

  it("does not expose retired fields", () => {
    const m = mapPersonaDoc(doc("p", { userId: OWNER, name: "X", oftenSaid: ["a"], traits: "t" }), OWNER)!;
    expect(m).not.toHaveProperty("oftenSaid");
    expect(m).not.toHaveProperty("traits");
  });

  // Regression (fixed today): `data.name ?? "(unnamed)"` only covers a missing name. The persona
  // wizard can save name "" (see report: the name field's `required` is not
  // enforced on later wizard steps), which then renders as a blank card.
  it("shows the unnamed placeholder for an empty name", () => {
    expect(mapPersonaDoc(doc("p", { userId: OWNER, name: "" }), OWNER)!.name).toBe("(unnamed)");
  });
});

describe("reconcilePersonas scenarios", () => {
  it("returns prev unchanged for an empty batch", () => {
    const prev = [item("a")];
    expect(reconcilePersonas(prev, [], OWNER)).toBe(prev);
  });

  it("modified updates in place, keeping order", () => {
    const prev = [item("a"), item("b"), item("c")];
    const next = reconcilePersonas(prev, [change("modified", doc("b", { userId: OWNER, name: "B2" }))], OWNER);
    expect(next.map((p) => p.name)).toEqual(["a", "B2", "c"]);
  });

  it("removed drops the persona", () => {
    const prev = [item("a"), item("b")];
    expect(reconcilePersonas(prev, [change("removed", doc("a", {}))], OWNER).map((p) => p.id)).toEqual(["b"]);
  });

  it("removed for an unknown id is a no-op (same reference)", () => {
    const prev = [item("a")];
    expect(reconcilePersonas(prev, [change("removed", doc("zz", {}))], OWNER)).toBe(prev);
  });

  it("a doc that changes owner is dropped", () => {
    const prev = [item("a"), item("b")];
    const next = reconcilePersonas(prev, [change("modified", doc("a", { userId: "other", name: "a" }))], OWNER);
    expect(next.map((p) => p.id)).toEqual(["b"]);
  });

  it("another owner's 'added' doc is ignored", () => {
    const prev = [item("a")];
    expect(reconcilePersonas(prev, [change("added", doc("x", { userId: "other", name: "x" }))], OWNER)).toBe(prev);
  });

  it("re-delivered 'added' for a known id does not duplicate it", () => {
    const prev = [item("a"), item("b")];
    const next = reconcilePersonas(prev, [change("added", doc("a", { userId: OWNER, name: "a" }))], OWNER);
    expect(next.map((p) => p.id)).toEqual(["a", "b"]);
  });

  // Regression (fixed today): the list is newest-first (orderBy createdAt desc), but a newly
  // added persona (e.g. created on another device while this list is open)
  // is appended to the END, so the newest persona shows at the bottom.
  it("a newly added persona appears first (list is newest-first)", () => {
    const prev = [item("older2"), item("older1")];
    const next = reconcilePersonas(prev, [change("added", doc("newest", { userId: OWNER, name: "newest" }))], OWNER);
    expect(next[0].id).toBe("newest");
  });
});
