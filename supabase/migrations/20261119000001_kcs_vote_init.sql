-- =============================================================================
-- KCS Vote — initial schema
-- K Casting and Solution Co., Ltd.
--
-- Security model
--   * RLS is enabled on EVERY table and anon/authenticated have no table grants
--     (except admin-only SELECT on topics / topic_counters / topic_options, used
--     by Supabase Realtime and limited by RLS to rows visible to admins).
--   * Voters (anon key, no login) can only call three SECURITY DEFINER RPCs:
--       get_open_topics(), list_voters(topic), submit_vote(...)
--   * Admins are Supabase Auth users listed in public.admins. All admin RPCs
--     check public.is_admin() first.
--
-- Anonymity model (read this before changing anything)
--   * voters_registry says WHO voted. ballots says WHAT was voted (department +
--     option only). ballots has NO emp_code, NO employee id, NO timestamp and a
--     random UUID primary key, so rows cannot be matched by id order or time.
--   * voters_registry.voted_at is truncated to the minute for the same reason.
--   * ANONYMITY TRADEOFF: admin "undo one person's vote" must know which ballot
--     to delete. Therefore, ONLY when topics.allow_undo = true, the registry
--     row keeps ballot_id. No RPC ever returns that link and no role except the
--     database owner (Supabase dashboard / service_role) can read it, but a
--     database owner COULD join the two tables. When allow_undo = false the
--     link is never written (and switching it off erases existing links), which
--     makes ballots fully unlinkable but undo impossible.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key,          -- auth.users.id of the admin account
  note       text,
  created_at timestamptz not null default now()
);

