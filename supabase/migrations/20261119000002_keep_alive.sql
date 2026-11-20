-- =============================================================================
-- KCS Vote — keep-alive (prevents Supabase free-tier auto-pause)
--
-- Supabase pauses free projects after ~7 days of low DATABASE activity, so an
-- HTTP ping is not enough: keep_alive() does a real read (two counts, no row
-- data) and a one-row upsert. Callers: Cloudflare cron Worker, GitHub Actions,
-- and the desktop app. Uses only the public anon key — never service_role.
-- =============================================================================

create table public.keep_alive_log (
  id        int primary key default 1 check (id = 1),  -- always exactly one row
  last_ping timestamptz not null,
  source    text not null
);
alter table public.keep_alive_log enable row level security;
revoke all on public.keep_alive_log from anon, authenticated;

-- PostgREST maps the JSON body {"source": "..."} to the parameter name.
create or replace function public.keep_alive(source text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_src  text := left(coalesce(nullif(regexp_replace($1, '[^A-Za-z0-9_.:-]', '', 'g'), ''), 'unknown'), 40);
  v_last timestamptz;
  v_n    bigint;
begin
  select k.last_ping into v_last from public.keep_alive_log k where k.id = 1;
  -- Rate limit: pings more often than once a minute are acknowledged but ignored.
  if v_last is not null and v_last > now() - interval '1 minute' then
    return jsonb_build_object('ok', true, 'at', now());
  end if;

  -- real reads (results are discarded, no row data leaves the database)
  select count(*) into v_n from public.topics;
  select count(*) into v_n from public.employees;

  -- tiny write
  insert into public.keep_alive_log (id, last_ping, source) values (1, now(), v_src)
  on conflict (id) do update set last_ping = excluded.last_ping, source = excluded.source;

  return jsonb_build_object('ok', true, 'at', now());
end $$;

-- Admin-only status for the desktop app.
create or replace function public.get_keep_alive_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_build_object('last_ping', k.last_ping, 'source', k.source, 'now', now())
                     from public.keep_alive_log k where k.id = 1),
                  jsonb_build_object('last_ping', null, 'source', null, 'now', now()));
end $$;

revoke all on function public.keep_alive(text)          from public, anon, authenticated;
revoke all on function public.get_keep_alive_status()   from public, anon, authenticated;
grant execute on function public.keep_alive(text)        to anon, authenticated; -- desktop app is signed in
grant execute on function public.get_keep_alive_status() to authenticated;
