// Print random unshown questions (what players will actually get) for a quality check.
//   npm run review            50 questions
//   npm run review -- 100     100 questions
import { db, selectAll } from "./lib/db";

type Q = { question: string; answer: string; distractors: string[] | null; category: string; difficulty: number; source_url: string };

async function main() {
  const n = Math.max(0, Number(process.argv[2] ?? 50) || 0);
  const supabase = db();
  const [{ data: counts }, rows] = await Promise.all([
    supabase.rpc("pool_counts"),
    selectAll<Q>((from, to) =>
      supabase
        .from("questions")
        .select("question, answer, distractors, category, difficulty, source_url")
        .is("served_at", null)
        .not("distractors", "is", null)
        .order("id")
        .range(from, to),
    ),
  ]);

  // random sample without replacement
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  rows.slice(0, n).forEach((q, i) => {
    console.log(`\n${String(i + 1).padStart(3)}. [${q.category} · d${q.difficulty}] ${q.question}`);
    console.log(`     ✓ ${q.answer}${q.distractors ? `   ✗ ${q.distractors.join(" · ")}` : ""}`);
    console.log(`     ${q.source_url}`);
  });
  console.log(`\npool: ${counts?.total} questions, ${counts?.unserved} unshown`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
