import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPersona,
  listMemoriesForPersona,
  appendConversationMessage,
  readSpeechExamples,
} from "../lib/firestore";

const str = (v: string) => ({ stringValue: v });
const arr = (vals: string[]) => ({ arrayValue: { values: vals.map(str) } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const BASE =
  "https://firestore.googleapis.com/v1/projects/be-right-back-b47be/databases/talk-to-the-dead/documents";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  process.env.FIREBASE_API_KEY = "k";
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_DATABASE_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIREBASE_API_KEY;
});

// ---------------------------------------------------------------------------
describe("getPersona", () => {
  const personaDoc = {
    fields: {
      name: str("Ammi"),
      userId: str("owner"),
      relationship: str("Mother"),
      theyCalledYou: str("Betu"),
      languages: arr(["Hindi", "English"]),
      howTheySpoke: arr(["Warm"]),
      distinctiveStory: str("story"),
      speechExamples: {
        arrayValue: {
          values: [{ mapValue: { fields: { phrase: str(" p "), context: str(" c "), tone: str("t") } } }],
        },
      },
    },
  };

  it("maps all fields for the owner and sends a Bearer token", async () => {
    fetchMock.mockResolvedValue(json(personaDoc));
    const p = await getPersona("p1", "owner", "rawtoken");
    expect(p).toEqual({
      id: "p1",
      name: "Ammi",
      ownerId: "owner",
      relationship: "Mother",
      theyCalledYou: "Betu",
      languages: ["Hindi", "English"],
      howTheySpoke: ["Warm"],
      speechExamples: [{ phrase: "p", context: "c", tone: "t" }],
      distinctiveStory: "story",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/personas/p1?key=k`);
    expect(init.headers.Authorization).toBe("Bearer rawtoken");
  });

  it("keeps an existing Bearer prefix", async () => {
    fetchMock.mockResolvedValue(json(personaDoc));
    await getPersona("p1", "owner", "Bearer t");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
  });

  it("URL-encodes the persona id", async () => {
    fetchMock.mockResolvedValue(json(personaDoc));
    await getPersona("a/b c", "owner", "t");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/personas/a%2Fb%20c?key=k`);
  });

  it("returns null for another user's persona (no existence leak)", async () => {
    fetchMock.mockResolvedValue(json(personaDoc));
    await expect(getPersona("p1", "someone-else", "t")).resolves.toBeNull();
  });

  it("returns null on 404", async () => {
    fetchMock.mockResolvedValue(json({ error: {} }, 404));
    await expect(getPersona("p1", "owner", "t")).resolves.toBeNull();
  });

  it("throws on other non-OK statuses (e.g. 403 from rules)", async () => {
    fetchMock.mockResolvedValue(json({ error: { status: "PERMISSION_DENIED" } }, 403));
    await expect(getPersona("p1", "owner", "t")).rejects.toThrow("403");
  });

  it("throws when name or userId is missing", async () => {
    fetchMock.mockResolvedValue(json({ fields: { name: str("x") } }));
    await expect(getPersona("p1", "owner", "t")).rejects.toThrow("missing required fields");
  });

  // Regression (fixed today): a document with no fields at all comes back from the REST API with
  // the `fields` key omitted. getPersona then crashes with a TypeError
  // (reading properties of undefined) instead of its own "missing required
  // fields" error. Same pattern in listMemoriesForPersona (d.fields.createdAt).
  it("reports an empty document as missing fields rather than crashing", async () => {
    fetchMock.mockResolvedValue(json({ name: "projects/x/.../personas/p1" }));
    await expect(getPersona("p1", "owner", "t")).rejects.toThrow("missing required fields");
  });

  it("throws before fetching when the token is empty or the key is missing", async () => {
    await expect(getPersona("p1", "owner", "  ")).rejects.toThrow("Missing Firebase ID token");
    delete process.env.FIREBASE_API_KEY;
    await expect(getPersona("p1", "owner", "t")).rejects.toThrow("FIREBASE_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours FIREBASE_PROJECT_ID / FIREBASE_DATABASE_ID", async () => {
    process.env.FIREBASE_PROJECT_ID = "proj";
    process.env.FIREBASE_DATABASE_ID = "db";
    fetchMock.mockResolvedValue(json(personaDoc));
    await getPersona("p1", "owner", "t");
    expect(fetchMock.mock.calls[0][0]).toContain("/projects/proj/databases/db/documents/personas/p1");
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_DATABASE_ID;
  });
});

// ---------------------------------------------------------------------------
describe("listMemoriesForPersona", () => {
  it("queries memories by userId AND personaId, newest first, with the limit", async () => {
    fetchMock.mockResolvedValue(json([]));
    await listMemoriesForPersona("p1", "u1", "t", 7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}:runQuery?key=k`);
    const q = JSON.parse(init.body).structuredQuery;
    expect(q.from).toEqual([{ collectionId: "memories" }]);
    expect(q.where.compositeFilter.op).toBe("AND");
    const filters = q.where.compositeFilter.filters.map(
      (f: { fieldFilter: { field: { fieldPath: string }; value: { stringValue: string } } }) => [
        f.fieldFilter.field.fieldPath,
        f.fieldFilter.value.stringValue,
      ]
    );
    expect(filters).toEqual([
      ["userId", "u1"],
      ["personaId", "p1"],
    ]);
    expect(q.orderBy).toEqual([{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }]);
    expect(q.limit).toBe(7);
  });

  it("defaults the limit to 20", async () => {
    fetchMock.mockResolvedValue(json([]));
    await listMemoriesForPersona("p1", "u1", "t");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).structuredQuery.limit).toBe(20);
  });

  it("maps documents and skips results without a document or text", async () => {
    fetchMock.mockResolvedValue(
      json([
        { readTime: "x" }, // runQuery emits a result with no document when empty
        { document: { fields: { text: str("loved gardening"), createdAt: { timestampValue: "2025-01-01T00:00:00Z" } } } },
        { document: { fields: { createdAt: { timestampValue: "2025-01-02T00:00:00Z" } } } },
        { document: { fields: { text: str("") } } },
      ])
    );
    await expect(listMemoriesForPersona("p1", "u1", "t")).resolves.toEqual([
      { text: "loved gardening", createdAt: "2025-01-01T00:00:00Z" },
    ]);
  });

  it("throws on a non-OK response (e.g. missing index)", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "requires an index" } }, 400));
    await expect(listMemoriesForPersona("p1", "u1", "t")).rejects.toThrow("400");
  });
});

// ---------------------------------------------------------------------------
describe("appendConversationMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-03T04:05:06.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("writes the message fields and returns the generated id", async () => {
    fetchMock.mockResolvedValue(json({ name: `${BASE}/conversations/p1/messages/abc123` }));
    const id = await appendConversationMessage("p1", { role: "assistant", content: "hi" }, "u1", "t");
    expect(id).toBe("abc123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/conversations/p1/messages?key=k`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      fields: {
        userId: str("u1"),
        personaId: str("p1"),
        role: str("assistant"),
        content: str("hi"),
        createdAt: { timestampValue: "2026-02-03T04:05:06.000Z" },
      },
    });
  });

  it("adds interrupted only when true", async () => {
    fetchMock.mockImplementation(async () => json({ name: "x/messages/m1" }));
    await appendConversationMessage("p1", { role: "assistant", content: "par", interrupted: true }, "u1", "t");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.interrupted).toEqual({ booleanValue: true });
    await appendConversationMessage("p1", { role: "assistant", content: "full", interrupted: false }, "u1", "t");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty("interrupted");
  });

  it("throws when the response has no document name", async () => {
    fetchMock.mockResolvedValue(json({}));
    await expect(
      appendConversationMessage("p1", { role: "assistant", content: "x" }, "u1", "t")
    ).rejects.toThrow("no document id");
  });

  it("throws on a non-OK response (e.g. rules rejection)", async () => {
    fetchMock.mockResolvedValue(json({ error: { status: "PERMISSION_DENIED" } }, 403));
    await expect(
      appendConversationMessage("p1", { role: "assistant", content: "x" }, "u1", "t")
    ).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
describe("readSpeechExamples edge cases", () => {
  // Regression (fixed today): entries are validated before trimming. A phrase or context that is
  // only whitespace passes the `!phrase || !context` check and is returned
  // with an empty string, which then renders in the prompt as
  // `Characteristic expression: ""` / an empty trigger.
  it("skips entries whose phrase or context is only whitespace", () => {
    const fields = {
      speechExamples: {
        arrayValue: {
          values: [
            { mapValue: { fields: { phrase: str("   "), context: str("late night") } } },
            { mapValue: { fields: { phrase: str("arre"), context: str("  ") } } },
          ],
        },
      },
    };
    expect(readSpeechExamples(fields, "speechExamples")).toEqual([]);
  });
});
