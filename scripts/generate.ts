// Offline question generator.
//   npm run generate -- --count 5000           add 5000 questions (resumes an unfinished run)
//   npm run generate -- --count 20 --dry-run   print questions, write nothing
//   npm run generate -- --count 100 --fresh    discard the unfinished run and start over
//   add --refresh-list to re-download the Vital articles list and pageviews
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ratingForDifficulty } from "../lib/config";
import { normalize } from "../lib/answer";
import { gen } from "./lib/config";
import { articles, vitalList, type Article } from "./lib/wikipedia";
import { questionsFrom, type Candidate } from "./lib/pipeline";
import { embed, cosine } from "./lib/embed";
import { db, toVector } from "./lib/db";
import { checkProvider, modelName } from "./lib/llm";

type State = {
  target: number;
  accepted: number;
  attempts: number; // articles processed
  candidates?: number; // questions the LLM proposed
  rejections: Record<string, number>;
  seen: string[]; // article titles already used, kept across runs
};

function args() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--count");
  const count = i >= 0 ? Number(a[i + 1]) : NaN;
  if (!Number.isInteger(count) || count <= 0) {
    console.error("usage: npm run generate -- --count <n> [--dry-run] [--fresh] [--refresh-list]");
    process.exit(1);
  }
  return {
    count,
    dryRun: a.includes("--dry-run"),
    fresh: a.includes("--fresh"),
    refreshList: a.includes("--refresh-list"),
  };
}

function loadState(count: number, fresh: boolean, dryRun: boolean): State {
  const saved: State | null = existsSync(gen.stateFile) ? JSON.parse(readFileSync(gen.stateFile, "utf8")) : null;
  const seen = saved?.seen ?? [];
  if (!dryRun && saved && !fresh && saved.accepted < saved.target) {
    console.log(`resuming unfinished run: ${saved.accepted}/${saved.target}`);
    return saved;
  }
  return { target: count, accepted: 0, attempts: 0, candidates: 0, rejections: {}, seen };
}

// run critical sections one at a time (dedup check + insert)
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

async function main() {
  const { count, dryRun, fresh, refreshList } = args();
  await checkProvider();
  const state = loadState(count, fresh, dryRun);
  const save = () => !dryRun && writeFileSync(gen.stateFile, JSON.stringify(state));
  const seen = new Set(state.seen);
  const supabase = dryRun ? null : db();
  const local: { q: Candidate; v: number[] }[] = []; // dry-run dedup

  console.log(
    `provider ${gen.provider} (${modelName("generate")}) · ${gen.concurrency} parallel · ` +
      `${gen.questionsPerArticle} per article · similarity < ${gen.similarityThreshold}${dryRun ? " · DRY RUN" : ""}`,
  );
  if (supabase) {
    const { data, error } = await supabase.rpc("pool_counts");
    if (error) throw error;
    console.log(`pool: ${data.total} questions, ${data.unserved} unserved`);
  }

  const count1 = (reason: string) => (state.rejections[reason] = (state.rejections[reason] ?? 0) + 1);
  const list = await vitalList(refreshList);
  const stream = articles(list, seen, count1);
  const started = Date.now();
  const done = () => state.accepted >= state.target;

  // Returns true if the question was stored.
  async function store(q: Candidate, log: string[]): Promise<boolean> {
    const vec = await embed(q.question);
    return exclusive(async () => {
      if (done()) return false;
      if (supabase) {
        const { data: sim, error } = await supabase.rpc("most_similar_question", { p_embedding: toVector(vec) });
        if (error) throw error;
        const top = sim?.[0];
        if (top && top.similarity >= gen.similarityThreshold) {
          count1("duplicate");
          log.push(`  ✗ duplicate: ${q.question} ≈ ${top.question} (${top.similarity.toFixed(2)})`);
          return false;
        }
        const { error: insertError } = await supabase.from("questions").insert({
          ...q,
          rating: ratingForDifficulty(q.difficulty),
          answer_norm: normalize(q.answer),
          embedding: toVector(vec),
        });
        if (insertError?.code === "23505") {
          count1("duplicate answer + article");
          return false;
        }
        if (insertError) throw insertError;
      } else {
        const dup = local.find((x) => cosine(x.v, vec) >= gen.similarityThreshold);
        if (dup) {
          count1("duplicate");
          log.push(`  ✗ duplicate: ${q.question} ≈ ${dup.q.question}`);
          return false;
        }
        local.push({ q, v: vec });
      }
      state.accepted++;
      return true;
    });
  }

  async function handle(article: Article) {
    const log = [`· ${article.title} (${article.avgViews}/day)`];
    try {
      const results = await questionsFrom(article);
      state.candidates = (state.candidates ?? 0) + results.length;
      for (const r of results) {
        if (!r.ok) {
          count1(r.reason);
          log.push(`  ✗ ${r.reason}${r.detail ? `: ${r.detail}` : ""}`);
        } else if (await store(r.q, log)) {
          const q = r.q;
          log.push(
            `  ✓ [${state.accepted}/${state.target}] ${q.category} d${q.difficulty} · ${q.question}  →  ${q.answer}` +
              (q.accepted_answers.length ? `  (also: ${q.accepted_answers.join(", ")})` : ""),
          );
        }
      }
      // mark used only once finished, so an interrupted article is retried on resume
      seen.add(article.title);
      state.seen.push(article.title);
      state.attempts++;
    } catch (e) {
      count1("error");
      log.push(`  ✗ error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const secs = (Date.now() - started) / 1000;
    const pct = state.candidates ? (state.accepted / state.candidates) * 100 : 0;
    log.push(`    ${pct.toFixed(0)}% of questions accepted · ${state.accepted ? (secs / state.accepted).toFixed(1) : "–"}s/question`);
    console.log(log.join("\n"));
    save();
  }

  // a few workers pull from the same popularity-ordered stream
  const workers = Array.from({ length: gen.concurrency }, async () => {
    while (!done()) {
      const next = await stream.next();
      if (next.done) return;
      await handle(next.value);
    }
  });
  await Promise.all(workers);

  if (!done()) console.log(`\nran out of articles above ${gen.minDailyViews} views/day (lower GEN_MIN_DAILY_VIEWS for more)`);
  console.log(`\ndone: ${state.accepted} accepted from ${state.attempts} articles`);
  console.log("rejections:", state.rejections);
  save();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
