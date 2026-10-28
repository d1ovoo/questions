// Generator settings. Every value can be overridden in .env.local.
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
};
const str = (name: string, fallback: string) => process.env[name] || fallback;

export const gen = {
  // source: Wikipedia Vital articles, most viewed first; stop below this many views/day
  minDailyViews: num("GEN_MIN_DAILY_VIEWS", 150), // average over the last 30 days
  minArticleBytes: num("GEN_MIN_ARTICLE_BYTES", 6000), // wikitext size; filters out stubs
  minExtractChars: num("GEN_MIN_EXTRACT_CHARS", 1500),
  maxExtractChars: num("GEN_MAX_EXTRACT_CHARS", 4000), // text sent to the LLM
  userAgent: str(
    "GEN_USER_AGENT",
    "questions-trivia-generator/1.0 (https://github.com/; offline batch question generation)",
  ),

  // questions asked from each article in one LLM call
  questionsPerArticle: num("GEN_QUESTIONS_PER_ARTICLE", 3),
  // articles processed at the same time (Ollama: also set OLLAMA_NUM_PARALLEL)
  concurrency: num("GEN_CONCURRENCY", 3),

  // dedup: cosine similarity above this against any existing question = duplicate
  similarityThreshold: num("GEN_SIMILARITY_THRESHOLD", 0.85),

  // LLM provider: "ollama" (local, default) or "openai" (any OpenAI-compatible API,
  // e.g. a free tier of Groq, Gemini, OpenRouter)
  provider: str("LLM_PROVIDER", "ollama") as "ollama" | "openai",
  ollamaUrl: str("OLLAMA_URL", "http://localhost:11434"),
  ollamaModel: str("OLLAMA_MODEL", "qwen2.5:7b"),
  openaiBaseUrl: str("OPENAI_BASE_URL", "https://api.groq.com/openai/v1"),
  openaiApiKey: str("OPENAI_API_KEY", ""),
  openaiModel: str("OPENAI_MODEL", "llama-3.3-70b-versatile"),
  // optional different model for the verification pass (defaults to the same one)
  verifyModel: str("LLM_VERIFY_MODEL", ""),
  // pause between LLM calls, useful for rate-limited free tiers
  llmDelayMs: num("LLM_DELAY_MS", 0),

  stateFile: "scripts/.state.json",
  listFile: "scripts/.vital-articles.json",
};
