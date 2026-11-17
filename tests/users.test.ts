import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as Array<{ path: string; data: Record<string, unknown> }>,
  docs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../firebase/config", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join("/") }),
  serverTimestamp: () => "SERVER_TS",
  setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
    h.writes.push({ path: ref.path, data });
  },
  getDoc: async (ref: { path: string }) => {
    const data = h.docs.get(ref.path);
    return { exists: () => data !== undefined, data: () => data };
  },
}));

import { createUserProfile, getUserProfile } from "../lib/users";

beforeEach(() => {
  h.writes = [];
  h.docs = new Map();
});

describe("createUserProfile", () => {
  it("writes users/{uid} with all fields and a server timestamp", async () => {
    await createUserProfile({ uid: "u1", email: "a@b.c", displayName: "Ankur", phone: "+91 1", onboardingHint: "Nani" });
    expect(h.writes).toEqual([
      {
        path: "users/u1",
        data: {
          uid: "u1",
          email: "a@b.c",
          displayName: "Ankur",
          phone: "+91 1",
          onboardingHint: "Nani",
          createdAt: "SERVER_TS",
        },
      },
    ]);
  });

  it("stores null for missing or empty optional fields", async () => {
    await createUserProfile({ uid: "u1", email: "a@b.c", displayName: "A", phone: "", onboardingHint: undefined });
    expect(h.writes[0].data).toMatchObject({ phone: null, onboardingHint: null });
  });

  it("the stored uid matches the document id (required by the users rule)", async () => {
    await createUserProfile({ uid: "u9", email: "x@y.z", displayName: "A" });
    expect(h.writes[0].path).toBe(`users/${h.writes[0].data.uid}`);
  });
});

describe("getUserProfile", () => {
  it("returns the profile when it exists", async () => {
    h.docs.set("users/u1", { uid: "u1", displayName: "A" });
    expect(await getUserProfile("u1")).toEqual({ uid: "u1", displayName: "A" });
  });

  it("returns null when there is no profile", async () => {
    expect(await getUserProfile("nobody")).toBeNull();
  });
});
