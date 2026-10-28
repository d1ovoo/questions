-- questions: schema, RLS and server-side functions.
-- Paste this whole file into the Supabase SQL editor and run it once.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  username        text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  rating          double precision not null default 1200,
  peak_rating     double precision not null default 1200,
  answered        integer not null default 0,
  correct         integer not null default 0,
  current_streak  integer not null default 0,
  best_streak     integer not null default 0,
  total_answer_ms bigint  not null default 0,
  created_at      timestamptz not null default now()
);

create table public.questions (
  id               bigint generated always as identity primary key,
  question         text not null,
  answer           text not null,
  accepted_answers text[] not null default '{}',
  category         text not null check (category in
                     ('history','geography','science','sports','arts',
                      'entertainment','technology','nature','people','other')),
  difficulty       smallint not null check (difficulty between 1 and 10),
  rating           double precision not null,
  source_url       text not null,
  source_title     text not null,
  answer_norm      text not null,
  embedding        extensions.vector(384) not null,
  served_to        uuid references auth.users (id) on delete set null,
  served_at        timestamptz,
  created_at       timestamptz not null default now(),
  -- dedupe on normalized answer + source article
  unique (source_title, answer_norm)
);

-- fast pick of unserved questions near a rating
create index questions_unserved_rating on public.questions (rating) where served_at is null;
-- find a user's pending question
create index questions_served_to on public.questions (served_to, served_at desc) where served_to is not null;
-- similarity search for dedup
create index questions_embedding on public.questions
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.answers (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  question_id   bigint not null unique references public.questions (id) on delete cascade,
  given_answer  text not null default '',
  correct       boolean not null,
  time_ms       integer not null,
  timed_out     boolean not null,
  rating_before double precision not null,
  rating_after  double precision not null,
  created_at    timestamptz not null default now()
);

