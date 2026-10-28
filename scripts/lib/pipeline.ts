// Article -> candidate question -> validated -> verified.
import { categories, type Category } from "../../lib/config";
import { isCorrect, normalize } from "../../lib/answer";
import { completeJSON } from "./llm";
import type { Article } from "./wikipedia";

export type Candidate = {
  question: string;
  answer: string;
  accepted_answers: string[];
  category: Category;
  difficulty: number;
  source_url: string;
  source_title: string;
};

export type Result = { ok: true; q: Candidate } | { ok: false; reason: string; detail?: string };

const GEN_SYSTEM = "You write trivia questions for a quiz game. You reply with JSON only.";

const genPrompt = (a: Article) => `Write ONE trivia question about a specific, interesting fact stated in the text below.

Rules:
- One sentence ending with "?". It must make sense on its own to someone who has never seen this text: name the subject explicitly. Never mention "the article", "the text", "the passage" or "according to".
- The answer is short: ideally 1-3 words, a name, a number or a year. It must be stated in the text.
- Exactly one answer can be correct. Avoid questions that several people, places or dates could answer.
- Do not put the answer, or part of it, in the question.
- Prefer facts a curious general audience would find interesting. Avoid administrative details, exact statistics and minor dates.
- accepted_answers: other ways of writing the SAME answer (alternative spellings, surname only for well-known people, abbreviations, numerals vs words). Never include different answers.
- category: one of ${categories.join(", ")}.
- difficulty: 1 (almost everyone knows it) to 10 (only experts know it), for a general audience.
- evidence: the sentence from the text that contains the answer.

Title: ${a.title}
Text:
"""
${a.text}
"""

Reply with JSON only:
{"question": "...", "answer": "...", "accepted_answers": ["..."], "category": "...", "difficulty": 5, "evidence": "..."}`;

const VERIFY_SYSTEM = "You are a strict fact-checker for a quiz game. You reply with JSON only.";

const verifyPrompt = (a: Article, question: string) => `Answer the trivia question using only the source text, then judge the question.

Source text:
"""
${a.text}
"""

Question: ${question}

Reply with JSON only:
{"answer": "<shortest correct answer, 1-5 words, or null if the text does not answer it>",
 "supported": <true if the text clearly states the answer>,
 "unambiguous": <true if exactly one reasonable answer exists, false if other people, places, dates or things could also fit>,
 "standalone": <true if the question makes sense without seeing the text and does not refer to it>,
 "reason": "<short reason if anything is false>"}`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Normalized phrase appears as whole words inside normalized text.
const containsPhrase = (haystack: string, needle: string) =>
  needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);

function validate(raw: Record<string, unknown>, a: Article): Result {
  const question = str(raw.question).replace(/\s+/g, " ");
  const answer = str(raw.answer).replace(/\.$/, "");
  if (!question || !answer) return { ok: false, reason: "malformed" };
  if (!question.endsWith("?") || question.length < 15 || question.length > 220)
    return { ok: false, reason: "bad question shape", detail: question };
  if (/\b(article|passage|the text|according to|mentioned)\b/i.test(question))
    return { ok: false, reason: "refers to source", detail: question };
  if (answer.length > 60 || answer.split(/\s+/).length > 6)
    return { ok: false, reason: "answer too long", detail: answer };

  const nq = normalize(question);
  const na = normalize(answer);
  if (!na) return { ok: false, reason: "malformed" };
  if (containsPhrase(nq, na)) return { ok: false, reason: "answer in question", detail: question };

  const accepted = Array.isArray(raw.accepted_answers)
    ? [...new Set(raw.accepted_answers.map(str).filter((s) => s && s.length <= 60 && normalize(s) !== na))].slice(0, 8)
    : [];

  // grounding: a non-numeric answer (or one of its forms) must appear in the source
  const nt = normalize(a.text.replace(/\n/g, " "));
  const grounded = /^\d/.test(na) || [answer, ...accepted].some((s) => containsPhrase(nt, normalize(s)));
  if (!grounded) return { ok: false, reason: "answer not in text", detail: answer };

  const category = (categories as readonly string[]).includes(str(raw.category).toLowerCase())
    ? (str(raw.category).toLowerCase() as Category)
    : "other";
  const d = Math.round(Number(raw.difficulty));
  const difficulty = Number.isFinite(d) ? Math.min(10, Math.max(1, d)) : 5;

  return {
    ok: true,
    q: {
      question,
      answer,
      accepted_answers: accepted,
      category,
      difficulty,
      source_url: a.url,
      source_title: a.title,
    },
  };
}

// The verifier answers blind (it never sees our answer), so agreement is meaningful.
function agrees(verifierAnswer: string, q: Candidate): boolean {
  if (isCorrect(verifierAnswer, q.answer, q.accepted_answers)) return true;
  const v = normalize(verifierAnswer);
  return [q.answer, ...q.accepted_answers].some((s) => {
    const n = normalize(s);
    return n.length >= 3 && (containsPhrase(v, n) || containsPhrase(n, v));
  });
}

export async function questionFrom(a: Article): Promise<Result> {
  const raw = await completeJSON(GEN_SYSTEM, genPrompt(a), "generate");
  const v = validate(raw, a);
  if (!v.ok) return v;

  const check = await completeJSON(VERIFY_SYSTEM, verifyPrompt(a, v.q.question), "verify");
  if (check.supported !== true) return { ok: false, reason: "verify: not supported", detail: str(check.reason) };
  if (check.unambiguous !== true) return { ok: false, reason: "verify: ambiguous", detail: str(check.reason) };
  if (check.standalone !== true) return { ok: false, reason: "verify: not standalone", detail: str(check.reason) };
  const theirs = str(check.answer);
  if (!theirs || !agrees(theirs, v.q))
    return { ok: false, reason: "verify: different answer", detail: `${v.q.answer} vs ${theirs}` };

  return v;
}
