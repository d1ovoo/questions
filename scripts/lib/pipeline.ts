// Article -> candidate questions -> validated -> verified (one LLM call each, batched per article).
import { answerTypes, categories, type AnswerType, type Category } from "../../lib/config";
import { isCorrect, normalize } from "../../lib/answer";
import { gen } from "./config";
import { completeJSON } from "./llm";
import type { Article } from "./wikipedia";

export type Candidate = {
  question: string;
  answer: string;
  accepted_answers: string[];
  category: Category;
  difficulty: number;
  answer_type: AnswerType;
  source_url: string;
  source_title: string;
};

export type Result = { ok: true; q: Candidate } | { ok: false; reason: string; detail?: string };

const GEN_SYSTEM = "You write trivia questions for a quiz game. You reply with JSON only.";

const genPrompt = (a: Article, n: number) => `Write ${n} trivia questions about "${a.title}" using facts stated in the text below. Each question must be about a different fact.

What makes a good question:
- It is about a central, notable fact: the kind of thing printed in a pub quiz or quiz book, that a well-read person could know or reasonably guess.
- Never ask about obscure details: minor relatives, minor officials, assistants, exact statistics, populations, measurements, or dates of minor events. If you would need to be a specialist in "${a.title}" to have any chance, choose another fact.
- For dates, ask for the year only. Never ask for a full date such as a birthday.
- Always name the subject ("${a.title.replace(/\s*\(.*?\)/g, "")}"), never "the novel", "the company", "he" or "she".
- Mix difficulties: at least one question should be easy.

Rules:
- One sentence ending with "?". It must make sense on its own to someone who has never seen this text: name the subject explicitly. Never mention "the article", "the text", "the passage" or "according to".
- The answer is short: ideally 1-3 words, a name, a number or a year. It must be stated in the text.
- Exactly one answer can be correct. Avoid questions that several people, places or dates could answer.
- Do not put the answer, or part of it, in the question.
- accepted_answers: other ways of writing the SAME answer (alternative spellings, surname only for well-known people, abbreviations, numerals vs words). Never include different answers.
- category: one of ${categories.join(", ")}.
- difficulty: 1 (almost everyone knows it) to 10 (only experts know it), for a general audience.
- answer_type: one of ${answerTypes.join(", ")}. Use "person" when the answer is a person's name (give their full name as the answer), "title" for a book, film, song or artwork.

Title: ${a.title}${a.topic ? `\nTopic area: ${a.topic}` : ""}
Text:
"""
${a.text}
"""

Reply with JSON only:
{"questions": [{"question": "...", "answer": "...", "accepted_answers": ["..."], "category": "...", "difficulty": 3, "answer_type": "..."}]}`;

const VERIFY_SYSTEM = "You are a strict fact-checker for a quiz game. You reply with JSON only.";

const verifyPrompt = (a: Article, questions: string[]) => `Answer each trivia question using only the source text, then judge it.

Source text:
"""
${a.text}
"""

Questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

For each question, in the same order, reply with JSON only:
{"results": [{"n": 1,
  "answer": "<shortest correct answer, 1-5 words, or null if the text does not answer it>",
  "supported": <true if the text clearly states the answer>,
  "unambiguous": <true if exactly one reasonable answer exists, false if other people, places, dates or things could also fit>,
  "standalone": <true if the question makes sense without seeing the text and does not refer to it>,
  "obscure": <true if only a specialist could know this; false for a notable fact a well-read person might know>,
  "reason": "<short reason if anything fails>"}]}`;

