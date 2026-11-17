import { describe, it, expect } from "vitest";
import { parseSseEvent } from "../lib/sse";

describe("parseSseEvent scenarios", () => {
  it("defaults the event name to 'message'", () => {
    expect(parseSseEvent('data: {"a":1}')).toEqual({ event: "message", data: { a: 1 } });
  });

  it("accepts 'event:' and 'data:' without a space", () => {
    expect(parseSseEvent('event:delta\ndata:{"delta":"x"}')).toEqual({ event: "delta", data: { delta: "x" } });
  });

  it("tolerates CRLF line endings inside a block", () => {
    expect(parseSseEvent('event: done\r\ndata: {"reply":"ok"}\r')).toEqual({ event: "done", data: { reply: "ok" } });
  });

  it("returns null for a comment-only block (the server's ': connected' keepalive)", () => {
    expect(parseSseEvent(": connected")).toBeNull();
  });

  it("returns null when there is no data line", () => {
    expect(parseSseEvent("event: delta")).toBeNull();
  });

  it("returns raw text for invalid JSON", () => {
    expect(parseSseEvent("event: x\ndata: not json")).toEqual({ event: "x", data: { raw: "not json" } });
  });

  it("joins JSON split across multiple data lines", () => {
    expect(parseSseEvent('data: {"a":\ndata: 1}')).toEqual({ event: "message", data: { a: 1 } });
  });

  it("ignores comment lines mixed into an event", () => {
    expect(parseSseEvent(': ping\nevent: id\ndata: {"id":"x"}')).toEqual({ event: "id", data: { id: "x" } });
  });

  it("preserves unicode in data", () => {
    expect(parseSseEvent('event: delta\ndata: {"delta":"नमस्ते 😀"}')).toEqual({
      event: "delta",
      data: { delta: "नमस्ते 😀" },
    });
  });

  // Regression (fixed today): per the SSE spec, multiple data lines are
  // joined with "\n". Concatenating them without a separator merges words of
  // a multi-line text payload. Our server always sends one-line JSON, so this
  // only matters for raw-text events.
  it("joins multiple raw data lines with a newline (SSE spec)", () => {
    expect(parseSseEvent("data: line one\ndata: line two")).toEqual({
      event: "message",
      data: { raw: "line one\nline two" },
    });
  });
});
