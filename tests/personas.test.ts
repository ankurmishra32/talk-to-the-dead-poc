import { describe, it, expect } from "vitest";
import { mapPersonaDoc, reconcilePersonas } from "../lib/personas";
import type { PersonaItem } from "../lib/types";
import type { DocumentChange, QueryDocumentSnapshot } from "firebase/firestore";

function snap(id: string, data: Record<string, unknown>): QueryDocumentSnapshot {
  return { id, data: () => data } as QueryDocumentSnapshot;
}

function change(
  type: DocumentChange["type"],
  doc: QueryDocumentSnapshot
): DocumentChange {
  return { type, doc } as DocumentChange;
}

const OWNER = "uid-1";

describe("mapPersonaDoc", () => {
  it("returns null for a doc owned by someone else", () => {
    expect(
      mapPersonaDoc(snap("p1", { name: "X", userId: "other" }), OWNER)
    ).toBeNull();
  });

  it("maps a full structured doc", () => {
    const doc = snap("p1", {
      name: "Ammi",
      userId: OWNER,
      relationship: "Mother",
      theyCalledYou: "Betu",
      languages: ["Hindi"],
      howTheySpoke: ["Warm"],
      speechExamples: [{ context: "t", phrase: "p" }],
      oftenSaid: ["x"],
      distinctiveStory: "story",
    });
    expect(mapPersonaDoc(doc, OWNER)).toEqual({
      id: "p1",
      name: "Ammi",
      ownerId: OWNER,
      relationship: "Mother",
      theyCalledYou: "Betu",
      languages: ["Hindi"],
      howTheySpoke: ["Warm"],
      speechExamples: [{ context: "t", phrase: "p" }],
      oftenSaid: ["x"],
      distinctiveStory: "story",
    });
  });

  it("defaults missing fields defensively", () => {
    const doc = snap("p1", { userId: OWNER });
    expect(mapPersonaDoc(doc, OWNER)).toEqual({
      id: "p1",
      name: "(unnamed)",
      ownerId: OWNER,
      relationship: null,
      theyCalledYou: null,
      languages: [],
      howTheySpoke: [],
      speechExamples: [],
      oftenSaid: [],
      distinctiveStory: null,
    });
  });
});

describe("reconcilePersonas", () => {
  const prevOf = (items: PersonaItem[]) => items;

  it("returns prev unchanged when there are no changes", () => {
    const prev = prevOf([{ id: "p1", name: "X", ownerId: OWNER }]);
    expect(reconcilePersonas(prev, [], OWNER)).toBe(prev);
  });

  it("appends a newly added persona", () => {
    const prev = prevOf([{ id: "p1", name: "A", ownerId: OWNER }]);
    const changes = [change("added", snap("p2", { name: "B", userId: OWNER }))];
    const next = reconcilePersonas(prev, changes, OWNER);
    expect(next.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("upserts an existing persona by id", () => {
    const prev = prevOf([{ id: "p1", name: "Old", ownerId: OWNER }]);
    const changes = [change("modified", snap("p1", { name: "New", userId: OWNER }))];
    expect(reconcilePersonas(prev, changes, OWNER)[0].name).toBe("New");
  });

  it("removes a deleted persona", () => {
    const prev = prevOf([
      { id: "p1", name: "A", ownerId: OWNER },
      { id: "p2", name: "B", ownerId: OWNER },
    ]);
    const changes = [change("removed", snap("p1", {}))];
    expect(reconcilePersonas(prev, changes, OWNER).map((p) => p.id)).toEqual(["p2"]);
  });

  it("drops a doc that is no longer owned by the user", () => {
    const prev = prevOf([{ id: "p1", name: "A", ownerId: OWNER }]);
    const changes = [
      change("added", snap("p2", { name: "B", userId: "someone-else" })),
    ];
    expect(reconcilePersonas(prev, changes, OWNER).map((p) => p.id)).toEqual(["p1"]);
  });
});
