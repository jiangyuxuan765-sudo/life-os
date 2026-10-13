-- Life OS: one private workspace document per authenticated user.
-- Run in the Supabase SQL Editor as the project database owner.
-- Clients may SELECT their own row. All writes go through the CAS RPC below.

begin;

create table if not exists public.life_os_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now(),
  constraint life_os_workspaces_state_shape check (
    coalesce(
      jsonb_typeof(state) = 'object'
      and state -> 'version' = '1'::jsonb
      and jsonb_typeof(state -> 'tasks') = 'array'
      and jsonb_typeof(state -> 'decisions') = 'array'
      and jsonb_typeof(state -> 'metrics') = 'array'
      and jsonb_typeof(state -> 'goals') = 'array'
      and jsonb_typeof(state -> 'notes') = 'array',
      false
    )
  ),
  constraint life_os_workspaces_state_size check (
    octet_length(state::text) <= 2097152
  )
);

alter table public.life_os_workspaces enable row level security;

drop policy if exists life_os_read_own_workspace on public.life_os_workspaces;
create policy life_os_read_own_workspace
  on public.life_os_workspaces
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- A publishable/anon API key alone cannot read any workspace. Authenticated
-- clients cannot bypass CAS by inserting, updating or deleting the table.
revoke all on table public.life_os_workspaces from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on table public.life_os_workspaces to authenticated;

create or replace function public.save_life_os_workspace(
  p_state jsonb,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_current public.life_os_workspaces%rowtype;
  v_applied boolean := false;
  v_key text;
begin
  -- Never accept a user_id from the caller: the verified JWT owns this write.
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'p_expected_revision must be a non-negative integer'
      using errcode = '22023';
  end if;

  if p_state is null or jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'Workspace state must be a JSON object'
      using errcode = '22023';
  end if;
  if p_state -> 'version' is distinct from '1'::jsonb then
    raise exception 'Unsupported workspace version: expected 1'
      using errcode = '22023';
  end if;
  foreach v_key in array array['tasks', 'decisions', 'metrics', 'goals', 'notes']
  loop
    if jsonb_typeof(p_state -> v_key) is distinct from 'array' then
      raise exception 'Workspace field % must be an array', v_key
        using errcode = '22023';
    end if;
  end loop;
  if octet_length(p_state::text) > 2097152 then
    raise exception 'Workspace exceeds the 2 MiB limit'
      using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    -- Concurrent first saves cannot replace one another: only one inserts.
    insert into public.life_os_workspaces (user_id, state)
    values (v_user_id, p_state)
    on conflict (user_id) do nothing
    returning * into v_current;
    v_applied := found;
  else
    -- PostgreSQL rechecks this predicate after concurrent row locks release.
    -- A stale revision never overwrites the newer document.
    update public.life_os_workspaces
    set state = p_state,
        revision = revision + 1,
        updated_at = clock_timestamp()
    where user_id = v_user_id
      and revision = p_expected_revision
    returning * into v_current;
    v_applied := found;
  end if;

  if not v_applied then
    -- A fresh statement obtains the latest committed row after an insert or
    -- update conflict. No row means the client should use revision 0.
    select * into v_current
    from public.life_os_workspaces
    where user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'state', v_current.state,
    'revision', coalesce(v_current.revision, 0),
    'updated_at', v_current.updated_at
  );
end;
$function$;

-- Functions otherwise receive EXECUTE for PUBLIC by default. The definer
-- uses a fixed empty search_path and fully qualified non-system objects.
revoke all on function public.save_life_os_workspace(jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.save_life_os_workspace(jsonb, bigint)
  to authenticated;

comment on table public.life_os_workspaces is
  'Life OS private workspace snapshots, at most 2 MiB UTF-8 JSON per user.';
comment on function public.save_life_os_workspace(jsonb, bigint) is
  'Authenticated compare-and-swap. Expected revision 0 creates; conflicts return the current document without overwriting it.';

commit;
