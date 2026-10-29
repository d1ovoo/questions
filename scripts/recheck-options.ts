// Re-make wrong options that are partly right or echo the question (see overlaps() in
// lib/distractors.ts), for every playable question, shown or not.
//   npm run recheck-options             fix them
//   npm run recheck-options -- --dry-run  only list them
// A question that can't get clean options is taken out of play (options removed), not deleted.
import { db, selectAll } from "./lib/db";
import { gen } from "./lib/config";
import { checkProvider } from "./lib/llm";
import { checkOptions, llmDistractors, numericDistractors, overlaps, shuffle } from "./lib/distractors";

type Row = { id: number; question: string; answer: string; accepted_answers: string[]; answer_type: string | null; distractors: string[] };

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const s = db();
  const rows = await selectAll<Row>((from, to) =>
    s
      .from("questions")
      .select("id, question, answer, accepted_answers, answer_type, distractors")
      .not("distractors", "is", null)
      .order("id")
      .range(from, to),
  );
  const bad = rows.filter((r) => r.distractors.some((d) => overlaps(d, r)));
  console.log(`${bad.length} of ${rows.length} playable questions have an overlapping option${dryRun ? " (dry run)" : ""}`);
  if (dryRun) {
    for (const r of bad) console.log(`  ${r.question} → ${r.answer}  ·  ✗ ${r.distractors.map((d) => (overlaps(d, r) ? `[${d}]` : d)).join(" · ")}`);
    return;
  }
  await checkProvider();

  let fixed = 0;
  let retired = 0;
  let done = 0;
  const batches: Row[][] = [];
  for (let i = 0; i < bad.length; i += 5) batches.push(bad.slice(i, i + 5));

  async function handle(batch: Row[]) {
    const options = batch.map((r) => numericDistractors(r.answer, r.answer_type));
    const needLlm = batch.filter((_, i) => !options[i]);
    if (needLlm.length) {
      const fresh = await llmDistractors(needLlm).catch(() => needLlm.map(() => null));
      needLlm.forEach((r, j) => (options[batch.indexOf(r)] = fresh[j]));
    }
    // the blind check must still pick the right answer among the new options
    const toCheck = batch.map((r, i) => ({ r, i })).filter(({ i }) => options[i]);
    const ok = toCheck.length
      ? await checkOptions(toCheck.map(({ r, i }) => ({ question: r.question, answer: r.answer, options: shuffle([r.answer, ...options[i]!]) }))).catch(() =>
          toCheck.map(() => false),
        )
      : [];
    toCheck.forEach(({ i }, j) => {
      if (!ok[j]) options[i] = null;
    });

    for (const [i, r] of batch.entries()) {
      const d = options[i];
      const { error } = await s.from("questions").update({ distractors: d }).eq("id", r.id);
      if (error) throw error;
      if (d) {
        fixed++;
        console.log(`  ✓ ${r.question} → ${r.answer}  ·  ✗ ${d.join(" · ")}`);
      } else {
        retired++;
        console.log(`  – out of play: ${r.question} → ${r.answer}`);
      }
    }
    done += batch.length;
    console.log(`[${done}/${bad.length}]`);
  }

  const queue = [...batches];
  await Promise.all(
    Array.from({ length: gen.concurrency }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await handle(b);
    }),
  );
  console.log(`\ndone: ${fixed} got new options, ${retired} taken out of play`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
