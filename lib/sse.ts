// Parsing for the SSE (Server-Sent Events) stream returned by /api/chat.
//
// Importable from the client components and from tests. Kept side-effect
// free (no imports) so it runs in any environment.

/**
 * Parses a single SSE event block (text between two blank lines) into
 * { event, data }. Returns null if the block has no data line.
 *
 * Multiple `data:` lines are concatenated (per the SSE spec). If the
 * accumulated data line is not valid JSON, the raw text is returned
 * under `data.raw` so callers can still react to the event name.
 */
export function parseSseEvent(
  block: string
): { event: string; data: unknown } | null {
  let eventName = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLine += line.slice(5).trim();
    }
  }
  if (!dataLine) return null;
  try {
    return { event: eventName, data: JSON.parse(dataLine) };
  } catch {
    return { event: eventName, data: { raw: dataLine } };
  }
}
