-- KCS Vote — option person: name + position shown on each vote choice, so
-- voters know who a department / position refers to.
-- Run after 20261119000002_keep_alive.sql. Does not touch earlier migrations;
-- the functions below are replaced in place (grants are kept by CREATE OR REPLACE).

alter table public.topic_options
  add column if not exists person_name  text,
  add column if not exists person_title text;

alter table public.topic_options drop constraint if exists topic_options_person_len;
alter table public.topic_options add constraint topic_options_person_len
  check (char_length(person_name) <= 120 and char_length(person_title) <= 120);

-- Voter page: options now carry person_name / person_title.
create or replace function public.get_open_topics()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'title', t.title, 'title_en', t.title_en,
             'description', t.description, 'description_en', t.description_en,
             'open_at', t.open_at, 'close_at', t.close_at,
             'state', case when t.open_at is not null and now() < t.open_at then 'scheduled'
                           when t.close_at is not null and now() >= t.close_at then 'ended'
                           else 'open' end,
             'options', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'id', o.id, 'label', o.label, 'label_en', o.label_en,
                                  'department', o.department,
                                  'person_name', o.person_name, 'person_title', o.person_title)
                                  order by o.sort_order, o.label), '[]'::jsonb)
                           from public.topic_options o where o.topic_id = t.id))
           order by t.opened_at nulls last, t.title)
      from public.topics t
     where t.status = 'open'), '[]'::jsonb);
end $$;

-- Create (no id) or update a topic and its options (now with person fields).
create or replace function public.admin_save_topic(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_votes int := 0;
  v_opts  jsonb := coalesce(p -> 'options', '[]'::jsonb);
  v_old   public.topics;
begin
  perform public._require_admin();
  if jsonb_typeof(v_opts) <> 'array' then
    raise exception 'BAD_OPTIONS' using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.topics (title) values (coalesce(nullif(btrim(p ->> 'title'), ''), 'Untitled'))
    returning id into v_id;
  else
    select * into v_old from public.topics where id = v_id for update;
    if not found then raise exception 'TOPIC_NOT_FOUND' using errcode = 'P0001'; end if;
    select count(*) into v_votes from public.ballots where topic_id = v_id;
  end if;

  update public.topics set
    title               = coalesce(nullif(btrim(p ->> 'title'), ''), title),
    title_en            = nullif(btrim(p ->> 'title_en'), ''),
    description         = nullif(btrim(p ->> 'description'), ''),
    description_en      = nullif(btrim(p ->> 'description_en'), ''),
    open_at             = nullif(p ->> 'open_at', '')::timestamptz,
    close_at            = nullif(p ->> 'close_at', '')::timestamptz,
    weighting_enabled   = coalesce((p ->> 'weighting_enabled')::boolean, weighting_enabled),
    self_vote_weight    = coalesce((p ->> 'self_vote_weight')::numeric, self_vote_weight),
    min_turnout_pct     = coalesce((p ->> 'min_turnout_pct')::numeric, min_turnout_pct),
    exclude_low_turnout = coalesce((p ->> 'exclude_low_turnout')::boolean, exclude_low_turnout),
    allow_undo          = coalesce((p ->> 'allow_undo')::boolean, allow_undo),
    updated_at          = now()
  where id = v_id;

  if v_old.allow_undo and not coalesce((p ->> 'allow_undo')::boolean, true) then
    update public.voters_registry set ballot_id = null where topic_id = v_id;
  end if;

  if v_votes > 0 then
    if (select count(*) from jsonb_array_elements(v_opts) x
         where (x ->> 'id') is null
            or not exists (select 1 from public.topic_options o
                            where o.id = (x ->> 'id')::uuid and o.topic_id = v_id))
       > 0
       or jsonb_array_length(v_opts) <> (select count(*) from public.topic_options where topic_id = v_id) then
      raise exception 'OPTIONS_LOCKED' using errcode = 'P0001';
    end if;
  else
    delete from public.topic_options o where o.topic_id = v_id
       and not exists (select 1 from jsonb_array_elements(v_opts) x where (x ->> 'id')::uuid = o.id);
  end if;

  update public.topic_options set label = id::text where topic_id = v_id;
  insert into public.topic_options (id, topic_id, label, label_en, department, sort_order,
                                    person_name, person_title)
  select coalesce(nullif(x ->> 'id', '')::uuid, gen_random_uuid()), v_id, btrim(x ->> 'label'),
         nullif(btrim(x ->> 'label_en'), ''), nullif(btrim(x ->> 'department'), ''), i::int,
         left(nullif(btrim(x ->> 'person_name'), ''), 120), left(nullif(btrim(x ->> 'person_title'), ''), 120)
    from jsonb_array_elements(v_opts) with ordinality as a(x, i)
  on conflict (id) do update set label = excluded.label, label_en = excluded.label_en,
     department = excluded.department, sort_order = excluded.sort_order,
     person_name = excluded.person_name, person_title = excluded.person_title
   where public.topic_options.topic_id = v_id;

  perform public._audit(case when v_old.id is null then 'create_topic' else 'update_topic' end, v_id,
                        p - 'options' || jsonb_build_object('options', jsonb_array_length(v_opts)));
  return v_id;
end $$;

create or replace function public.admin_duplicate_topic(p_topic uuid)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_new uuid;
begin
  perform public._require_admin();
  insert into public.topics (title, title_en, description, description_en, weighting_enabled,
                             self_vote_weight, min_turnout_pct, exclude_low_turnout, allow_undo)
  select title || ' (copy)', title_en, description, description_en, weighting_enabled,
         self_vote_weight, min_turnout_pct, exclude_low_turnout, allow_undo
    from public.topics where id = p_topic
  returning id into v_new;
  if v_new is null then raise exception 'TOPIC_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into public.topic_options (topic_id, label, label_en, department, sort_order, person_name, person_title)
  select v_new, label, label_en, department, sort_order, person_name, person_title
    from public.topic_options where topic_id = p_topic;
  perform public._audit('duplicate_topic', v_new, jsonb_build_object('from', p_topic));
  return v_new;
end $$;
