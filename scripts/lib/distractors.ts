// Wrong options for multiple choice. Years and numbers are made in code (an LLM is bad
// at plausible near-misses); everything else comes from the LLM and is validated here.
import { isCorrect, normalize } from "../../lib/answer";
import { completeJSON } from "./llm";

type Q = { question: string; answer: string; accepted_answers: string[]; answer_type: string | null };

const pick = <T>(items: T[], n: number): T[] => {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
};

// 1939 -> e.g. 1936, 1941, 1945;  "26 years" -> e.g. "22 years", "25 years", "30 years"
export function numericDistractors(answer: string, answerType: string | null): string[] | null {
  const a = answer.trim();
  if (/^\d{3,4}$/.test(a) && (answerType === "year" || answerType === null)) {
    const y = Number(a);
    const now = new Date().getFullYear();
    const offsets = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15].flatMap((d) => [d, -d]);
    const years = offsets.map((d) => y + d).filter((v) => v > 0 && (y > now || v <= now));
    return pick(years, 3).map(String);
  }
  const m = a.match(/^(\d{1,3})(\s+[^\d].*)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const suffix = m[2] ?? "";
  const spread = Math.max(3, Math.round(n * 0.4));
  const values: number[] = [];
  for (let d = 1; d <= spread; d++) values.push(n + d, n - d);
  return pick(values.filter((v) => v > 0), 3).map((v) => `${v}${suffix}`);
}

// Three distinct wrong answers that can't be mistaken for the right one, or null.
export function validDistractors(list: unknown, q: Q): string[] | null {
  if (!Array.isArray(list)) return null;
  const seen = new Set([normalize(q.answer)]);
  const out: string[] = [];
  for (const item of list) {
    const d = typeof item === "string" ? item.trim().replace(/\.$/, "") : "";
    const n = normalize(d);
    if (!d || d.length > 60 || !n || seen.has(n)) continue;
    // reject anything the checker would accept as the right answer, either way round
    if (isCorrect(d, q.answer, q.accepted_answers, 0.85, q.answer_type) || isCorrect(q.answer, d)) continue;
    seen.add(n);
    out.push(d);
  }
  return out.length >= 3 ? out.slice(0, 3) : null;
}

const SYSTEM = "You write and check multiple-choice quiz options. You reply with JSON only.";

// Ask the LLM for wrong options for several questions at once.
export async function llmDistractors(items: Q[]): Promise<(string[] | null)[]> {
  const prompt = `For each trivia question below, write 3 WRONG answers for a multiple-choice quiz.
- Same kind and format as the correct answer (a person for a person, a country for a country, a similar-length title for a title).
- Plausible enough that someone unsure might pick them, but definitely wrong. Never another valid answer or a different spelling of the correct one.

${items.map((q, i) => `${i + 1}. ${q.question}\n   Correct answer: ${q.answer}`).join("\n")}

Reply with JSON only:
{"results": [{"n": 1, "wrong": ["...", "...", "..."]}]}`;
  const raw = await completeJSON(SYSTEM, prompt, "generate");
  const results = Array.isArray(raw.results) ? (raw.results as Record<string, unknown>[]) : [];
  return items.map((q, i) => {
    const r = results.find((x) => Number(x?.n) === i + 1) ?? results[i];
    return validDistractors(r?.wrong, q);
  });
}

// Without seeing which is right, the checker must pick the correct option and say no
// other option is also correct. Used for questions whose source text isn't at hand.
export async function checkOptions(items: { question: string; answer: string; options: string[] }[]): Promise<boolean[]> {
  const prompt = `For each multiple-choice question, choose the correct option using your knowledge.
Also say whether more than one option could reasonably be considered correct.

${items.map((q, i) => `${i + 1}. ${q.question}\n${q.options.map((o, j) => `   ${"ABCD"[j]}) ${o}`).join("\n")}`).join("\n")}

Reply with JSON only:
{"results": [{"n": 1, "choice": "<the correct option, copied exactly>", "more_than_one_correct": false}]}`;
  const raw = await completeJSON(SYSTEM, prompt, "verify");
  const results = Array.isArray(raw.results) ? (raw.results as Record<string, unknown>[]) : [];
  return items.map((q, i) => {
    const r = results.find((x) => Number(x?.n) === i + 1) ?? results[i];
    if (!r || r.more_than_one_correct !== false) return false;
    const choice = typeof r.choice === "string" ? r.choice.replace(/^[A-D]\)\s*/, "") : "";
    return normalize(choice) === normalize(q.answer);
  });
}

export function shuffle<T>(items: T[]): T[] {
  return pick(items, items.length);
}
