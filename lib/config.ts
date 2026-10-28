// Game settings. Shared by the server and the generator script.

export const game = {
  // seconds per question shown to the player
  timeLimitMs: 10_000,
  // extra server-side allowance for network latency
  graceMs: 1_000,

  // Elo
  kProvisional: 40,
  kEstablished: 20,
  provisionalAnswers: 30,
  startRating: 1200,

  // serve questions whose rating is within this distance of the player first
  matchWindow: 150,

  // answer checking: Levenshtein similarity needed for a fuzzy match
  fuzzyThreshold: 0.85,
};

// question rating from difficulty 1..10 (linear between the two ends)
export const difficultyRating = { min: 800, max: 2000 };

export function ratingForDifficulty(d: number): number {
  const clamped = Math.min(10, Math.max(1, Math.round(d)));
  return Math.round(
    difficultyRating.min + ((clamped - 1) * (difficultyRating.max - difficultyRating.min)) / 9,
  );
}

export const categories = [
  "history",
  "geography",
  "science",
  "sports",
  "arts",
  "entertainment",
  "technology",
  "nature",
  "people",
  "other",
] as const;

export type Category = (typeof categories)[number];

export const answerTypes = ["person", "year", "number", "place", "title", "other"] as const;
export type AnswerType = (typeof answerTypes)[number];

// placeholder shown in the answer input
export const answerHints: Record<string, string> = {
  person: "name or surname",
  year: "year",
  number: "number",
  place: "place",
  title: "title",
};
