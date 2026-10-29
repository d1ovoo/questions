-- Question ratings learn from answers: a question that players miss gets harder, one
-- they get right gets easier. The step is small (K = 10) so a few players can't swing it.
-- Paste into the Supabase SQL editor once. No site redeploy is needed: the new argument
-- has a default, so the current site's calls keep working.

drop function if exists public.grade_answer(uuid, bigint, text, boolean, integer, double precision, double precision, integer, double precision);
drop function if exists public.grade_answer(uuid, bigint, text, boolean, integer, double precision, double precision, integer, double precision, double precision);

create function public.grade_answer(
  p_user          uuid,
  p_question      bigint,
  p_given         text,
  p_correct       boolean,
  p_limit_ms      integer,
  p_k_provisional double precision,
  p_k_established double precision,
  p_provisional_n integer,
  p_guess         double precision,
  p_question_k    double precision default 10
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
  score     double precision;
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
  -- lock the question: several players may answer it at the same time
  select * into q from questions where id = p_question for update;

  elapsed := floor(extract(epoch from (now() - shown_at)) * 1000);
  late := elapsed > p_limit_ms;
  ok := p_correct and not late;
  score := case when ok then 1 else 0 end;

  k := case when prof.answered < p_provisional_n then p_k_provisional else p_k_established end;
  expected := p_guess + (1 - p_guess) / (1 + power(10, (q.rating - prof.rating) / 400));
  new_rating := prof.rating + k * (score - expected);

  -- the question "wins" when the player misses; kept within a sane range
  update questions
  set rating = least(2600, greatest(400, rating + p_question_k * (expected - score)))
  where id = p_question;

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

revoke execute on function public.grade_answer(uuid, bigint, text, boolean, integer, double precision, double precision, integer, double precision, double precision) from public, anon, authenticated;
grant execute on function public.grade_answer(uuid, bigint, text, boolean, integer, double precision, double precision, integer, double precision, double precision) to service_role;
