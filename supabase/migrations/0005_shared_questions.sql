-- Questions can now be served to many players, but never twice to the same player.
-- Paste into the Supabase SQL editor once. The site needs no redeploy: the functions it
-- calls keep their names and arguments.

-- Who has seen which question, and when (the timer runs per player).
create table if not exists public.served (
  user_id     uuid not null references auth.users (id) on delete cascade,
  question_id bigint not null references public.questions (id) on delete cascade,
  served_at   timestamptz not null default now(),
  primary key (user_id, question_id)
);
create index if not exists served_user_time on public.served (user_id, served_at desc);

alter table public.served enable row level security;
revoke all on public.served from anon, authenticated;
grant all on public.served to service_role;

-- carry over what was served under the old one-player-per-question model
insert into public.served (user_id, question_id, served_at)
select served_to, id, served_at from public.questions
where served_to is not null and served_at is not null
on conflict do nothing;

-- one answer per player per question (was: one answer per question)
alter table public.answers drop constraint if exists answers_question_id_key;
alter table public.answers drop constraint if exists answers_user_question_key;
alter table public.answers add constraint answers_user_question_key unique (user_id, question_id);
create index if not exists answers_question on public.answers (question_id);

-- questions.served_at now means "first shown to anyone"; null = nobody has seen it yet,
-- which is what the cleanup scripts rely on. served_to is no longer used.

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
  prof      profiles%rowtype;
  q         questions%rowtype;
  shown_at  timestamptz;
  elapsed   integer;
  late      boolean;
  ok        boolean;
  k         double precision;
  expected  double precision;
  new_rating double precision;
begin
  select * into prof from profiles where id = p_user for update;
  if not found then
    raise exception 'no profile';
  end if;

  select s.served_at into shown_at from served s where s.user_id = p_user and s.question_id = p_question;
  if not found then
    raise exception 'question not served to this user';
  end if;
  if exists (select 1 from answers where user_id = p_user and question_id = p_question) then
    raise exception 'already answered';
  end if;
  select * into q from questions where id = p_question;

  elapsed := floor(extract(epoch from (now() - shown_at)) * 1000);
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
  pending   record;
  timed_out jsonb;
  picked    questions%rowtype;
begin
  -- serialize concurrent calls from the same player (two tabs, double clicks)
  select * into prof from profiles where id = p_user for update;
  if not found then
    raise exception 'no profile';
  end if;

  select q.id, q.question, q.category, q.answer, q.distractors, s.served_at into pending
  from served s join questions q on q.id = s.question_id
  where s.user_id = p_user
    and q.distractors is not null
    and not exists (select 1 from answers a where a.user_id = p_user and a.question_id = q.id)
  order by s.served_at desc
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

  -- a question this player hasn't seen, near their rating; others may have seen it
  select * into picked
  from questions q
  where q.distractors is not null
    and q.rating between prof.rating - p_window and prof.rating + p_window
    and not exists (select 1 from served s where s.user_id = p_user and s.question_id = q.id)
  order by random()
  limit 1;

  if not found then
    select * into picked
    from questions q
    where q.distractors is not null
      and not exists (select 1 from served s where s.user_id = p_user and s.question_id = q.id)
    order by abs(q.rating - prof.rating), random()
    limit 1;
  end if;

  if not found then
    return jsonb_build_object('status', 'empty', 'expired', timed_out);
  end if;

  insert into served (user_id, question_id) values (p_user, picked.id);
  update questions set served_at = coalesce(served_at, now()) where id = picked.id;

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

create or replace function public.current_question(p_user uuid)
returns table (id bigint, answer text)
language sql security definer set search_path = public stable
as $$
  select q.id, q.answer
  from served s join questions q on q.id = s.question_id
  where s.user_id = p_user
    and q.distractors is not null
    and not exists (select 1 from answers a where a.user_id = p_user and a.question_id = q.id)
  order by s.served_at desc
  limit 1;
$$;

-- the one-player-per-question functions are no longer used
drop function if exists public.next_question(uuid, double precision, integer, double precision, double precision, integer);
drop function if exists public.record_answer(uuid, bigint, text, boolean, integer, double precision, double precision, integer);
drop function if exists public.pending_question(uuid);
