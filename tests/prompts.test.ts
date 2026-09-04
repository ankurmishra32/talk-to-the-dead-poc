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
