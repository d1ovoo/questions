// Answer normalization and matching. Used by the server to grade answers and
// by the generator to verify that the checker LLM's answer matches ours.

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE: Record<string, number> = {
  hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000,
};

// "two thousand and twenty four" -> 2024. Returns null if not purely a number in words.
function wordsToNumber(words: string[]): number | null {
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w === "and") continue;
    if (w in SMALL) {
      current += SMALL[w];
      seen = true;
    } else if (w === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (w in SCALE) {
      total += (current || 1) * SCALE[w];
      current = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + current : null;
}

export function normalize(input: string): string {
  let s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,000 -> 1000
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\s.]/gu, "") // punctuation (keep decimal points for now)
    .replace(/\.(?!\d)|(?<!\d)\./g, "") // drop dots that are not decimal points
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(the|a|an)\s+/, "");

  // numbers written as words become digits: "twenty one" -> "21"
  const n = wordsToNumber(s.split(" "));
  if (n !== null) s = String(n);
  return s;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

const isNumeric = (s: string) => /^\d+(\.\d+)?$/.test(s);

function matches(g: string, c: string, fuzzyThreshold: number): boolean {
  if (g === c) return true;
  // numbers and very short answers must match exactly
  if (isNumeric(c) || isNumeric(g) || c.length < 4) return false;
  return similarity(g, c) >= fuzzyThreshold;
}

// "Dmitri Mendeleev" -> ["mendeleev"]; "Leonardo da Vinci" -> ["da vinci", "vinci"]
function surnames(name: string): string[] {
  const parts = name.split(" ");
  return parts.slice(1).map((_, i) => parts.slice(i + 1).join(" "));
}

// "Selina Kyle / Catwoman" and "Mumbai (Bombay)" hold several acceptable answers
export function alternatives(answer: string): string[] {
  const out = [answer];
  for (const part of answer.split(/\s+\/\s+/)) {
    out.push(part);
    const paren = part.match(/^(.+?)\s*\((.+)\)\s*$/);
    if (paren) out.push(paren[1], paren[2]);
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

export function isCorrect(
  given: string,
  answer: string,
  accepted: string[] = [],
  fuzzyThreshold = 0.85,
  answerType: string | null = null,
): boolean {
  const g = normalize(given);
  if (!g) return false;
  for (const candidate of [answer, ...accepted].flatMap(alternatives)) {
    const c = normalize(candidate);
    if (!c) continue;
    if (matches(g, c, fuzzyThreshold)) return true;
    // a person can be named by surname alone
    if (answerType === "person" && surnames(c).some((s) => s.length >= 4 && matches(g, s, fuzzyThreshold))) return true;
  }
  return false;
}
