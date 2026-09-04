// Server-side LLM factory. Imported only by API routes.
//
// Selection is env-var driven via LLM_PROVIDER. The default is the local
// LM Studio adapter. To use Ollama, set LLM_PROVIDER=ollama and configure
// OLLAMA_HOST / OLLAMA_MODEL (see lib/llm/ollama.ts). For LM Studio, the
// LM_STUDIO_BASE_URL / LM_STUDIO_MODEL vars apply (see lib/llm/lm-studio.ts).

import type { LlmAdapter } from "./types";
import { lmStudioAdapter } from "./lm-studio";
import { ollamaAdapter } from "./ollama";

const PROVIDER = process.env.LLM_PROVIDER || "lm-studio";

function getLlm(): LlmAdapter {
  switch (PROVIDER) {
    case "lm-studio":
      return lmStudioAdapter;
    case "ollama":
      return ollamaAdapter;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER: "${PROVIDER}". Supported values: lm-studio, ollama.`
      );
  }
}

export const llmAdapter: LlmAdapter = getLlm();
