# questions

Minimal trivia with an Elo rating. A player never sees the same question twice; different players can get the same questions.

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
3. **Wrong options**: each question gets 3 wrong options for multiple choice. Years and numbers get nearby values made in code (1939 → 1936, 1941, 1945); everything else gets plausible wrong answers from the LLM, and any that the answer checker would accept as correct are thrown out.
4. **Verification**: a second call sees each question with its 4 options shuffled and picks the right one **blind** from the text (it isn't told which is ours). It also reports whether the answer is supported, unique, the question standalone, too obscure or a personal-biography detail, and whether another option could also be right. A question is kept only if all checks pass and it picked our answer.
5. **Parallel**: `GEN_CONCURRENCY` (default 3) articles are processed at once. For Ollama to actually run them in parallel, set the Windows environment variable `OLLAMA_NUM_PARALLEL=3` (or higher) and restart Ollama. If your GPU runs out of memory, lower both.
6. The question is embedded locally (all-MiniLM-L6-v2, 384 dims) and compared to every question in the database via pgvector; similarity ≥ `GEN_SIMILARITY_THRESHOLD` is a duplicate. The database also rejects the same normalized answer from the same article.
7. Inserted with `rating` derived from difficulty (1 → 800, 10 → 2000; see `lib/config.ts`).

It's resumable: progress is saved to `scripts/.state.json` after every article (an article that was mid-way when you stopped is redone). Ctrl+C anytime and run the same command again to continue. `--fresh` discards an unfinished run. Articles already used are remembered across runs.

To use a free API tier instead of Ollama, set `LLM_PROVIDER=openai` plus `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (Groq, Gemini and OpenRouter all expose OpenAI-compatible endpoints). All LLM calls go through `completeJSON` in `scripts/lib/llm.ts`.

### Adding more batches later

Run `npm run generate -- --count 2000` again any time. New questions are deduplicated against everything already in the database, served or not. Check the pool with `npm run review -- 0`.

Questions created before multiple choice existed have no wrong options and are never served. Give them options with:

```bash
npm run backfill
```

It uses the same LLM (years and numbers are done in code) and has a checker pick the right option blind; questions that fail are deleted. `npm run backfill -- --dry-run` prints the options without writing.

Difficulty is rated on one anchored scale (`scripts/lib/difficulty.ts`: 1–3 common knowledge, 4–7 easy for someone into the topic, 8–10 only if you know that area), nudged by the article's popularity. To re-rate existing questions on that scale:

```bash
npm run rerate
```

By default it only touches questions nobody has answered, so it never overwrites ratings learned from play; `--all` re-rates everything and `--dry-run` only prints.

To delete a bad batch before anyone sees it (SQL editor; `served_at is null` means no player has seen it):

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

- `serve_question` (Postgres) locks the user's profile row, then either resumes their pending question with the remaining time, records an expired pending question as a timeout, or picks a question this player hasn't seen (with options) within ±150 of their rating (falling back to the nearest) and records it in `served`. Other players may have had the same question; nobody gets one twice. `questions.served_at` is when anyone first saw it, so `served_at is null` means nobody has.
- Leaving or reloading doesn't help: the clock is the player's `served.served_at` in the database. On return you get the same question with whatever time is left, or a recorded timeout.
- Multiple choice: each question is shown with its answer and 3 wrong options, in a fixed shuffled order (the same if you reload). Press 1–4 or tap; Esc gives up; Enter or Space goes to the next question.
- `/api/answer` checks the chosen option on the server. `grade_answer` then checks `now() − served_at ≤ 11s` and applies Elo in the same transaction.
- Elo: `E = 0.25 + 0.75 / (1 + 10^((question − user)/400))`. The 0.25 is the chance of guessing right, so lucky guesses earn little. K = 40 for the first 30 answers, then 20. Players with fewer than 30 answers are provisional and not on the leaderboard. All of these are in `lib/config.ts`.
- Question ratings start from the difficulty (1 → 800, 10 → 2000) and then learn: each answer moves the question's rating by a small step (`questionK`, default 10), up when the player misses and down when they're right.
- RLS is on for every table. Clients can only read `profiles`. Questions, answers and every function are reachable only with the service role, used by server code and the generator.
- `select * from suspicious_users;` in the SQL editor lists accounts with 50+ answers, ≥ 90% accuracy and an average correct answer time under 2.5s.

## Free tier notes

- 5,000 questions with embeddings take roughly 15–20 MB of the 500 MB database limit.
- Supabase pauses free projects after a week without activity. Open the site or dashboard to wake it.
- The answer endpoint's rate limiter is per serverless instance (best effort). The real guarantees (one answer per question, only by the user it was served to, server-side deadline) are enforced in Postgres.
