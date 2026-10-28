# questions

Minimal trivia with an Elo rating. Every question is shown exactly once, to one person, ever.

- **Site**: Next.js on Vercel (Hobby). Serves questions already in the database.
- **Database**: Supabase free tier: Postgres, Auth (Google + magic link), pgvector.
- **Generator**: runs on your machine. Wikipedia → local LLM (Ollama) → blind verification → embedding dedup → Supabase.

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste and run each file in [`supabase/migrations`](supabase/migrations) in order (`0001_init.sql`, then `0002_answer_type.sql`, …). When a new migration file appears later, run just that one.
3. **Authentication → Sign In / Providers**
   - Email: enabled (magic link works by default).
   - Google: enabled. In Google Cloud Console create an OAuth client (Web), with the authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. Paste the client ID and secret into Supabase.
4. **Authentication → URL Configuration**
   - Site URL: your production URL (e.g. `https://questions.vercel.app`).
   - Redirect URLs: `http://localhost:3000/auth/callback` and `https://<your-domain>/auth/callback`.

Magic links must be opened in the same browser that requested them (PKCE).

## 2. Environment variables

Copy `.env.example` to `.env.local` and fill in:

| variable | where | used by |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API | site, generator |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable (or legacy anon) key | site (browser-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | secret (or legacy service_role) key | site server code, generator. **Never expose.** |

The generator settings (LLM provider, Wikipedia thresholds, similarity threshold) are in `.env.example`, all optional.

## 3. Generate questions

Install [Ollama](https://ollama.com) and pull a model:

```bash
winget install Ollama.Ollama
```

```bash
ollama pull qwen2.5:7b
```

Then:

```bash
npm install
```

```bash
npm run generate -- --count 10 --dry-run
```

This prints questions without writing anything. Next, write a small batch and review it:

```bash
npm run generate -- --count 50
```

```bash
npm run review
```

`npm run review` prints 50 random questions from the database (`npm run review -- 100` for more). If you're happy, generate the pool:

```bash
npm run generate -- --count 5000
```

How it works:

1. **Source**: Wikipedia's [Vital articles](https://en.wikipedia.org/wiki/Wikipedia:Vital_articles) (~50,000 important topics), sorted by pageviews and processed **most popular first**. The first run downloads the list and pageviews once (about 15 minutes) and caches it in `scripts/.vital-articles.json`; `--refresh-list` re-downloads it. Stubs, lists and disambiguation pages are skipped, and the run stops below `GEN_MIN_DAILY_VIEWS`.
2. **Generation**: one LLM call per article writes `GEN_QUESTIONS_PER_ARTICLE` (default 3) questions about different, notable facts, from the first `GEN_MAX_EXTRACT_CHARS` (default 4,000) characters of the article. Malformed output, answers that leak into the question, long answers, references to "the article", and answers not present in the text are rejected.
3. **Verification**: a second call answers all of the article's questions **blind** from the text (it never sees our answers) and reports for each whether the answer is supported, unique, the question standalone, and whether it's too obscure. A question is kept only if all checks pass and its answer matches ours.
4. **Parallel**: `GEN_CONCURRENCY` (default 3) articles are processed at once. For Ollama to actually run them in parallel, set the Windows environment variable `OLLAMA_NUM_PARALLEL=3` (or higher) and restart Ollama. If your GPU runs out of memory, lower both.
5. The question is embedded locally (all-MiniLM-L6-v2, 384 dims) and compared to every question in the database via pgvector; similarity ≥ `GEN_SIMILARITY_THRESHOLD` is a duplicate. The database also rejects the same normalized answer from the same article.
6. Inserted with `rating` derived from difficulty (1 → 800, 10 → 2000; see `lib/config.ts`).

It's resumable: progress is saved to `scripts/.state.json` after every article (an article that was mid-way when you stopped is redone). Ctrl+C anytime and run the same command again to continue. `--fresh` discards an unfinished run. Articles already used are remembered across runs.

To use a free API tier instead of Ollama, set `LLM_PROVIDER=openai` plus `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (Groq, Gemini and OpenRouter all expose OpenAI-compatible endpoints). All LLM calls go through `completeJSON` in `scripts/lib/llm.ts`.

### Adding more batches later

Run `npm run generate -- --count 2000` again any time. New questions are deduplicated against everything already in the database, served or not. Check the pool with `npm run review -- 0`.

To delete a bad batch before anyone sees it (SQL editor):

```sql
delete from questions where served_at is null and created_at > now() - interval '1 hour';
```

## 4. Run locally

```bash
npm run dev
```

Open http://localhost:3000. Other commands: `npm test` (answer checker), `npm run typecheck`, `npm run lint`.

## 5. Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project** → import the repo. Framework is detected automatically.
3. Add the three environment variables from step 2 (Production and Preview). The generator variables aren't needed there.
4. Deploy, then add `https://<your-domain>/auth/callback` to Supabase's redirect URLs and set the Site URL.

## How the game works

- `next_question` (Postgres) locks the user's profile row, then either resumes their pending question with the remaining time, records an expired pending question as a timeout, or picks an unserved question within ±150 of their rating (falling back to the nearest), with `FOR UPDATE SKIP LOCKED`, and marks it served. Two users can never get the same question.
- Leaving or reloading doesn't help: the clock is `served_at` in the database. On return you get the same question with whatever time is left, or a recorded timeout.
- `/api/answer` grades on the server (lowercase, accents, punctuation and leading articles removed; numbers in digits or words; Levenshtein ≥ 0.85 for answers of 4+ characters; numbers must match exactly). `record_answer` then checks `now() − served_at ≤ 11s` and applies Elo in the same transaction.
- Elo: `E = 1 / (1 + 10^((question − user)/400))`, K = 40 for the first 30 answers, then 20. Players with fewer than 30 answers are provisional and not on the leaderboard. All of these are in `lib/config.ts`.
- RLS is on for every table. Clients can only read `profiles`. Questions, answers and every function are reachable only with the service role, used by server code and the generator.
- `select * from suspicious_users;` in the SQL editor lists accounts with 50+ answers, ≥ 90% accuracy and an average correct answer time under 2.5s.

## Free tier notes

- 5,000 questions with embeddings take roughly 15–20 MB of the 500 MB database limit.
- Supabase pauses free projects after a week without activity. Open the site or dashboard to wake it.
- The answer endpoint's rate limiter is per serverless instance (best effort). The real guarantees (one answer per question, only by the user it was served to, server-side deadline) are enforced in Postgres.
