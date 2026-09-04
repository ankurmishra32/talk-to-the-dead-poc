import { describe, it, expect } from "vitest";
import { parseSseEvent } from "../lib/sse";

describe("parseSseEvent", () => {
  it("parses a basic data-only block as the default 'message' event", () => {
    const ev = parseSseEvent('data:{"delta":"hi"}');
    expect(ev).toEqual({ event: "message", data: { delta: "hi" } });
  });

  it("honors an explicit event name", () => {
    const ev = parseSseEvent('event:delta\ndata:{"delta":"x"}');
    expect(ev?.event).toBe("delta");
    expect(ev?.data).toEqual({ delta: "x" });
  });

  it("returns null when the block has no data line", () => {
    expect(parseSseEvent("event:keepalive")).toBeNull();
  });

  it("concatenates multiple data lines", () => {
    const ev = parseSseEvent('data:{"a":1' + "\n" + 'data:,"b":2}');
    expect(ev?.data).toEqual({ a: 1, b: 2 });
  });

  it("falls back to raw text when data is not valid JSON", () => {
    const ev = parseSseEvent("event:delta\ndata:just-some-text");
    expect(ev?.event).toBe("delta");
    expect(ev?.data).toEqual({ raw: "just-some-text" });
  });

  it("trims surrounding whitespace from event name", () => {
    const ev = parseSseEvent("event:  delta  \ndata:{}");
    expect(ev?.event).toBe("delta");
  });
});
