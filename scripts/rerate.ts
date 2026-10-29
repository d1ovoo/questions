// Re-rate question difficulty on the anchored scale (see lib/difficulty.ts).
//   npm run rerate               questions nobody has answered yet
//   npm run rerate -- --all      every question (overwrites ratings learned from play)
//   npm run rerate -- --dry-run  print the new difficulties, write nothing
import { existsSync, readFileSync } from "node:fs";
import { ratingForDifficulty } from "../lib/config";
import { db } from "./lib/db";
import { gen } from "./lib/config";
import { checkProvider } from "./lib/llm";
import { blend, rateDifficulty } from "./lib/difficulty";
import { shuffle } from "./lib/distractors";

type Row = { id: number; question: string; answer: string; distractors: string[]; difficulty: number; source_title: string };

async function main() {
  const all = process.argv.includes("--all");
  const dryRun = process.argv.includes("--dry-run");
  await checkProvider();
  const s = db();

  const views = new Map<string, number>(
    existsSync(gen.listFile)
      ? (JSON.parse(readFileSync(gen.listFile, "utf8")) as { title: string; views: number }[]).map((e) => [e.title, e.views])
      : [],
  );

  const { data, error } = await s
    .from("questions")
    .select("id, question, answer, distractors, difficulty, source_title")
    .not("distractors", "is", null)
    .limit(50_000);
  if (error) throw error;
  let rows = data as Row[];
  if (!all) {
    const { data: answered } = await s.from("answers").select("question_id").limit(100_000);
    const done = new Set((answered ?? []).map((a) => a.question_id));
    rows = rows.filter((r) => !done.has(r.id));
  }
  console.log(`re-rating ${rows.length} questions${dryRun ? " (dry run)" : ""}`);

  const before: Record<number, number> = {};
  const after: Record<number, number> = {};
  let done = 0;
  const batches: Row[][] = [];
  for (let i = 0; i < rows.length; i += 8) batches.push(rows.slice(i, i + 8));

  async function handle(batch: Row[]) {
    const rated = await rateDifficulty(batch.map((r) => ({ question: r.question, answer: r.answer, options: shuffle([r.answer, ...r.distractors]) }))).catch(
      () => batch.map(() => null),
    );
    for (const [i, r] of batch.entries()) {
      if (rated[i] === null) continue; // keep the old value
      const d = blend(rated[i], views.get(r.source_title), r.difficulty);
      before[r.difficulty] = (before[r.difficulty] ?? 0) + 1;
      after[d] = (after[d] ?? 0) + 1;
      if (dryRun) console.log(`  ${r.difficulty} → ${d}  ${r.question}  (${r.answer})`);
      else {
        const { error: e } = await s.from("questions").update({ difficulty: d, rating: ratingForDifficulty(d) }).eq("id", r.id);
        if (e) throw e;
      }
    }
    done += batch.length;
    process.stdout.write(`  ${done}/${rows.length}\r`);
  }

  const queue = [...batches];
  await Promise.all(
    Array.from({ length: gen.concurrency }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await handle(b);
    }),
  );
  console.log(`\ndifficulty before:`, before);
  console.log(`difficulty after: `, after);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
