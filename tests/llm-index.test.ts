import { describe, it, expect, vi, afterEach } from "vitest";

const saved = process.env.LLM_PROVIDER;

afterEach(() => {
  if (saved === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = saved;
  vi.resetModules();
});

async function loadWith(provider: string | undefined) {
  if (provider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = provider;
  vi.resetModules();
  const index = await import("../lib/llm");
  const { lmStudioAdapter } = await import("../lib/llm/lm-studio");
  const { ollamaAdapter } = await import("../lib/llm/ollama");
  return { llm: index.llmAdapter, lmStudioAdapter, ollamaAdapter };
}

describe("llm provider selection", () => {
  it("defaults to LM Studio", async () => {
    const { llm, lmStudioAdapter } = await loadWith(undefined);
    expect(llm).toBe(lmStudioAdapter);
  });

  it("selects LM Studio explicitly", async () => {
    const { llm, lmStudioAdapter } = await loadWith("lm-studio");
    expect(llm).toBe(lmStudioAdapter);
  });

  it("selects Ollama", async () => {
    const { llm, ollamaAdapter } = await loadWith("ollama");
    expect(llm).toBe(ollamaAdapter);
  });

  it("throws a clear error for an unknown provider", async () => {
    process.env.LLM_PROVIDER = "openai";
    vi.resetModules();
    await expect(import("../lib/llm")).rejects.toThrow('Unknown LLM_PROVIDER: "openai"');
  });

  // Regression (fixed today): LLM_PROVIDER is matched exactly, so common variants like "Ollama" or
  // " ollama" (stray whitespace in a hosting dashboard) crash the module at
  // import time, which takes down the whole /api/chat route (500 on every
  // request) rather than one misconfigured value being normalised.
  it("tolerates case and surrounding whitespace in LLM_PROVIDER", async () => {
    const { llm, ollamaAdapter } = await loadWith(" Ollama ");
    expect(llm).toBe(ollamaAdapter);
  });
});
