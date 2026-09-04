import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../lib/prompts";
import type { PersonaDoc, MemoryDoc } from "../lib/types";

function basePersona(): PersonaDoc {
  return {
    id: "p1",
    name: "Ammi",
    traits: "",
  };
}

describe("buildSystemPrompt", () => {
  it("uses the relationship line when provided", () => {
    const prompt = buildSystemPrompt(
      { ...basePersona(), relationship: "Mother" },
      []
    );
    expect(prompt).toContain("simulation of the user's mother, named \"Ammi\"");
  });

  it("falls back to a generic framing without a relationship", () => {
    const prompt = buildSystemPrompt(basePersona(), []);
    expect(prompt).toContain("simulation of a person named \"Ammi\"");
  });

  it("includes the term of address (theyCalledYou)", () => {
    const prompt = buildSystemPrompt(
      { ...basePersona(), theyCalledYou: "Betu" },
      []
    );
    expect(prompt).toContain("You used to call them \"Betu\"");
  });

  it("includes the languages line", () => {
    const prompt = buildSystemPrompt(
      { ...basePersona(), languages: ["Hindi", "English"] },
      []
    );
    expect(prompt).toContain("Languages you speak: Hindi + English");
  });

  it("renders structured speech examples with all fields", () => {
    const persona = {
      ...basePersona(),
      speechExamples: [
        {
          context: "expensive purchase",
          phrase: "bill tumhara baap bharega",
          meaning: "scolding about the cost",
          tone: "irritated",
          reaction: "questions the unnecessary expense",
        },
      ],
    };
    const prompt = buildSystemPrompt(persona, []);
    expect(prompt).toContain("Pattern 1:");
    expect(prompt).toContain("Trigger / Situation: expensive purchase");
    expect(prompt).toContain("\"bill tumhara baap bharega\"");
    expect(prompt).toContain("scolding about the cost");
    expect(prompt).toContain("irritated");
    expect(prompt).toContain("questions the unnecessary expense");
  });

  it("adds a few-shot example exchange for a structured speech example", () => {
    const persona = {
      ...basePersona(),
      speechExamples: [
        {
          context: "expensive purchase",
          phrase: "bill tumhara baap bharega",
          tone: "irritated",
          reaction: "questions the unnecessary expense",
        },
      ],
    };
    const prompt = buildSystemPrompt(persona, []);
    expect(prompt).toContain("Few-shot demonstrations:");
    expect(prompt).toContain("Demo 1 (illustrates tone & shape");
    expect(prompt).toContain("Situation: expensive purchase");
    expect(prompt).toContain("\"bill tumhara baap bharega\"");
    expect(prompt).toContain("(irritated)");
    expect(prompt).toContain("questions the unnecessary expense");
  });

  it("caps few-shot demonstrations at three", () => {
    const speechExamples = Array.from({ length: 5 }, (_, i) => ({
      context: `trigger ${i}`,
      phrase: `phrase ${i}`,
    }));
    const prompt = buildSystemPrompt({ ...basePersona(), speechExamples }, []);
    // All five patterns are listed...
    for (let i = 0; i < 5; i++) {
      expect(prompt).toContain(`Pattern ${i + 1}:`);
      expect(prompt).toContain(`Trigger / Situation: trigger ${i}`);
    }
    // ...but only the first three carry a demo.
    const demoCount = (prompt.match(/Demo \d+ \(illustrates/g) || []).length;
    expect(demoCount).toBe(3);
  });

  it("adds no few-shot demo when only legacy oftenSaid is present", () => {
    const prompt = buildSystemPrompt(
      { ...basePersona(), oftenSaid: ["khana kha liya?"] },
      []
    );
    expect(prompt).not.toContain("Few-shot demonstrations:");
  });

  it("does not include behavioral section when no examples or oftenSaid", () => {
    const prompt = buildSystemPrompt(basePersona(), []);
    expect(prompt).not.toContain("BEHAVIORAL EXECUTION RULE");
    expect(prompt).not.toContain("Unstructured phrases they used");
  });

  it("renders legacy oftenSaid list", () => {
    const prompt = buildSystemPrompt(
      { ...basePersona(), oftenSaid: ["khana kha liya?", "sona time"] },
      []
    );
    expect(prompt).toContain("Unstructured phrases they used (Legacy)");
    expect(prompt).toContain("1. \"khana kha liya?\"");
    expect(prompt).toContain("2. \"sona time\"");
  });

  it("includes saved memories as a numbered list", () => {
    const memories: MemoryDoc[] = [
      { text: "loved gardening" },
      { text: "made biryani on Sundays" },
    ];
    const prompt = buildSystemPrompt(basePersona(), memories);
    expect(prompt).toContain("1. loved gardening");
    expect(prompt).toContain("2. made biryani on Sundays");
  });

  it("indicates when there are no additional memories", () => {
    const prompt = buildSystemPrompt(basePersona(), []);
    expect(prompt).toContain("(no additional memories saved yet)");
  });

  it("includes the anti-generic-chatbot discipline section", () => {
    const prompt = buildSystemPrompt(basePersona(), []);
    expect(prompt).toContain("STRICT ANTI-CHATBOT RULE");
  });

  it("includes the simulation boundary note", () => {
    const prompt = buildSystemPrompt(basePersona(), []);
    expect(prompt).toContain(
      "This conversation is an AI simulation based on memories"
    );
  });

  it("does not invent the theyCalledYou line when absent", () => {
    const prompt = buildSystemPrompt(basePersona(), []);
    expect(prompt).not.toContain("You used to call them");
  });
});
