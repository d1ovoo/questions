// The single place that talks to an LLM. Swap providers with LLM_PROVIDER.
import { gen } from "./config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ollama(system: string, user: string, model: string): Promise<string> {
  const res = await fetch(`${gen.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0.4 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new LlmError(res.status, await res.text());
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

async function openai(system: string, user: string, model: string): Promise<string> {
  const res = await fetch(`${gen.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gen.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new LlmError(res.status, await res.text());
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

class LlmError extends Error {
  constructor(public status: number, body: string) {
    super(`LLM ${status}: ${body.slice(0, 300)}`);
  }
}

// Fail fast with a useful message instead of retrying forever.
export async function checkProvider(): Promise<void> {
  if (gen.provider === "openai") {
    if (!gen.openaiApiKey) throw new Error("LLM_PROVIDER=openai needs OPENAI_API_KEY");
    return;
  }
  const res = await fetch(`${gen.ollamaUrl}/api/tags`).catch(() => null);
  if (!res?.ok) throw new Error(`Ollama is not reachable at ${gen.ollamaUrl}. Is it running?`);
  const { models } = (await res.json()) as { models: { name: string }[] };
  for (const m of new Set([modelName("generate"), modelName("verify")])) {
    const pulled = models.some((x) => x.name === m || x.name === `${m}:latest`);
    if (!pulled) throw new Error(`Ollama model "${m}" is not pulled. Run: ollama pull ${m}`);
  }
}

export function modelName(purpose: "generate" | "verify"): string {
  if (purpose === "verify" && gen.verifyModel) return gen.verifyModel;
  return gen.provider === "openai" ? gen.openaiModel : gen.ollamaModel;
}

// Ask for a JSON object. Retries on rate limits, server errors and invalid JSON.
export async function completeJSON(
  system: string,
  user: string,
  purpose: "generate" | "verify",
): Promise<Record<string, unknown>> {
  const model = modelName(purpose);
  const call = gen.provider === "openai" ? openai : ollama;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (gen.llmDelayMs) await sleep(gen.llmDelayMs);
    try {
      const text = await call(system, user, model);
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      return JSON.parse(json);
    } catch (e) {
      lastError = e;
      const retryable = !(e instanceof LlmError) || e.status === 429 || e.status >= 500;
      if (!retryable) throw e;
      await sleep(Math.min(60_000, 2000 * 2 ** attempt));
    }
  }
  throw lastError;
}
