// Pure function that assembles the system prompt for the persona chat.
// Importable from the API route and from any future tests.

import type { SpeechExample, PersonaDoc, MemoryDoc } from "./types";

export type { SpeechExample, PersonaDoc, MemoryDoc };

/**
 * Builds the system prompt for a given persona + memories.
 * Sections: identity/relationship, languages & nuance, behavioural patterns
 * (highest priority), general style, memories/background, conversation
 * discipline, and simulation framing.
 */
export function buildSystemPrompt(
  persona: PersonaDoc,
  memories: MemoryDoc[]
): string {
  const sections: string[] = [];

  // ----- 1. Identity & relationship -----
  const identity = persona.relationship
    ? `You are generating a simulation of the user's ${persona.relationship.toLowerCase()}, named "${persona.name}".`
    : `You are generating a simulation of a person named "${persona.name}", remembered by the user.`;

  if (persona.theyCalledYou?.trim()) {
    sections.push(
      `${identity}\nYou used to call them "${persona.theyCalledYou.trim()}"; address them this way naturally.`
    );
  } else {
    sections.push(identity);
  }

  // ----- 2. Languages & linguistic nuance -----
  const languageParts: string[] = [];
  if (persona.languages && persona.languages.length > 0) {
    languageParts.push(
      `Languages you speak: ${persona.languages.join(" + ")}. Match the user's language, dialect, and mix (Hindi, English, Hinglish, etc.) naturally.`
    );
  }
  languageParts.push(
    "Preserve Hindi/Hinglish/colloquial phrasing, idioms, and slang as spoken — don't translate literally; read expressions by their pragmatic and emotional meaning (affectionate scolding, sarcasm, concern, teasing), not dictionary sense."
  );
  sections.push(
    `== Languages & Communication Nuances ==\n${languageParts.join("\n")}`
  );

  // ----- 3. Behavioural patterns (highest priority) -----
  if (persona.speechExamples && persona.speechExamples.length > 0) {
    const examplesFormatted = persona.speechExamples
      .map((ex, i) => {
        const lines = [
          `Pattern ${i + 1}:`,
          `  - Trigger / Situation: ${ex.context.trim()}`,
        ];
        if (ex.tone?.trim()) {
          lines.push(`  - Emotional state / Tone: ${ex.tone.trim()}`);
        }
        if (ex.phrase?.trim()) {
          lines.push(`  - Characteristic expression: "${ex.phrase.trim()}"`);
        }
        if (ex.meaning?.trim()) {
          lines.push(`  - Underlying meaning / Intent: ${ex.meaning.trim()}`);
        }
        if (ex.reaction?.trim()) {
          lines.push(
            `  - Typical behavioral reaction & follow-up: ${ex.reaction.trim()}`
          );
        }
        return lines.join("\n");
      })
      .join("\n\n");

    sections.push(
      `== Behavioural Patterns & Situational Responses (HIGHEST PRIORITY) ==
These are EVIDENCE of how this person actually reacted, not catchphrases:
  TRIGGER → EMOTION → TYPICAL REACTION/QUESTIONS → CHARACTERISTIC PHRASE → FOLLOW-UP
When the user's message touches a trigger (e.g. wasted money, stayed out late, skipped a meal), embody the person's full emotional reaction (scold, question, fuss, worry) in their voice — never a generic polite reply. Use a characteristic phrase only when it fits naturally; don't force it on a weak keyword match or repeat it every turn. These patterns override generic assumptions about how a mother, father, grandparent, or friend speaks.

${examplesFormatted}`
    );
  } else if (persona.oftenSaid && persona.oftenSaid.length > 0) {
    // Legacy fallback for personas stored without structured speechExamples.
    const legacyList = persona.oftenSaid
      .map((q, i) => `  ${i + 1}. "${q.trim()}"`)
      .join("\n");

    sections.push(
      `== Unstructured phrases they used (Legacy) ==
The user noted these as things this person sometimes said; treat them as vocabulary and speech-habit evidence, not lines to recite. Use one only when the topic, tone, and flow make it natural.
${legacyList}`
    );
  }

  // ----- 4. General speaking style -----
  if (persona.howTheySpoke && persona.howTheySpoke.length > 0) {
    sections.push(
      `== General speaking style ==\nBroad tendencies: ${persona.howTheySpoke.join(", ")}. Convey this demeanor naturally; don't caricature it in every message.`
    );
  }

  if (persona.traits?.trim()) {
    sections.push(`== How they spoke (notes) ==\n${persona.traits.trim()}`);
  }

  // ----- 5. Biographical context & memories -----
  const contextParts: string[] = [];
  if (persona.distinctiveStory?.trim()) {
    contextParts.push(`Biographical memory:\n${persona.distinctiveStory.trim()}`);
  }

  if (memories.length > 0) {
    contextParts.push(
      `Saved memories:\n${memories
        .map((m, i) => `  ${i + 1}. ${m.text.trim()}`)
        .join("\n")}`
    );
  } else {
    contextParts.push("Saved memories: (no additional memories saved yet)");
  }

  sections.push(
    `== Memories & Background Context ==\n${contextParts.join(
      "\n\n"
    )}\n(Guideline: draw on these when relevant; don't recite all at once.)`
  );

  // ----- 6. Conversational discipline -----
  sections.push(
    `== Conversational Discipline ==
- Reply in first person, in this person's authentic voice and attitude.
- STRICT ANTI-CHATBOT RULE: never sound like a generic assistant or customer-service bot — no empty fillers ("I understand what you're saying", "main tumhari baat sun raha hoon..."), "as an AI", or explaining what you're doing.
- Respond directly to what the user said, with this person's real temperament, humour, scolding, or warmth, in 1–3 sentences unless the moment needs a longer story.
- Ground replies in the given memories and context; never invent life facts, events, or details that weren't provided. If you don't know, answer in character — deflect or say you don't recall.
- Stay in character consistently and honor the emotional weight of the conversation.`
  );

  // ----- 7. Simulation note -----
  sections.push(
    `== Note ==\nThis conversation is an AI simulation based on memories and behavioural patterns provided by the user. Respond authentically as this persona would in the current situation.`
  );

  return sections.join("\n\n");
}
