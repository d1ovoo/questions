// Difficulty on one fixed scale, anchored with examples, used by the generator's verifier
// and by the re-rate script. 1-3 easy, 4-7 medium, 8-10 hard.
import { completeJSON } from "./llm";

export const DIFFICULTY_SCALE = `Difficulty, 1 to 10, for a player who has not seen any source text and gets 4 options:
- 1-3 easy: common knowledge, almost anyone knows it.
  1 = What is the capital of France? (Paris) · 2 = Who painted the Mona Lisa? (Leonardo da Vinci) · 3 = What is the capital of Canada? (Ottawa)
- 4-7 medium: easy for someone interested in the topic, unknown to many others.
  4 = What is the chemical symbol for gold? (Au) · 5 = Who created the PHP programming language? (Rasmus Lerdorf) · 6 = Which region of Czechoslovakia did Nazi Germany annex in 1938? (Sudetenland) · 7 = Who led the founding of FC Barcelona? (Joan Gamper)
- 8-10 hard: only if you know this specific area well.
  8 = Which composer wrote the opera "Wozzeck"? (Alban Berg) · 10 = Who first used the term "base" in its modern chemical sense? (Guillaume-François Rouelle)
Most questions are NOT easy. Use 1-3 only for things nearly everyone knows.`;

// Questions from very popular articles tend to be easier, obscure ones harder.
export function popularityAdjust(dailyViews: number | undefined): number {
  if (!dailyViews) return 0;
  if (dailyViews >= 30_000) return -1;
  if (dailyViews >= 10_000) return -0.5;
  if (dailyViews <= 500) return 1;
  if (dailyViews <= 1_500) return 0.5;
  return 0;
}

export function blend(llmDifficulty: unknown, dailyViews: number | undefined, fallback: number): number {
  const d = Number(llmDifficulty);
  const base = Number.isFinite(d) && d >= 1 && d <= 10 ? d : fallback;
  return Math.min(10, Math.max(1, Math.round(base + popularityAdjust(dailyViews))));
}

const SYSTEM = "You judge how hard quiz questions are. You reply with JSON only.";

// Rate several questions in one call. Returns null where the model gave nothing usable.
export async function rateDifficulty(items: { question: string; answer: string; options: string[] }[]): Promise<(number | null)[]> {
  const prompt = `${DIFFICULTY_SCALE}

Rate each multiple-choice question:
${items.map((q, i) => `${i + 1}. ${q.question}\n   Options: ${q.options.join(" · ")}\n   Correct: ${q.answer}`).join("\n")}

Reply with JSON only:
{"results": [{"n": 1, "difficulty": 5}]}`;
  const raw = await completeJSON(SYSTEM, prompt, "verify");
  const results = Array.isArray(raw.results) ? (raw.results as Record<string, unknown>[]) : [];
  return items.map((_, i) => {
    const r = results.find((x) => Number(x?.n) === i + 1) ?? results[i];
    const d = Number(r?.difficulty);
    return Number.isFinite(d) && d >= 1 && d <= 10 ? d : null;
  });
}
