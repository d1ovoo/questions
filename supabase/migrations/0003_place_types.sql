-- More specific place types (city, country, region) so the hint says what's expected.
-- Paste into the Supabase SQL editor once.

alter table public.questions drop constraint if exists questions_answer_type_check;
alter table public.questions add constraint questions_answer_type_check
  check (answer_type in ('person', 'year', 'number', 'city', 'country', 'region', 'place', 'title', 'other'));

create or replace function public.guess_answer_type(p_question text, p_answer text)
returns text
language sql immutable set search_path = public
as $$
  select case
    when p_answer ~ '^\d{1,4}( ?(BC|AD|BCE|CE))?$' and p_question ~* '\m(year|when|century)\M' then 'year'
    when p_answer ~ '^[\d.,]+( |$)' then 'number'
    when p_question ~* '^(who|whom)\M' then 'person'
    when p_question ~* '\m(city|town|capital)\M' then 'city'
    when p_question ~* '\mcountry\M' then 'country'
    when p_question ~* '\m(state|province|region|county)\M' then 'region'
    -- "Where was X born?" -> "Portland, Maine" is a city; a single name is unclear
    when p_question ~* '^where\M' and p_answer ~ ',' then 'city'
    when p_question ~* '^where\M' then 'place'
    else null
  end;
$$;
