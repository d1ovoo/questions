// Offline question generator.
//   npm run generate -- --count 5000      add 5000 questions (resumes an unfinished run)
//   npm run generate -- --count 20 --dry-run   print questions, write nothing
//   npm run generate -- --count 100 --fresh    discard the unfinished run and start over
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ratingForDifficulty } from "../lib/config";
import { normalize } from "../lib/answer";
import { gen } from "./lib/config";
import { articles } from "./lib/wikipedia";
import { questionFrom, type Candidate } from "./lib/pipeline";
import { embed, cosine } from "./lib/embed";
import { db, toVector } from "./lib/db";
import { checkProvider, modelName } from "./lib/llm";

type State = {
  target: number;
  accepted: number;
  attempts: number;
  rejections: Record<string, number>;
  seen: string[]; // article titles already used, kept across runs
};

function args() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--count");
  const count = i >= 0 ? Number(a[i + 1]) : NaN;
  if (!Number.isInteger(count) || count <= 0) {
    console.error("usage: npm run generate -- --count <n> [--dry-run] [--fresh]");
    process.exit(1);
  }
  return { count, dryRun: a.includes("--dry-run"), fresh: a.includes("--fresh") };
}

function loadState(count: number, fresh: boolean, dryRun: boolean): State {
  const saved: State | null = existsSync(gen.stateFile) ? JSON.parse(readFileSync(gen.stateFile, "utf8")) : null;
  const seen = saved?.seen ?? [];
  if (!dryRun && saved && !fresh && saved.accepted < saved.target) {
    console.log(`resuming unfinished run: ${saved.accepted}/${saved.target}`);
    return saved;
  }
  return { target: count, accepted: 0, attempts: 0, rejections: {}, seen };
}

async function main() {
  const { count, dryRun, fresh } = args();
  await checkProvider();
  const state = loadState(count, fresh, dryRun);
  const save = () => !dryRun && writeFileSync(gen.stateFile, JSON.stringify(state));
  const seen = new Set(state.seen);
  const supabase = dryRun ? null : db();
  const local: { q: Candidate; v: number[] }[] = []; // dry-run dedup

  console.log(
    `provider ${gen.provider} (${modelName("generate")}) · min ${gen.minDailyViews} views/day · ` +
      `similarity < ${gen.similarityThreshold}${dryRun ? " · DRY RUN" : ""}`,
  );
  if (supabase) {
    const { data, error } = await supabase.rpc("pool_counts");
    if (error) throw error;
    console.log(`pool: ${data.total} questions, ${data.unserved} unserved`);
  }

  const reject = (reason: string, detail?: string) => {
    state.rejections[reason] = (state.rejections[reason] ?? 0) + 1;
    if (detail !== undefined) console.log(`  ✗ ${reason}${detail ? `: ${detail}` : ""}`);
  };
  // wiki-level rejections are counted silently
  const stream = articles(seen, (r) => (state.rejections[`wiki: ${r}`] = (state.rejections[`wiki: ${r}`] ?? 0) + 1));

  const started = Date.now();
  let next = stream.next(); // prefetch one article while the LLM works
  while (state.accepted < state.target) {
    const article = (await next).value!;
    next = stream.next();
    seen.add(article.title);
    state.seen.push(article.title);
    state.attempts++;
    console.log(`· ${article.title} (${article.avgViews}/day)`);

    try {
      const r = await questionFrom(article);
      if (!r.ok) {
        reject(r.reason, r.detail ?? "");
        continue;
      }
      const q = r.q;
      const vec = await embed(q.question);

      if (supabase) {
        const { data: sim, error } = await supabase.rpc("most_similar_question", { p_embedding: toVector(vec) });
        if (error) throw error;
        const top = sim?.[0];
        if (top && top.similarity >= gen.similarityThreshold) {
          reject("duplicate", `${q.question} ≈ ${top.question} (${top.similarity.toFixed(2)})`);
          continue;
        }
        const { error: insertError } = await supabase.from("questions").insert({
          ...q,
          rating: ratingForDifficulty(q.difficulty),
          answer_norm: normalize(q.answer),
          embedding: toVector(vec),
        });
        if (insertError?.code === "23505") {
          reject("duplicate answer + article", q.answer);
          continue;
        }
        if (insertError) throw insertError;
      } else {
        const dup = local.find((x) => cosine(x.v, vec) >= gen.similarityThreshold);
        if (dup) {
          reject("duplicate", `${q.question} ≈ ${dup.q.question}`);
          continue;
        }
        local.push({ q, v: vec });
      }

      state.accepted++;
      const rate = (state.accepted / state.attempts) * 100;
      const perQ = (Date.now() - started) / 1000 / state.accepted;
      console.log(
        `  ✓ [${state.accepted}/${state.target}] ${q.category} d${q.difficulty} · ${q.question}  →  ${q.answer}` +
          (q.accepted_answers.length ? `  (also: ${q.accepted_answers.join(", ")})` : "") +
          `\n    ${rate.toFixed(0)}% accepted · ${perQ.toFixed(1)}s/question · ${q.source_url}`,
      );
    } catch (e) {
      reject("error", e instanceof Error ? e.message : String(e));
    } finally {
      save();
    }
  }

  console.log(`\ndone: ${state.accepted} accepted from ${state.attempts} articles`);
  console.log("rejections:", state.rejections);
  // a finished run keeps only the seen list, so the next run starts fresh counts
  save();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
