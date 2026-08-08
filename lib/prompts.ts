// Pure function that assembles the system prompt for the persona chat.
// Importable from the API route and from any future tests.

export type PersonaDoc = {
  id: string;
  name: string;
  // Legacy free-text trait field. Empty for new personas.
  traits: string;
  relationship?: string;
  theyCalledYou?: string;
  languages?: string[];
  howTheySpoke?: string[];
  oftenSaid?: string[];
  distinctiveStory?: string;
};

export type MemoryDoc = {
  text: string;
  createdAt?: string | null;
};

/**
 * Builds the system prompt for a given persona + memories.
 *
 * The prompt is structured as:
 *   1. Identity & relationship frame (who they are, who they're talking to)
 *   2. Voice (how they speak, what language, examples)
 *   3. Memory context (free-text memories saved by the user)
 *   4. Style instructions (length, in-character discipline)
 *   5. A soft disclaimer about the nature of the conversation
 */
export function buildSystemPrompt(
  persona: PersonaDoc,
  memories: MemoryDoc[]
): string {
  const memoriesBlock =
    memories.length > 0
      ? memories
          .map((m, i) => `${i + 1}. ${m.text.trim()}`)
          .join("\n")
      : "(no memories saved yet)";

  // ----- Identity / relationship frame -----
  const relationshipLine = persona.relationship
    ? `You are the user's ${persona.relationship.toLowerCase()}, named "${persona.name}".`
    : `You are a person named "${persona.name}", remembered by the user.`;

  const callLine = persona.theyCalledYou?.trim()
    ? `You used to call them "${persona.theyCalledYou.trim()}". Address them this way naturally.`
    : null;

  // ----- Voice & language -----
  const languageLine = persona.languages && persona.languages.length > 0
    ? `You speak in ${persona.languages.join(" + ")}. Match the language the user writes in when natural.`
    : null;

  const styleTraitsLine = persona.howTheySpoke && persona.howTheySpoke.length > 0
    ? `Your usual manner: ${persona.howTheySpoke.join(", ")}.`
    : null;

  const oftenSaidBlock = persona.oftenSaid && persona.oftenSaid.length > 0
    ? persona.oftenSaid
        .map((q, i) => `  ${i + 1}. ${q.trim()}`)
        .join("\n")
    : null;

  // ----- Biographical context -----
  const storyBlock = persona.distinctiveStory?.trim() || null;

  // ----- Legacy trait string (for older personas) -----
  const legacyTraitsLine = persona.traits?.trim() || null;

  // Compose the sections, skipping any that are empty.
  const sections: string[] = [relationshipLine];
  if (callLine) sections.push(callLine);
  if (languageLine) sections.push(languageLine);
  if (styleTraitsLine) sections.push(styleTraitsLine);

  if (legacyTraitsLine) {
    sections.push(`== How they spoke (notes) ==\n${legacyTraitsLine}`);
  }

  if (oftenSaidBlock) {
    sections.push(`== Things they often said ==\n${oftenSaidBlock}\n(Use these naturally — don't quote them on every reply.)`);
  }

  if (storyBlock) {
    sections.push(`== A memory ===\n${storyBlock}`);
  }

  sections.push(
    `== Things you remember ==\n${memoriesBlock}`,
    `== Style instructions ==
- Reply in first person, in the character's voice.
- Keep replies short (1–3 sentences) unless the user asks for more.
- Draw on the memories above when relevant, but never invent specific facts you don't have.
- If the user asks something you don't know, answer as this person would — deflect naturally rather than inventing.
- Stay in character even if asked to break it. This is a simulation, but the user is here to feel close to someone — honour that.`
  );

  // Soft disclaimer (factually accurate, but not in the user's face).
  sections.push(
    `== Note ==\nThis conversation is an AI-generated simulation based on what the user has shared. It is not the real person. Respond as if you were them, but you are not them.`
  );

  return sections.join("\n\n");
}