create table public.employees (
  id          uuid primary key default gen_random_uuid(),  -- opaque id used by the voter page
  emp_code    text not null unique,                        -- NEVER returned to voters
  first_name  text not null check (length(btrim(first_name)) > 0),
  last_name   text not null default '',
  department  text not null check (length(btrim(department)) > 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index employees_department_idx on public.employees (department);

create table public.topics (
  id                   uuid primary key default gen_random_uuid(),
  title                text not null check (length(btrim(title)) > 0),
  title_en             text,
  description          text,
  description_en       text,
  status               text not null default 'draft'
                       check (status in ('draft', 'open', 'closed', 'revealed')),
  open_at              timestamptz,       -- optional window start (null = when opened)
  close_at             timestamptz,       -- optional window end   (null = until closed)
  weighting_enabled    boolean not null default true,
  self_vote_weight     numeric(4,3) not null default 0.5 check (self_vote_weight between 0 and 1),
  min_turnout_pct      numeric(5,2) not null default 30  check (min_turnout_pct between 0 and 100),
  exclude_low_turnout  boolean not null default true,
  low_turnout_included text[] not null default '{}',  -- departments the admin re-included
  allow_undo           boolean not null default true, -- see ANONYMITY TRADEOFF above
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  opened_at            timestamptz,
  closed_at            timestamptz,
  revealed_at          timestamptz,
  check (open_at is null or close_at is null or open_at < close_at)
);

create table public.topic_options (
  id         uuid primary key default gen_random_uuid(),
  topic_id   uuid not null references public.topics (id) on delete cascade,
  label      text not null check (length(btrim(label)) > 0),
  label_en   text,
  department text,                 -- set when the option IS a department (self-vote detection)
  sort_order int  not null default 0,
  tiebreak   int  not null default 0, -- admin-decided order for tied scores (lower first)
  unique (topic_id, label)
);
create index topic_options_topic_idx on public.topic_options (topic_id);

create table public.voters_registry (
  topic_id   uuid not null references public.topics (id) on delete cascade,
  emp_code   text not null,
  voted_at   timestamptz not null default date_trunc('minute', now()),
  request_id uuid not null,        -- client idempotency key (safe retry)
  ballot_id  uuid,                 -- ONLY when topics.allow_undo (see tradeoff)
  primary key (topic_id, emp_code) -- the one-vote-per-name guarantee
);

create table public.ballots (
  id               uuid primary key default gen_random_uuid(),
  topic_id         uuid not null references public.topics (id) on delete cascade,
  voter_department text not null,
  option_id        uuid not null references public.topic_options (id) on delete cascade
  -- intentionally NO emp_code / employee id / timestamp
);
create index ballots_topic_idx on public.ballots (topic_id, voter_department);

create table public.topic_counters (
  topic_id   uuid primary key references public.topics (id) on delete cascade,
  votes      int not null default 0,
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  actor    uuid,
  action   text not null,
  topic_id uuid,
  details  jsonb not null default '{}'::jsonb
);

create table public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);

alter table public.admins          enable row level security;
alter table public.employees       enable row level security;
alter table public.topics          enable row level security;
alter table public.topic_options   enable row level security;
alter table public.voters_registry enable row level security;
alter table public.ballots         enable row level security;
alter table public.topic_counters  enable row level security;
alter table public.audit_log       enable row level security;
alter table public.rate_limits     enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

create or replace function public._require_admin()
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN' using errcode = '42501';
  end if;
end $$;

create or replace function public._audit(p_action text, p_topic uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (actor, action, topic_id, details)
  values (auth.uid(), p_action, p_topic, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public._client_ip()
returns text language plpgsql stable set search_path = public, pg_temp as $$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  return coalesce(nullif(h ->> 'cf-connecting-ip', ''),
                  nullif(h ->> 'x-real-ip', ''),
                  nullif(btrim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
                  'unknown');
end $$;

-- Fixed-window counter. Returns false when the bucket is over p_max in this window.
create or replace function public._hit(p_bucket text, p_max int, p_window_secs int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  v_hits  int;
begin
  insert into public.rate_limits (bucket, window_start, hits) values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.02 then
    delete from public.rate_limits where window_start < now() - interval '1 hour';
  end if;
  return v_hits <= p_max;
end $$;

create or replace function public._topic_accepting(t public.topics)
returns boolean language sql stable as $$
  select t.status = 'open'
     and (t.open_at  is null or now() >= t.open_at)
     and (t.close_at is null or now() <  t.close_at);
$$;

-- ---------------------------------------------------------------------------
-- Scoring (internal; called through admin RPCs only)
--
-- weighting_enabled = true:
--   * every voting department distributes a total weight of 1.0
--   * a vote for the voter's OWN department has raw weight self_vote_weight,
--     any other vote raw weight 1; each vote's share = raw / sum(raw of dept)
--     (with no self votes this is exactly 1 / number_of_voters_in_dept)
--   * a department with turnout < min_turnout_pct of its headcount is flagged
--     low_turnout and, if exclude_low_turnout, excluded unless the admin
--     re-included it (low_turnout_included)
--   * score(option) = sum of shares from all non-excluded departments
-- weighting_enabled = false: score = plain vote count (nothing excluded).
-- Ranking: score desc; equal scores share a rank and is_tie = true;
-- `position` breaks ties with the admin-set tiebreak, then option order.
-- ---------------------------------------------------------------------------
create or replace function public.dept_turnout(p_topic uuid)
returns table (department text, headcount int, voted int, turnout_pct numeric,
               low_turnout boolean, excluded boolean)
language sql stable set search_path = public, pg_temp as $$
  with t as (select * from public.topics where id = p_topic),
  heads as (select e.department as d, count(*)::int as hc
              from public.employees e where e.active group by 1),
  votes as (select b.voter_department as d, count(*)::int as n
              from public.ballots b where b.topic_id = p_topic group by 1),
  depts as (select coalesce(h.d, v.d) as d, coalesce(h.hc, 0) as hc, coalesce(v.n, 0) as n
              from heads h full join votes v on v.d = h.d),
  flagged as (select d.*, (d.hc > 0 and d.n * 100.0 < t.min_turnout_pct * d.hc) as low
                from depts d cross join t)
  select f.d, f.hc, f.n,
         case when f.hc > 0 then round(f.n * 100.0 / f.hc, 2) end,
         f.low,
         (t.weighting_enabled and t.exclude_low_turnout and f.low
            and not (f.d = any (t.low_turnout_included)))
    from flagged f cross join t
   order by f.d;
$$;

create or replace function public.score_topic(p_topic uuid)
returns table (option_id uuid, label text, label_en text, department text, sort_order int,
               tiebreak int, raw_votes int, score numeric, rank int, is_tie boolean, "position" int)
language sql stable set search_path = public, pg_temp as $$
  with t as (select * from public.topics where id = p_topic),
  ex as (select dt.department from public.dept_turnout(p_topic) dt where dt.excluded),
  b as (
    select b.voter_department as d, b.option_id as oid,
           (case when o.department is not null and o.department = b.voter_department
                 then t.self_vote_weight else 1 end)::numeric as w
      from public.ballots b
      join public.topic_options o on o.id = b.option_id
      cross join t
     where b.topic_id = p_topic
       and not exists (select 1 from ex where ex.department = b.voter_department)
  ),
  tot as (select d, sum(w) as s from b group by d),
  weighted as (select b.oid, sum(b.w / tot.s) as sc
                 from b join tot on tot.d = b.d where tot.s > 0 group by b.oid),
  raw as (select b.option_id as oid, count(*)::int as c
            from public.ballots b where b.topic_id = p_topic group by 1),
  base as (
    select o.id, o.label, o.label_en, o.department, o.sort_order, o.tiebreak,
           coalesce(r.c, 0) as rv,
           round(case when t.weighting_enabled then coalesce(w.sc, 0) else coalesce(r.c, 0) end, 6) as sc
      from public.topic_options o
      cross join t
      left join weighted w on w.oid = o.id
      left join raw r on r.oid = o.id
     where o.topic_id = p_topic
  )
  select id, label, label_en, department, sort_order, tiebreak, rv, sc,
         (rank() over (order by sc desc))::int,
         (count(*) over (partition by sc)) > 1,
         (row_number() over (order by sc desc, tiebreak, sort_order, label))::int
    from base
   order by 11;
$$;

-- ---------------------------------------------------------------------------
-- Voter RPCs (anon)
-- ---------------------------------------------------------------------------
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
                                  'department', o.department) order by o.sort_order, o.label), '[]'::jsonb)
                           from public.topic_options o where o.topic_id = t.id))
           order by t.opened_at nulls last, t.title)
      from public.topics t
     where t.status = 'open'), '[]'::jsonb);
