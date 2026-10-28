-- Answer type: drives the input hint ("year", "name or surname", ...) and lets
-- person answers be matched by surname. Paste into the Supabase SQL editor once.

alter table public.questions
  add column if not exists answer_type text
  check (answer_type in ('person', 'year', 'number', 'place', 'title', 'other'));

-- Best guess for questions generated before answer_type existed.
create or replace function public.guess_answer_type(p_question text, p_answer text)
returns text
language sql immutable set search_path = public
as $$
  select case
    when p_answer ~ '^\d{1,4}( ?(BC|AD|BCE|CE))?$' and p_question ~* '\m(year|when|century)\M' then 'year'
    when p_answer ~ '^[\d.,]+( |$)' then 'number'
    when p_question ~* '^(who|whom)\M' then 'person'
    when p_question ~* '^(where\M|in (which|what) (city|country|state|region|continent)\M)' then 'place'
    else null
  end;
$$;

create or replace function public.next_question(
  p_user          uuid,
  p_window        double precision,
  p_limit_ms      integer,
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
        'answer_type', coalesce(pending.answer_type, guess_answer_type(pending.question, pending.answer)),
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
    'answer_type', coalesce(picked.answer_type, guess_answer_type(picked.question, picked.answer)),
    'elapsed_ms', 0,
    'expired', timed_out
  );
end;
$$;

-- return type changes, so it has to be dropped and recreated
drop function if exists public.pending_question(uuid);
create function public.pending_question(p_user uuid)
returns table (id bigint, answer text, accepted_answers text[], answer_type text)
language sql security definer set search_path = public stable
as $$
  select q.id, q.answer, q.accepted_answers,
         coalesce(q.answer_type, guess_answer_type(q.question, q.answer))
  from questions q
  where q.served_to = p_user
    and not exists (select 1 from answers a where a.question_id = q.id)
  order by q.served_at desc
  limit 1;
$$;

revoke execute on function public.pending_question(uuid) from public, anon, authenticated;
grant execute on function public.pending_question(uuid) to service_role;
revoke execute on function public.guess_answer_type(text, text) from public, anon, authenticated;
grant execute on function public.guess_answer_type(text, text) to service_role;
