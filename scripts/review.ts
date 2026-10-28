// Print random questions from the database for a quality check.
//   npm run review            50 questions
//   npm run review -- 100     100 questions
import { db } from "./lib/db";

async function main() {
  const n = Math.max(0, Number(process.argv[2] ?? 50) || 0);
  const supabase = db();
  const [{ data: counts }, { data, error }] = await Promise.all([
    supabase.rpc("pool_counts"),
    supabase.rpc("random_questions", { p_n: n }),
  ]);
  if (error) throw error;

  data.forEach((q: { question: string; answer: string; accepted_answers: string[]; category: string; difficulty: number; source_url: string }, i: number) => {
    console.log(`\n${String(i + 1).padStart(3)}. [${q.category} · d${q.difficulty}] ${q.question}`);
    console.log(`     → ${q.answer}${q.accepted_answers.length ? `   (also: ${q.accepted_answers.join(", ")})` : ""}`);
    console.log(`     ${q.source_url}`);
  });
  console.log(`\npool: ${counts?.total} questions, ${counts?.unserved} unserved`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
