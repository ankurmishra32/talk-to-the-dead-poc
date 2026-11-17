import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { firebaseAuthServer } from "../lib/auth/firebase.server";

let fetchMock: ReturnType<typeof vi.fn>;
const verify = (t: string) => firebaseAuthServer.verifyAccessToken(t);
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  process.env.FIREBASE_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIREBASE_API_KEY;
});

describe("firebaseAuthServer.verifyAccessToken", () => {
  it("strips the Bearer prefix and posts the token to accounts:lookup", async () => {
    fetchMock.mockResolvedValue(ok({ users: [{ localId: "uid1", email: "a@b.c" }] }));
    await expect(verify("Bearer tok123")).resolves.toEqual({ uid: "uid1", email: "a@b.c" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=test-key");
    expect(JSON.parse(init.body)).toEqual({ idToken: "tok123" });
  });

  it("accepts a raw token", async () => {
    fetchMock.mockResolvedValue(ok({ users: [{ localId: "uid1" }] }));
    await expect(verify("  tok123 ")).resolves.toEqual({ uid: "uid1", email: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ idToken: "tok123" });
  });

  // Regression (fixed today): the "Bearer " prefix check is case-sensitive. HTTP auth schemes are
  // case-insensitive (RFC 7235), so "bearer <token>" is sent to Google as the
  // token "bearer <token>" and rejected -> 401 for a valid token.
  it("accepts a lowercase bearer scheme", async () => {
    fetchMock.mockResolvedValue(ok({ users: [{ localId: "uid1" }] }));
    await verify("bearer tok123");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ idToken: "tok123" });
  });

  it.each(["", "   ", "Bearer ", "Bearer    "])("rejects an empty token (%j) without calling Google", async (t) => {
    await expect(verify(t)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when Identity Toolkit returns an error", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"INVALID_ID_TOKEN"}}', { status: 400 }));
    await expect(verify("Bearer bad")).rejects.toThrow("rejected");
  });

  it.each([
    ["no users", {}],
    ["empty users", { users: [] }],
    ["no localId", { users: [{ email: "a@b.c" }] }],
    ["valid false", { users: [{ localId: "u", valid: false }] }],
    ["valid 'false'", { users: [{ localId: "u", valid: "false" }] }],
  ])("rejects a lookup with %s", async (_label, body) => {
    fetchMock.mockResolvedValue(ok(body));
    await expect(verify("Bearer t")).rejects.toThrow();
  });

  it("throws a clear error when FIREBASE_API_KEY is missing", async () => {
    delete process.env.FIREBASE_API_KEY;
    await expect(verify("Bearer t")).rejects.toThrow("FIREBASE_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a network failure as a rejection", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(verify("Bearer t")).rejects.toThrow();
  });

  it("throws for client-only methods", async () => {
    expect(() => firebaseAuthServer.getCurrentUser()).toThrow("client-only");
    await expect(firebaseAuthServer.signIn("a", "b")).rejects.toThrow("client-only");
  });
});