create index answers_user on public.answers (user_id, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Only public profile rows are readable by clients. Everything else goes
-- through the functions below, which only the service role may execute.
-- ---------------------------------------------------------------------------

alter table public.profiles  enable row level security;
alter table public.questions enable row level security;
alter table public.answers   enable row level security;

create policy "profiles are public" on public.profiles for select using (true);

revoke all on public.questions from anon, authenticated;
revoke all on public.answers   from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant all on public.profiles, public.questions, public.answers to service_role;

-- ---------------------------------------------------------------------------
-- Answer recording + Elo (single source of truth for rating changes)
-- ---------------------------------------------------------------------------

create or replace function public.record_answer(
  p_user          uuid,
  p_question      bigint,
  p_given         text,
  p_correct       boolean,
  p_limit_ms      integer,   -- time limit + grace
  p_k_provisional double precision,
  p_k_established double precision,
  p_provisional_n integer
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  prof    profiles%rowtype;
  q       questions%rowtype;
  elapsed integer;
  late    boolean;
  ok      boolean;
  k       double precision;
  expected double precision;
  new_rating double precision;
begin
  select * into prof from profiles where id = p_user for update;
  if not found then
    raise exception 'no profile';
  end if;

  select * into q from questions where id = p_question for update;
  if not found or q.served_to is distinct from p_user then
    raise exception 'question not served to this user';
  end if;
  if exists (select 1 from answers where question_id = p_question) then
    raise exception 'already answered';
  end if;

  elapsed := floor(extract(epoch from (now() - q.served_at)) * 1000);
  late := elapsed > p_limit_ms;
  ok := p_correct and not late;

  k := case when prof.answered < p_provisional_n then p_k_provisional else p_k_established end;
  expected := 1 / (1 + power(10, (q.rating - prof.rating) / 400));
  new_rating := prof.rating + k * ((case when ok then 1 else 0 end) - expected);

  insert into answers (user_id, question_id, given_answer, correct, time_ms, timed_out,
                       rating_before, rating_after)
  values (p_user, p_question, coalesce(left(p_given, 200), ''), ok, elapsed, late,
          prof.rating, new_rating);

  update profiles set
    rating          = new_rating,
    peak_rating     = greatest(peak_rating, new_rating),
    answered        = answered + 1,
    correct         = correct + (case when ok then 1 else 0 end),
    current_streak  = case when ok then current_streak + 1 else 0 end,
    best_streak     = greatest(best_streak, case when ok then current_streak + 1 else 0 end),
    total_answer_ms = total_answer_ms + least(elapsed, p_limit_ms)
  where id = p_user;

  return jsonb_build_object(
    'correct', ok,
    'timed_out', late,
    'answer', q.answer,
    'rating_before', prof.rating,
    'rating_after', new_rating,
    'time_ms', elapsed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Next question: resume pending, record expired pending as timeout, or serve
-- a fresh unserved question near the user's rating. Atomic per user.
-- ---------------------------------------------------------------------------

create or replace function public.next_question(
  p_user          uuid,
  p_window        double precision,
  p_limit_ms      integer,   -- time limit + grace
  p_k_provisional double precision,
  p_k_established double precision,
  p_provisional_n integer
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  prof      profiles%rowtype;
  pending   questions%rowtype;
  timed_out jsonb;
  picked    questions%rowtype;
begin
  -- serialize concurrent calls from the same user (two tabs, double clicks)
  select * into prof from profiles where id = p_user for update;
  if not found then
    raise exception 'no profile';
  end if;

  select q.* into pending
  from questions q
  where q.served_to = p_user
    and not exists (select 1 from answers a where a.question_id = q.id)
  order by q.served_at desc
  limit 1;

  if found then
    if now() - pending.served_at <= make_interval(secs => p_limit_ms / 1000.0) then
      return jsonb_build_object(
        'status', 'question',
        'id', pending.id,
        'question', pending.question,
        'category', pending.category,
        'elapsed_ms', floor(extract(epoch from (now() - pending.served_at)) * 1000)
      );
    end if;
    timed_out := record_answer(p_user, pending.id, '', false, p_limit_ms,
                               p_k_provisional, p_k_established, p_provisional_n);
    select * into prof from profiles where id = p_user;
  end if;

  select * into picked
  from questions
  where served_at is null
    and rating between prof.rating - p_window and prof.rating + p_window
  order by random()
  limit 1
  for update skip locked;

  if not found then
    select * into picked
    from questions
    where served_at is null
    order by abs(rating - prof.rating), random()
    limit 1
    for update skip locked;
  end if;

  if not found then
    return jsonb_build_object('status', 'empty', 'expired', timed_out);
  end if;

  update questions set served_to = p_user, served_at = now() where id = picked.id;

  return jsonb_build_object(
    'status', 'question',
    'id', picked.id,
    'question', picked.question,
    'category', picked.category,
    'elapsed_ms', 0,
    'expired', timed_out
  );
end;
$$;

-- Question the user currently has open (server-side answer checking reads it).
create or replace function public.pending_question(p_user uuid)
returns table (id bigint, answer text, accepted_answers text[])
language sql security definer set search_path = public stable
as $$
  select q.id, q.answer, q.accepted_answers
  from questions q
  where q.served_to = p_user
    and not exists (select 1 from answers a where a.question_id = q.id)
  order by q.served_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Leaderboard and profile stats
-- ---------------------------------------------------------------------------

create or replace function public.leaderboard(p_user uuid, p_min_answers integer)
returns jsonb
language sql security definer set search_path = public stable
as $$
  with ranked as (
    select id, username, rating,
           rank() over (order by rating desc) as rank
    from profiles
    where answered >= p_min_answers
  )
  select jsonb_build_object(
    'top', coalesce((select jsonb_agg(jsonb_build_object(
                       'rank', rank, 'username', username, 'rating', round(rating)::int,
                       'me', id = p_user) order by rank, username)
                     from (select * from ranked order by rank, username limit 100) t), '[]'),
    'me',  (select jsonb_build_object('rank', rank, 'username', username,
                                      'rating', round(rating)::int, 'me', true)
            from ranked where id = p_user)
  );
$$;

create or replace function public.profile_stats(p_user uuid, p_min_answers integer)
returns jsonb
language sql security definer set search_path = public stable
as $$
  with me as (select * from profiles where id = p_user),
  mine as (
    select a.*, q.category, q.difficulty
    from answers a join questions q on q.id = a.question_id
    where a.user_id = p_user
  ),
  ranked as (select count(*) as n from profiles where answered >= p_min_answers),
  cats as (
    select category, count(*) as n, avg(case when correct then 1.0 else 0 end) as acc
    from mine group by category
  ),
  bands as (
    select case when difficulty <= 3 then 'easy' when difficulty <= 7 then 'medium' else 'hard' end as band,
           count(*) as n, avg(case when correct then 1.0 else 0 end) as acc
    from mine group by 1
  ),
  hist as (
    -- at most ~300 points for the sparkline
    select rating_after, row_number() over (order by created_at) as rn, count(*) over () as total
    from mine
  )
  select jsonb_build_object(
    'username',       me.username,
    'rating',         round(me.rating)::int,
    'peak_rating',    round(me.peak_rating)::int,
    'provisional',    me.answered < p_min_answers,
    'rank',           case when me.answered >= p_min_answers then
                        (select count(*) + 1 from profiles p
                         where p.answered >= p_min_answers and p.rating > me.rating) end,
    'ranked_players', (select n from ranked),
    'answered',       me.answered,
    'correct',        me.correct,
    'current_streak', me.current_streak,
    'best_streak',    me.best_streak,
    'total_answer_ms', me.total_answer_ms,
    'avg_answer_ms',  (select round(avg(least(time_ms, 10000)))::int from mine where not timed_out),
    'fastest_correct_ms', (select min(time_ms) from mine where correct),
    'timeouts',       (select count(*) from mine where timed_out),
    'categories',     coalesce((select jsonb_agg(jsonb_build_object('category', category, 'n', n, 'accuracy', acc)
                                                 order by category) from cats), '[]'),
    'bands',          coalesce((select jsonb_agg(jsonb_build_object('band', band, 'n', n, 'accuracy', acc))
                                from bands), '[]'),
    'history',        coalesce((select jsonb_agg(round(rating_after)::int order by rn) from hist
                                where total <= 300 or rn % ceil(total / 300.0)::int = 0 or rn = total), '[]'),
    'member_since',   me.created_at
  )
  from me;
$$;

-- ---------------------------------------------------------------------------
-- Generator helpers (used by the local script with the service role key)
-- ---------------------------------------------------------------------------

create or replace function public.most_similar_question(p_embedding extensions.vector(384))
returns table (id bigint, question text, similarity double precision)
language sql security definer set search_path = public, extensions stable
as $$
  select q.id, q.question, 1 - (q.embedding <=> p_embedding) as similarity
  from questions q
  order by q.embedding <=> p_embedding
  limit 1;
$$;

create or replace function public.random_questions(p_n integer)
returns table (id bigint, question text, answer text, accepted_answers text[],
               category text, difficulty smallint, source_url text)
language sql security definer set search_path = public volatile
as $$
  select id, question, answer, accepted_answers, category, difficulty, source_url
  from questions order by random() limit p_n;
$$;

create or replace function public.pool_counts()
returns jsonb
language sql security definer set search_path = public stable
as $$
  select jsonb_build_object(
    'total', count(*),
    'unserved', count(*) filter (where served_at is null)
  ) from questions;
$$;

-- Accounts worth a manual look: many answers, near-perfect, very fast.
create or replace view public.suspicious_users with (security_invoker = true) as
select p.id, p.username, p.answered, p.correct,
       round(100.0 * p.correct / nullif(p.answered, 0), 1) as accuracy,
       (select round(avg(a.time_ms)) from answers a where a.user_id = p.id and a.correct) as avg_correct_ms
from profiles p
where p.answered >= 50
  and p.correct::numeric / p.answered >= 0.9
  and (select avg(a.time_ms) from answers a where a.user_id = p.id and a.correct) < 2500;

revoke all on public.suspicious_users from anon, authenticated;

-- Functions are callable only with the service role (server code / local script).
do $$
declare f text;
begin
  foreach f in array array[
    'record_answer(uuid,bigint,text,boolean,integer,double precision,double precision,integer)',
    'next_question(uuid,double precision,integer,double precision,double precision,integer)',
    'pending_question(uuid)',
    'leaderboard(uuid,integer)',
    'profile_stats(uuid,integer)',
    'most_similar_question(extensions.vector)',
    'random_questions(integer)',
    'pool_counts()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
