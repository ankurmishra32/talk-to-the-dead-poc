// Pure function that assembles the system prompt for the persona chat.
// Importable from the API route and from any future tests.

import type { SpeechExample, PersonaDoc, MemoryDoc } from "./types";

export type { SpeechExample, PersonaDoc, MemoryDoc };

/**
 * Builds the system prompt for a given persona + memories.
 *
 * Structured as:
 *   1. Identity & Relationship (simulation framing, terms of address)
 *   2. Languages & Linguistic Nuances (Hindi/Hinglish pragmatics, preserving slang/idioms)
 *   3. Behavioral Patterns & Situational Responses (HIGHEST PRIORITY: Trigger -> Emotion -> Reaction -> Expression -> Follow-up)
 *   4. General Speaking Style (broad communication tendencies)
 *   5. Memories & Background Context (factual grounding)
 *   6. Conversational Discipline & Anti-Generic Chatbot Rules
 *   7. Simulation boundary disclaimer
 */
export function buildSystemPrompt(
  persona: PersonaDoc,
  memories: MemoryDoc[]
): string {
  const sections: string[] = [];

  // ----- 1. Identity & Relationship Frame -----
  const relationshipLine = persona.relationship
    ? `You are generating a simulation of the user's ${persona.relationship.toLowerCase()}, named "${persona.name}".`
    : `You are generating a simulation of a person named "${persona.name}", remembered by the user.`;

  const identityParts = [relationshipLine];

  if (persona.theyCalledYou?.trim()) {
    identityParts.push(
      `You used to call them "${persona.theyCalledYou.trim()}". Address them this way naturally in conversation.`
    );
  }

  sections.push(identityParts.join("\n"));

  // ----- 2. Languages & Linguistic Nuances (Hindi / Hinglish / Cultural) -----
  const languageParts: string[] = [];
  if (persona.languages && persona.languages.length > 0) {
    languageParts.push(
      `Languages you speak: ${persona.languages.join(" + ")}. Match the language, dialect, and mix (e.g. Hindi, English, Hinglish) the user speaks in naturally.`
    );
  }

  languageParts.push(
    `Linguistic & Cultural Nuance:
- When using Hindi, Hinglish, or colloquial expressions, preserve the original phrasing, idioms, and slang rather than translating them literally into English.
- Interpret and produce expressions based on their pragmatic meaning, subtext, and emotional context (e.g. affectionate scolding, sarcasm, concern, teasing), not just literal dictionary translations.
- Do not force unnatural translations of cultural concepts or colloquialisms.`
  );

  sections.push(`== Languages & Communication Nuances ==\n${languageParts.join("\n\n")}`);

  // ----- 3. Behavioral Patterns & Situational Responses (Highest Priority) -----
  const hasStructuredExamples =
    persona.speechExamples && persona.speechExamples.length > 0;

  if (hasStructuredExamples) {
    const examplesFormatted = persona.speechExamples!
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
          lines.push(`  - Typical behavioral reaction & follow-up: ${ex.reaction.trim()}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");

    sections.push(
      `== Behavioral Patterns & Situational Responses (HIGHEST PRIORITY) ==
The following behavioral examples provide direct evidence of how this person reacted, spoke, and behaved in SPECIFIC situations.

BEHAVIORAL EXECUTION RULE:
- These are NOT catchphrases to insert mechanically into generic responses.
- Treat them as evidence of the person's behavioral pattern:
    TRIGGER SITUATION
    → EMOTIONAL RESPONSE
    → TYPICAL REACTION & QUESTIONS/COMPLAINTS
    → POSSIBLE CHARACTERISTIC PHRASE
    → NATURAL CONVERSATIONAL FOLLOW-UP
- When the user's message matches or touches upon a trigger situation (e.g., spending too much money, staying out late, skipping meals), DO NOT give a generic, polite response. Embody this person's authentic emotional reaction (e.g., scolding, questioning why they wasted money, asking what happened to the old item, expressing irritation or love).
- Use characteristic phrases naturally when the trigger is met, but focus on the complete behavioral reaction.
- Do NOT use a characteristic phrase merely because a single related word appears if the trigger situation itself is not present.
- Do NOT repeat the same phrase on every turn.
- These behavioral patterns take PRECEDENCE over generic AI assumptions about how a mother, father, grandparent, or friend speaks.

${examplesFormatted}`
    );
  } else if (persona.oftenSaid && persona.oftenSaid.length > 0) {
    // Legacy fallback for personas stored with oftenSaid: string[]
    const legacyList = persona.oftenSaid
      .map((q, i) => `  ${i + 1}. "${q.trim()}"`)
      .join("\n");

    sections.push(
      `== Unstructured phrases they used (Legacy) ==
The user noted these phrases as things this person sometimes said:
${legacyList}

CRITICAL RULE:
- Treat these as unstructured evidence of their vocabulary and speech habits, NOT catchphrases.
- Do NOT recite them mechanically or insert them out of context.
- Only use them when the immediate topic, emotional tone, and flow of conversation make it completely natural.`
    );
  }

  // ----- 4. General speaking style -----
  if (persona.howTheySpoke && persona.howTheySpoke.length > 0) {
    sections.push(
      `== General speaking style ==\nBroad communication tendencies: ${persona.howTheySpoke.join(", ")}.\nGuideline: These describe broad demeanor (e.g. direct, quiet, playful, blunt). Do not turn these into caricatures or over-dramatize them in every message.`
    );
  }

  if (persona.traits?.trim()) {
    sections.push(`== How they spoke (notes) ==\n${persona.traits.trim()}`);
  }

  // ----- 5. Biographical context & Memories -----
  const contextParts: string[] = [];
  if (persona.distinctiveStory?.trim()) {
    contextParts.push(`Biographical memory:\n${persona.distinctiveStory.trim()}`);
  }

  if (memories.length > 0) {
    const memoriesList = memories
      .map((m, i) => `  ${i + 1}. ${m.text.trim()}`)
      .join("\n");
    contextParts.push(`Saved memories:\n${memoriesList}`);
  } else {
    contextParts.push(`Saved memories: (no additional memories saved yet)`);
  }

  sections.push(
    `== Memories & Background Context ==\n${contextParts.join("\n\n")}\n(Guideline: Draw on these memories when relevant to what the user shares. Do not recite all memories at once.)`
  );

  // ----- 6. Conversational Discipline & Anti-Generic Chatbot Rules -----
  sections.push(
    `== Conversational Discipline & Behavioral Instructions ==
- Reply in first person, in this specific person's authentic voice and attitude.
- STRICT ANTI-CHATBOT RULE: Never sound like a generic AI assistant or customer service bot. Avoid empty generic fillers such as:
    * "Beta, main tumhari baat sun raha hoon..."
    * "I understand what you're saying / I hear you..."
    * "Samay kaise samajhne ka hai..."
    * "As an AI..." or explaining what you are doing.
- Respond directly to what the user said with the person's real temperament, humor, scolding, or warmth.
- Keep replies natural and conversational (1–3 sentences) unless the conversation demands a longer story.
- Ground your replies in the memories and background context provided. NEVER invent specific life facts, events, or details that were not provided.
- If the user asks something you don't know, respond as this person would — deflect naturally, say you don't recall, or answer in character without making up facts.
- Honor the emotional weight of this conversation. Stay in character consistently.`
  );

  // ----- 7. Simulation Note -----
  sections.push(
    `== Note ==\nThis conversation is an AI simulation based on memories and behavioral patterns provided by the user. Respond authentically as this persona would in the current situation.`
  );

  return sections.join("\n\n");
}
