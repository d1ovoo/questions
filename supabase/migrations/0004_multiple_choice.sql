-- Multiple choice: 3 wrong options per question, guess-adjusted Elo.
-- Paste into the Supabase SQL editor once. The old functions are left in place so the
-- currently deployed site keeps working until the new version is live.

alter table public.questions
  add column if not exists distractors text[]
  check (distractors is null or cardinality(distractors) = 3);

-- The 4 options in a fixed shuffled order (stable if the question is resumed).
create or replace function public.question_options(p_id bigint, p_answer text, p_distractors text[])
returns jsonb
language sql immutable set search_path = public
as $$
  select jsonb_agg(o order by md5(o || p_id::text))
  from unnest(array_append(p_distractors, p_answer)) as o;
$$;

-- Same as record_answer, but the expected score accounts for guessing:
-- E = p_guess + (1 - p_guess) / (1 + 10^((question - user) / 400))
create or replace function public.grade_answer(
  p_user          uuid,
  p_question      bigint,
  p_given         text,
  p_correct       boolean,
  p_limit_ms      integer,
  p_k_provisional double precision,
  p_k_established double precision,
  p_provisional_n integer,
  p_guess         double precision
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
  expected := p_guess + (1 - p_guess) / (1 + power(10, (q.rating - prof.rating) / 400));
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

-- Same as next_question, but only serves questions that have options, and returns them.
create or replace function public.serve_question(
  p_user          uuid,
  p_window        double precision,
  p_limit_ms      integer,
  p_k_provisional double precision,
  p_k_established double precision,
  p_provisional_n integer,
  p_guess         double precision
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  prof      profiles%rowtype;
  pending   questions%rowtype;
  timed_out jsonb;
  picked    questions%rowtype;
begin
  select * into prof from profiles where id = p_user for update;
  if not found then
    raise exception 'no profile';
  end if;

  select q.* into pending
  from questions q
  where q.served_to = p_user
    and q.distractors is not null
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
        'options', question_options(pending.id, pending.answer, pending.distractors),
        'elapsed_ms', floor(extract(epoch from (now() - pending.served_at)) * 1000)
      );
    end if;
    timed_out := grade_answer(p_user, pending.id, '', false, p_limit_ms,
                              p_k_provisional, p_k_established, p_provisional_n, p_guess);
    select * into prof from profiles where id = p_user;
  end if;

  select * into picked
  from questions
  where served_at is null
    and distractors is not null
    and rating between prof.rating - p_window and prof.rating + p_window
  order by random()
  limit 1
  for update skip locked;

  if not found then
    select * into picked
    from questions
    where served_at is null
      and distractors is not null
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
    'options', question_options(picked.id, picked.answer, picked.distractors),
    'elapsed_ms', 0,
    'expired', timed_out
  );
end;
$$;

-- The multiple-choice question the user currently has open.
create or replace function public.current_question(p_user uuid)
returns table (id bigint, answer text)
language sql security definer set search_path = public stable
as $$
  select q.id, q.answer
  from questions q
  where q.served_to = p_user
    and q.distractors is not null
    and not exists (select 1 from answers a where a.question_id = q.id)
  order by q.served_at desc
  limit 1;
$$;

-- Pool counts, now also showing how many questions are still missing options.
create or replace function public.pool_counts()
returns jsonb
language sql security definer set search_path = public stable
as $$
  select jsonb_build_object(
    'total', count(*),
    'unserved', count(*) filter (where served_at is null),
    'without_options', count(*) filter (where served_at is null and distractors is null)
  ) from questions;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'question_options(bigint,text,text[])',
    'grade_answer(uuid,bigint,text,boolean,integer,double precision,double precision,integer,double precision)',
    'serve_question(uuid,double precision,integer,double precision,double precision,integer,double precision)',
    'current_question(uuid)',
    'pool_counts()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