end $$;

-- Name list: ONLY while the topic is accepting votes. Returns the opaque id,
-- first/last name, department and whether that name has already voted.
create or replace function public.list_voters(p_topic uuid)
returns table (id uuid, first_name text, last_name text, department text, voted boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.topics;
begin
  select * into t from public.topics where topics.id = p_topic;
  if not found or not public._topic_accepting(t) then
    return;
  end if;
  return query
    select e.id, e.first_name, e.last_name, e.department,
           exists (select 1 from public.voters_registry r
                    where r.topic_id = p_topic and r.emp_code = e.emp_code)
      from public.employees e
     where e.active
     order by e.first_name, e.last_name;
end $$;

-- list_voters is STABLE but must be able to call _hit (a write) — keep the
-- rate limit in a VOLATILE wrapper used by the voter page.
create or replace function public.voter_names(p_topic uuid)
returns table (id uuid, first_name text, last_name text, department text, voted boolean)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public._hit('names:' || public._client_ip(), 1500, 60) then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  return query select * from public.list_voters(p_topic);
end $$;

-- Atomic, idempotent vote submission.
-- Returns {ok:true} / {ok:true, duplicate:true} / {ok:false, code:'...'}
create or replace function public.submit_vote(p_topic uuid, p_employee uuid, p_option uuid, p_request uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t        public.topics;
  e        public.employees;
  v_ballot uuid := gen_random_uuid();
  v_prev   uuid;
begin
  if p_topic is null or p_employee is null or p_option is null or p_request is null then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  if not public._hit('submit:' || public._client_ip(), 600, 60)
     or not public._hit('emp:' || p_employee::text, 10, 60) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;

  -- FOR SHARE: a concurrent Close waits for in-flight votes (and vice versa).
  select * into t from public.topics where id = p_topic for share;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_FOUND');
  end if;
  if t.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_CLOSED');
  end if;
  if t.open_at is not null and now() < t.open_at then
    return jsonb_build_object('ok', false, 'code', 'NOT_STARTED');
  end if;
  if t.close_at is not null and now() >= t.close_at then
    return jsonb_build_object('ok', false, 'code', 'TIME_ENDED');
  end if;

  select * into e from public.employees where id = p_employee and active;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_VOTER');
  end if;
  if not exists (select 1 from public.topic_options where id = p_option and topic_id = p_topic) then
    return jsonb_build_object('ok', false, 'code', 'BAD_OPTION');
  end if;

  insert into public.voters_registry (topic_id, emp_code, request_id, ballot_id)
  values (p_topic, e.emp_code, p_request, case when t.allow_undo then v_ballot end)
  on conflict (topic_id, emp_code) do nothing;

  if not found then
    select r.request_id into v_prev from public.voters_registry r
     where r.topic_id = p_topic and r.emp_code = e.emp_code;
    if v_prev = p_request then           -- same submit retried (network drop)
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    return jsonb_build_object('ok', false, 'code', 'ALREADY_VOTED');
  end if;

  insert into public.ballots (id, topic_id, voter_department, option_id)
  values (v_ballot, p_topic, e.department, p_option);

  insert into public.topic_counters (topic_id, votes, updated_at) values (p_topic, 1, now())
  on conflict (topic_id) do update set votes = public.topic_counters.votes + 1, updated_at = now();

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Admin RPCs (authenticated + is_admin)
-- ---------------------------------------------------------------------------
create or replace function public.admin_whoami()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('user_id', auth.uid(), 'is_admin', public.is_admin());
$$;

create or replace function public.admin_departments()
returns table (department text, headcount int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return query select e.department, count(*)::int from public.employees e
                where e.active group by 1 order by 1;
end $$;

create or replace function public.admin_list_employees()
returns table (emp_code text, first_name text, last_name text, department text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return query select e.emp_code, e.first_name, e.last_name, e.department
                 from public.employees e where e.active
                order by e.department, e.first_name, e.last_name;
end $$;

-- p_rows: [{emp_code, first_name, last_name, department}], p_mode: 'replace' | 'merge'
create or replace function public.admin_import_employees(p_rows jsonb, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_total int; v_dupes text; v_blank int; v_deleted int := 0; v_before int;
begin
  perform public._require_admin();
  if p_mode not in ('replace', 'merge') then
    raise exception 'BAD_MODE' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'NO_ROWS' using errcode = 'P0001';
  end if;

  create temporary table _imp on commit drop as
    select btrim(r ->> 'emp_code')   as emp_code,
           btrim(r ->> 'first_name') as first_name,
           coalesce(btrim(r ->> 'last_name'), '') as last_name,
           btrim(r ->> 'department') as department
      from jsonb_array_elements(p_rows) r;

  select count(*) into v_blank from _imp
   where coalesce(emp_code, '') = '' or coalesce(first_name, '') = '' or coalesce(department, '') = '';
  if v_blank > 0 then
    raise exception 'BLANK_FIELDS:%', v_blank using errcode = 'P0001';
  end if;
  select string_agg(emp_code, ', ') into v_dupes
    from (select emp_code from _imp group by 1 having count(*) > 1 limit 20) d;
  if v_dupes is not null then
    raise exception 'DUPLICATE_CODES:%', v_dupes using errcode = 'P0001';
  end if;

  select count(*) into v_before from public.employees;
  if p_mode = 'replace' then
    delete from public.employees e where not exists (select 1 from _imp i where i.emp_code = e.emp_code);
    get diagnostics v_deleted = row_count;
  end if;

  insert into public.employees (emp_code, first_name, last_name, department, active, updated_at)
  select emp_code, first_name, last_name, department, true, now() from _imp
  on conflict (emp_code) do update
     set first_name = excluded.first_name, last_name = excluded.last_name,
         department = excluded.department, active = true, updated_at = now();

  select count(*) into v_total from public.employees;
  perform public._audit('import_employees', null,
    jsonb_build_object('mode', p_mode, 'rows', jsonb_array_length(p_rows),
                       'deleted', v_deleted, 'total', v_total));
  return jsonb_build_object('rows', jsonb_array_length(p_rows), 'deleted', v_deleted,
                            'before', v_before, 'total', v_total);
end $$;

create or replace function public.admin_list_topics()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(t) || jsonb_build_object(
             'votes', (select count(*) from public.voters_registry r where r.topic_id = t.id),
             'accepting', public._topic_accepting(t),
             'options', (select coalesce(jsonb_agg(to_jsonb(o) order by o.sort_order), '[]'::jsonb)
                           from public.topic_options o where o.topic_id = t.id))
           order by t.created_at desc)
      from public.topics t), '[]'::jsonb);
end $$;

-- Create (no id) or update a topic and its options.
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

  -- Switching undo OFF permanently erases ballot links (cannot be restored).
  if v_old.allow_undo and not coalesce((p ->> 'allow_undo')::boolean, true) then
    update public.voters_registry set ballot_id = null where topic_id = v_id;
  end if;

  if v_votes > 0 then
    -- options are frozen once votes exist: same ids required, labels may change
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

  -- temporary labels avoid unique(topic_id,label) clashes while reordering/renaming
  update public.topic_options set label = id::text where topic_id = v_id;
  insert into public.topic_options (id, topic_id, label, label_en, department, sort_order)
  select coalesce(nullif(x ->> 'id', '')::uuid, gen_random_uuid()), v_id, btrim(x ->> 'label'),
         nullif(btrim(x ->> 'label_en'), ''), nullif(btrim(x ->> 'department'), ''), i::int
    from jsonb_array_elements(v_opts) with ordinality as a(x, i)
  on conflict (id) do update set label = excluded.label, label_en = excluded.label_en,
     department = excluded.department, sort_order = excluded.sort_order
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
  insert into public.topic_options (topic_id, label, label_en, department, sort_order)
  select v_new, label, label_en, department, sort_order from public.topic_options where topic_id = p_topic;
  perform public._audit('duplicate_topic', v_new, jsonb_build_object('from', p_topic));
  return v_new;
end $$;

create or replace function public.admin_delete_topic(p_topic uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_title text;
begin
  perform public._require_admin();
  select title into v_title from public.topics where id = p_topic;
  if (select status from public.topics where id = p_topic) = 'open' then
    raise exception 'CLOSE_FIRST' using errcode = 'P0001';
  end if;
  delete from public.topics where id = p_topic;
  perform public._audit('delete_topic', p_topic, jsonb_build_object('title', v_title));
end $$;

-- Allowed transitions: draft->open, closed->open (reopen), open->closed,
-- closed->revealed, revealed->closed (hide results again).
create or replace function public.admin_set_status(p_topic uuid, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare t public.topics;
begin
  perform public._require_admin();
  select * into t from public.topics where id = p_topic for update;
  if not found then raise exception 'TOPIC_NOT_FOUND' using errcode = 'P0001'; end if;
  if not ((t.status in ('draft', 'closed') and p_status = 'open')
       or (t.status = 'open'     and p_status = 'closed')
       or (t.status = 'closed'   and p_status = 'revealed')
       or (t.status = 'revealed' and p_status = 'closed')) then
    raise exception 'BAD_TRANSITION:%->%', t.status, p_status using errcode = 'P0001';
  end if;
  if p_status = 'open' and (select count(*) from public.topic_options where topic_id = p_topic) < 2 then
    raise exception 'NEED_2_OPTIONS' using errcode = 'P0001';
  end if;
  update public.topics set status = p_status, updated_at = now(),
         opened_at   = case when p_status = 'open'     then now() else opened_at end,
         closed_at   = case when p_status = 'closed' and t.status = 'open' then now() else closed_at end,
         revealed_at = case when p_status = 'revealed' then now() else revealed_at end
   where id = p_topic;
  insert into public.topic_counters (topic_id) values (p_topic) on conflict do nothing;
  perform public._audit('status_' || p_status, p_topic, jsonb_build_object('from', t.status));
  return jsonb_build_object('status', p_status);
end $$;

create or replace function public.admin_reset_topic(p_topic uuid, p_confirm text)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_votes int;
begin
  perform public._require_admin();
  if p_confirm is distinct from 'RESET' then
    raise exception 'CONFIRM_REQUIRED' using errcode = 'P0001';
  end if;
  perform 1 from public.topics where id = p_topic for update;
  select count(*) into v_votes from public.ballots where topic_id = p_topic;
  delete from public.voters_registry where topic_id = p_topic;
  delete from public.ballots where topic_id = p_topic;
  update public.topic_counters set votes = 0, updated_at = now() where topic_id = p_topic;
  update public.topics set status = 'draft', opened_at = null, closed_at = null, revealed_at = null,
         low_turnout_included = '{}', updated_at = now()
   where id = p_topic;
  update public.topic_options set tiebreak = 0 where topic_id = p_topic;
  perform public._audit('reset_topic', p_topic, jsonb_build_object('deleted_votes', v_votes));
end $$;

-- Live numbers for the admin / display screens. Aggregates only, no identities.
create or replace function public.admin_live_stats(p_topic uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.topics;
begin
  perform public._require_admin();
  select * into t from public.topics where id = p_topic;
  if not found then raise exception 'TOPIC_NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'topic',     to_jsonb(t),
    'accepting', public._topic_accepting(t),
    'voted',     (select count(*) from public.voters_registry where topic_id = p_topic),
    'eligible',  (select count(*) from public.employees where active),
    'scores',    (select coalesce(jsonb_agg(to_jsonb(s) order by s."position"), '[]'::jsonb)
                    from public.score_topic(p_topic) s),
    'turnout',   (select coalesce(jsonb_agg(to_jsonb(d) order by d.department), '[]'::jsonb)
                    from public.dept_turnout(p_topic) d),
    'server_time', now());
end $$;

create or replace function public.admin_set_low_turnout_included(p_topic uuid, p_departments text[])
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.topics set low_turnout_included = coalesce(p_departments, '{}'), updated_at = now()
   where id = p_topic;
  perform public._audit('low_turnout_included', p_topic, jsonb_build_object('departments', p_departments));
end $$;

-- p_order: option ids in the admin-decided order (used only to break ties)
create or replace function public.admin_set_tiebreak(p_topic uuid, p_order uuid[])
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.topic_options o set tiebreak = coalesce(array_position(p_order, o.id), 0)
   where o.topic_id = p_topic;
  perform public._audit('set_tiebreak', p_topic, jsonb_build_object('order', p_order));
end $$;

-- Undo helper list: who has / has not voted (never WHAT they voted).
create or replace function public.admin_voter_status(p_topic uuid, p_search text)
returns table (id uuid, first_name text, last_name text, department text, voted boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return query
    select e.id, e.first_name, e.last_name, e.department,
           exists (select 1 from public.voters_registry r where r.topic_id = p_topic and r.emp_code = e.emp_code)
      from public.employees e
     where e.active
       and (coalesce(p_search, '') = ''
            or (e.first_name || ' ' || e.last_name) ilike '%' || p_search || '%'
            or e.department ilike '%' || p_search || '%')
     order by 5 desc, e.first_name, e.last_name
     limit 60;
end $$;

-- Frees one person's name and removes exactly their ballot. The option is
-- never read or returned; the audit log stores the name, not the choice.
create or replace function public.admin_undo_vote(p_topic uuid, p_employee uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.topics; e public.employees; r public.voters_registry;
begin
  perform public._require_admin();
  select * into t from public.topics where id = p_topic for update;
  if not found then raise exception 'TOPIC_NOT_FOUND' using errcode = 'P0001'; end if;
  if t.status not in ('open', 'closed') then
    raise exception 'UNDO_NOT_ALLOWED_IN_STATUS' using errcode = 'P0001';
  end if;
  select * into e from public.employees where id = p_employee;
  if not found then raise exception 'UNKNOWN_VOTER' using errcode = 'P0001'; end if;
  select * into r from public.voters_registry where topic_id = p_topic and emp_code = e.emp_code for update;
  if not found then raise exception 'NOT_VOTED' using errcode = 'P0001'; end if;
  if r.ballot_id is null then raise exception 'UNDO_DISABLED' using errcode = 'P0001'; end if;

  delete from public.ballots where id = r.ballot_id and topic_id = p_topic;
  delete from public.voters_registry where topic_id = p_topic and emp_code = e.emp_code;
  update public.topic_counters set votes = greatest(votes - 1, 0), updated_at = now() where topic_id = p_topic;
  perform public._audit('undo_vote', p_topic, jsonb_build_object(
    'name', e.first_name || ' ' || e.last_name, 'department', e.department,
    'reason', left(coalesce(p_reason, ''), 500)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_audit(p_limit int default 200)
returns setof public.audit_log
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return query select * from public.audit_log order by id desc limit least(greatest(p_limit, 1), 1000);
end $$;

-- ---------------------------------------------------------------------------
-- RLS policies (admins may SELECT a few tables, used by Realtime)
-- ---------------------------------------------------------------------------
create policy topics_admin_read         on public.topics         for select to authenticated using (public.is_admin());
create policy topic_counters_admin_read on public.topic_counters for select to authenticated using (public.is_admin());
create policy topic_options_admin_read  on public.topic_options  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Grants: deny by default, then allow exactly what is needed
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on public.topics, public.topic_counters, public.topic_options to authenticated;

grant execute on function public.get_open_topics()                     to anon, authenticated;
grant execute on function public.voter_names(uuid)                     to anon, authenticated;
grant execute on function public.submit_vote(uuid, uuid, uuid, uuid)   to anon, authenticated;
grant execute on function public.is_admin()                            to authenticated;

grant execute on function public.admin_whoami()                               to authenticated;
grant execute on function public.admin_departments()                          to authenticated;
grant execute on function public.admin_list_employees()                       to authenticated;
grant execute on function public.admin_import_employees(jsonb, text)          to authenticated;
grant execute on function public.admin_list_topics()                          to authenticated;
grant execute on function public.admin_save_topic(jsonb)                      to authenticated;
grant execute on function public.admin_duplicate_topic(uuid)                  to authenticated;
grant execute on function public.admin_delete_topic(uuid)                     to authenticated;
grant execute on function public.admin_set_status(uuid, text)                 to authenticated;
grant execute on function public.admin_reset_topic(uuid, text)                to authenticated;
grant execute on function public.admin_live_stats(uuid)                       to authenticated;
grant execute on function public.admin_set_low_turnout_included(uuid, text[]) to authenticated;
grant execute on function public.admin_set_tiebreak(uuid, uuid[])             to authenticated;
grant execute on function public.admin_voter_status(uuid, text)               to authenticated;
grant execute on function public.admin_undo_vote(uuid, uuid, text)            to authenticated;
grant execute on function public.admin_audit(int)                             to authenticated;

-- Realtime (Supabase only; skipped where the publication does not exist)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.topics, public.topic_counters;
  end if;
end $$;
