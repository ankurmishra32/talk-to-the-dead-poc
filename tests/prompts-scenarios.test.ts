import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../lib/prompts";
import type { MemoryDoc, PersonaDoc } from "../lib/types";

const base = (over: Partial<PersonaDoc> = {}): PersonaDoc => ({ id: "p1", name: "Ammi", ...over });

describe("buildSystemPrompt sections", () => {
  it("minimal persona: identity, language nuance, memories placeholder, discipline, note", () => {
    const p = buildSystemPrompt(base(), []);
    expect(p).toContain('simulation of a person named "Ammi"');
    expect(p).toContain("== Languages & Communication Nuances ==");
    expect(p).not.toContain("Languages you speak:");
    expect(p).not.toContain("Behavioural Patterns");
    expect(p).not.toContain("General speaking style");
    expect(p).toContain("Saved memories: (no additional memories saved yet)");
    expect(p).not.toContain("Biographical memory:");
    expect(p).toContain("== Conversational Discipline ==");
    expect(p).toContain("== Note ==");
  });

  it("full persona includes every section in order", () => {
    const p = buildSystemPrompt(
      base({
        relationship: "Mother",
        theyCalledYou: "Betu",
        languages: ["Hindi", "English"],
        howTheySpoke: ["Warm", "Blunt"],
        speechExamples: [{ phrase: "khana kha liya?", context: "user comes home late", tone: "worried" }],
        distinctiveStory: "Ran a tailoring shop.",
      }),
      [{ text: "loved gardening" }]
    );
    const order = [
      "named \"Ammi\"",
      "You used to call them \"Betu\"",
      "Languages you speak: Hindi + English",
      "== Behavioural Patterns",
      "== General speaking style ==",
      "Biographical memory:",
      "Saved memories:",
      "== Conversational Discipline ==",
      "== Note ==",
    ];
    const positions = order.map((s) => p.indexOf(s));
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("whitespace-only optional fields are treated as absent", () => {
    const p = buildSystemPrompt(base({ theyCalledYou: "   ", distinctiveStory: " \n " }), []);
    expect(p).not.toContain("You used to call them");
    expect(p).not.toContain("Biographical memory:");
  });

  it("speech example optional fields appear only when present", () => {
    const p = buildSystemPrompt(base({ speechExamples: [{ phrase: "arre", context: "surprise" }] }), []);
    expect(p).toContain("Trigger / Situation: surprise");
    expect(p).toContain('Characteristic expression: "arre"');
    expect(p).not.toContain("Emotional state / Tone");
    expect(p).not.toContain("Underlying meaning");
    expect(p).not.toContain("Typical behavioral reaction");
  });

  it("caps demos at 3 but lists every pattern", () => {
    const ex = Array.from({ length: 6 }, (_, i) => ({ phrase: `p${i}`, context: `c${i}` }));
    const p = buildSystemPrompt(base({ speechExamples: ex }), []);
    expect((p.match(/^Pattern \d+:/gm) || []).length).toBe(6);
    expect((p.match(/Demo \d+ \(/g) || []).length).toBe(3);
  });

  it("numbers memories from 1 in the given order", () => {
    const memories: MemoryDoc[] = [{ text: "first" }, { text: "second" }, { text: "third" }];
    const p = buildSystemPrompt(base(), memories);
    expect(p).toContain("  1. first\n  2. second\n  3. third");
  });

  it("keeps quotes and newlines from user content verbatim (no crash)", () => {
    const p = buildSystemPrompt(
      base({ name: 'Nana "Bauji"', speechExamples: [{ phrase: 'bolo "haan"', context: "line1\nline2" }] }),
      [{ text: "said \"no\"\ntwice" }]
    );
    expect(p).toContain('named "Nana "Bauji""');
    expect(p).toContain("Trigger / Situation: line1\nline2");
    expect(p).toContain('said "no"\ntwice');
  });

  it("lower-cases the relationship in the identity line", () => {
    expect(buildSystemPrompt(base({ relationship: "Grandparent" }), [])).toContain("the user's grandparent");
  });

  // Regression (fixed today): relationship "Other" (one of the form's options) yields the odd
  // identity line `simulation of the user's other, named "Ammi"`.
  it("relationship 'Other' falls back to the generic identity line", () => {
    const p = buildSystemPrompt(base({ relationship: "Other" }), []);
    expect(p).not.toContain("the user's other");
    expect(p).toContain('simulation of a person named "Ammi"');
  });

  // Regression (fixed today): personaLineFor lower-cases the whole reaction, mangling names and
  // emphasis the user typed (e.g. "Calls Papa" -> "calls papa").
  it("demo lines keep the user's casing in the reaction", () => {
    const p = buildSystemPrompt(
      base({ speechExamples: [{ phrase: "bill kaun bharega?", context: "expensive phone", reaction: "Threatens to tell Papa" }] }),
      []
    );
    const demoLine = p.split("\n").find((l) => l.trimStart().startsWith("You: "))!;
    expect(demoLine).toContain("tell Papa");
  });

  // Regression (fixed today): memories are trimmed for display but not filtered, so a
  // whitespace-only memory (lib/firestore.ts only drops empty strings)
  // renders as an empty numbered line.
  it("skips whitespace-only memories", () => {
    const p = buildSystemPrompt(base(), [{ text: "real" }, { text: "   " }]);
    expect(p).not.toMatch(/ {2}2\. $/m);
  });

  it("never outputs retired oftenSaid / traits", () => {
    const p = buildSystemPrompt({ ...base(), oftenSaid: ["xyz-legacy"], traits: "trait-legacy" } as PersonaDoc, []);
    expect(p).not.toContain("xyz-legacy");
    expect(p).not.toContain("trait-legacy");
  });
});