// fallback when the LLM says "other": the Vital articles topic area
const TOPIC_CATEGORY: Record<string, Category> = {
  People: "people",
  History: "history",
  Geography: "geography",
  Arts: "arts",
  "Biology and health sciences": "nature",
  "Physical sciences": "science",
  Mathematics: "science",
  Technology: "technology",
};

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

  // full dates ("February 3, 1984") are too exact for a quiz; a year is fine
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(answer))
    return { ok: false, reason: "full date", detail: `${question} → ${answer}` };

  // the question (or, when the subject is the answer, the answer) must name the subject
  const titleWords = normalize(a.title.replace(/\(.*?\)/g, "")).split(" ").filter((w) => w.length >= 4);
  const words = `${nq} ${na}`.split(" ");
  if (titleWords.length && !titleWords.some((t) => words.some((w) => w.startsWith(t))))
    return { ok: false, reason: "subject not named", detail: question };

  const accepted = Array.isArray(raw.accepted_answers)
    ? [...new Set(raw.accepted_answers.map(str).filter((s) => s && s.length <= 60 && normalize(s) !== na))].slice(0, 8)
    : [];

  // grounding: a non-numeric answer (or one of its forms) must appear in the source
  const nt = normalize(a.text.replace(/\n/g, " "));
  const grounded = /^\d/.test(na) || [answer, ...accepted].some((s) => containsPhrase(nt, normalize(s)));
  if (!grounded) return { ok: false, reason: "answer not in text", detail: answer };

  const said = str(raw.category).toLowerCase();
  const category =
    said !== "other" && (categories as readonly string[]).includes(said)
      ? (said as Category)
      : (TOPIC_CATEGORY[a.topic] ?? "other");
  const t = str(raw.answer_type).toLowerCase();
  const answer_type: AnswerType = (answerTypes as readonly string[]).includes(t)
    ? (t as AnswerType)
    : /^d{3,4}$/.test(na)
      ? "year"
      : "other";
  // a person's surname in the question gives the answer away too
  if (answer_type === "person") {
    const last = na.split(" ").at(-1) ?? "";
    if (last.length >= 4 && containsPhrase(nq, last)) return { ok: false, reason: "answer in question", detail: question };
  }

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
      answer_type,
      source_url: a.url,
      source_title: a.title,
    },
  };
}

// The verifier answers blind (it never sees our answer), so agreement is meaningful.
function agrees(verifierAnswer: string, q: Candidate): boolean {
  if (isCorrect(verifierAnswer, q.answer, q.accepted_answers, 0.85, q.answer_type)) return true;
  const v = normalize(verifierAnswer);
  return [q.answer, ...q.accepted_answers].some((s) => {
    const n = normalize(s);
    return n.length >= 3 && (containsPhrase(v, n) || containsPhrase(n, v));
  });
}

function judge(check: Record<string, unknown> | undefined, q: Candidate): Result {
  const why = (reason: string, extra = str(check?.reason)) =>
    ({ ok: false, reason, detail: `${q.question}${extra ? ` (${extra})` : ""}` }) as const;
  if (!check) return why("verify: missing");
  if (check.supported !== true) return why("verify: not supported");
  if (check.unambiguous !== true) return why("verify: ambiguous");
  if (check.standalone !== true) return why("verify: not standalone");
  if (check.obscure === true) return why("verify: obscure");
  const theirs = str(check.answer);
  if (!theirs || !agrees(theirs, q)) return why("verify: different answer", `${q.answer} vs ${theirs}`);
  return { ok: true, q };
}

export async function questionsFrom(a: Article): Promise<Result[]> {
  const raw = await completeJSON(GEN_SYSTEM, genPrompt(a, gen.questionsPerArticle), "generate");
  const list = Array.isArray(raw.questions) ? (raw.questions as Record<string, unknown>[]) : [raw];

  const results: Result[] = [];
  const valid: Candidate[] = [];
  const answers = new Set<string>();
  for (const item of list.slice(0, gen.questionsPerArticle)) {
    const v = validate(item ?? {}, a);
    if (v.ok && answers.has(normalize(v.q.answer))) {
      results.push({ ok: false, reason: "same answer twice", detail: v.q.question });
    } else if (v.ok) {
      answers.add(normalize(v.q.answer));
      valid.push(v.q);
    } else {
      results.push(v);
    }
  }
  if (!valid.length) return results;

  // one blind verification call for all of this article's questions; if the model
  // skips some, check those again in a second call
  let pending = valid;
  for (let round = 0; round < 2 && pending.length; round++) {
    const check = await completeJSON(VERIFY_SYSTEM, verifyPrompt(a, pending.map((q) => q.question)), "verify");
    const checks = Array.isArray(check.results) ? (check.results as Record<string, unknown>[]) : [check];
    const missing: Candidate[] = [];
    pending.forEach((q, i) => {
      const c = checks.find((x) => Number(x?.n) === i + 1) ?? checks[i];
      if (c || round === 1) results.push(judge(c, q));
      else missing.push(q);
    });
    pending = missing;
  }
  return results;
}
