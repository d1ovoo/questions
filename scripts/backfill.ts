// Add multiple-choice options to questions that don't have them yet.
//   npm run backfill               all unserved questions without options
//   npm run backfill -- --dry-run  print the options, write nothing
// Questions that can't get good options (the checker disagrees, or another option is
// also right) are deleted, since they'd never be served.
import { db } from "./lib/db";
import { gen } from "./lib/config";
import { checkProvider } from "./lib/llm";
import { checkOptions, llmDistractors, numericDistractors, shuffle } from "./lib/distractors";

type Row = { id: number; question: string; answer: string; accepted_answers: string[]; answer_type: string | null };

const guessType = (r: Row) =>
  r.answer_type ?? (/^\d{3,4}$/.test(r.answer.trim()) && /\b(year|when|century)\b/i.test(r.question) ? "year" : null);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await checkProvider();
  const s = db();
  const { data, error } = await s
    .from("questions")
    .select("id, question, answer, accepted_answers, answer_type")
    .is("distractors", null)
    .is("served_at", null)
    .limit(10_000);
  if (error) throw error;
  const rows = data as Row[];
  console.log(`${rows.length} questions need options${dryRun ? " (dry run)" : ""}`);

  let done = 0;
  let filled = 0;
  let removed = 0;
  const batches: Row[][] = [];
  for (let i = 0; i < rows.length; i += 5) batches.push(rows.slice(i, i + 5));

  async function handle(batch: Row[]) {
    const typed = batch.map((r) => ({ ...r, answer_type: guessType(r) }));
    // years and small numbers in code; the rest from the LLM
    const options = typed.map((r) => numericDistractors(r.answer, r.answer_type));
    const needLlm = typed.filter((_, i) => !options[i]);
    if (needLlm.length) {
      const fromLlm = await llmDistractors(needLlm).catch(() => needLlm.map(() => null));
      needLlm.forEach((r, j) => (options[typed.indexOf(r)] = fromLlm[j]));
    }
    // the checker must pick the right option blind; numeric options are safe by construction
    const toCheck = typed.map((r, i) => ({ r, i })).filter(({ r, i }) => options[i] && !numericDistractors(r.answer, r.answer_type));
    const verdicts = toCheck.length
      ? await checkOptions(toCheck.map(({ r, i }) => ({ question: r.question, answer: r.answer, options: shuffle([r.answer, ...options[i]!]) }))).catch(() => toCheck.map(() => false))
      : [];
    toCheck.forEach(({ i }, j) => {
      if (!verdicts[j]) options[i] = null;
    });

    const log: string[] = [];
    for (const [i, r] of typed.entries()) {
      const d = options[i];
      if (d) {
        filled++;
        log.push(`  ✓ ${r.question}  →  ${r.answer}  ·  ✗ ${d.join(" · ")}`);
        if (!dryRun) {
          const { error: e } = await s.from("questions").update({ distractors: d }).eq("id", r.id);
          if (e) throw e;
        }
      } else {
        removed++;
        log.push(`  ✗ removed: ${r.question}  →  ${r.answer}`);
        if (!dryRun) {
          const { error: e } = await s.from("questions").delete().eq("id", r.id).is("served_at", null);
          if (e) throw e;
        }
      }
    }
    done += batch.length;
    console.log(`${log.join("\n")}\n[${done}/${rows.length}]`);
  }

  const queue = [...batches];
  await Promise.all(
    Array.from({ length: gen.concurrency }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await handle(b);
    }),
  );

  console.log(`\ndone: ${filled} got options, ${removed} removed`);
  if (!dryRun) console.log("pool:", (await s.rpc("pool_counts")).data);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
