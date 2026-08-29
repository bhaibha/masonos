-- ============================================================
-- 064 — IN-APP AI ASSISTANT
--
-- A chat panel that can answer questions about the firm's own data, answer
-- construction questions, explain the app, and PROPOSE a small set of safe
-- records for a person to confirm.
--
-- ------------------------------------------------------------
-- THE SECURITY MODEL, IN ONE PARAGRAPH
-- ------------------------------------------------------------
-- Every read and every write the assistant performs runs on the CALLER'S OWN
-- JWT. The Edge Function builds its Supabase client from the caller's
-- Authorization header, exactly as `photo-analyse` (061) does. There is no
-- service-role key anywhere in this feature. The model never writes SQL: it
-- selects from a fixed list of named tools, and the function maps each name to
-- one hard-coded query. A tool name the function does not recognise is refused
-- before anything runs.
--
-- That means the assistant is, by construction, incapable of seeing more than
-- the person asking it. A supervisor asking about margin gets nothing back,
-- because `expenses` RLS returns nothing to them.
--
-- ------------------------------------------------------------
-- WHY THE TOOLS ALSO CARRY A ROLE CHECK, ON TOP OF RLS
-- ------------------------------------------------------------
-- This is the subtle part and it is the reason this file exists rather than the
-- Edge Function simply querying views.
--
-- `v_project_spend` is `security_invoker` and reads `expenses`, whose RLS
-- excludes supervisors. A supervisor selecting from it does not get an error
-- and does not get zero rows — they get ONE ROW OF ZEROS, because
-- `sum(...)` over no visible rows is null and the view coalesces it to 0.
--
-- A human reading the dashboard sees "restricted for your role" because the
-- screen checks first. A model reading the same view sees `total_spent: 0` and
-- will say "nothing has been spent on Villa 12", which is a confident lie —
-- far worse than a refusal.
--
-- So each tool declares which roles may call it, and a refused tool returns the
-- string "restricted for your role" for the model to relay. RLS remains the
-- boundary — it is what stops a crafted request — and the role check stops the
-- assistant reporting a misleading zero. Same reasoning as `fn_mis_company`
-- returning zero rows rather than a row of zeros (056).
--
-- ------------------------------------------------------------
-- WHAT IT CAN WRITE, AND WHY THAT LIST IS STRUCTURAL
-- ------------------------------------------------------------
-- Five kinds: task, snag, site log note, RFI, document draft. That is the
-- entire universe of `fn_assistant_execute` — there is no branch that reaches
-- `expenses`, `budgets`, `purchase_orders`, `invoices`, `variation_orders`,
-- `ra_bills`, `company_expenses` or `profiles`. The financial tables are not
-- forbidden by instruction, they are UNREACHABLE: no code path exists.
--
-- That is the 061 lesson applied again — give it no field for the thing it must
-- not do. A prompt saying "never touch money" is one jailbreak away from
-- failing; a function with no money branch is not.
--
-- Nothing is ever deleted or voided, and nothing existing is modified. Every
-- write is an INSERT of a new record, proposed first and confirmed by a person.
--
-- ------------------------------------------------------------
-- CONFIRM BEFORE EXECUTE
-- ------------------------------------------------------------
-- `fn_assistant_propose` records what the assistant WANTS to do and returns an
-- id. Nothing is written to a real table. The client renders the exact values;
-- only `fn_assistant_execute` writes, and only for a proposal in 'proposed'
-- state belonging to the caller.
--
-- Proposals are kept whether or not they were confirmed. "The assistant
-- suggested raising this snag and somebody declined" is a more useful record
-- than silence, and it is the only way to judge whether the feature earns its
-- API calls (the 061 dismissals rule).
--
-- Run AFTER 063.
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################
do $$ begin
  if not exists (select 1 from pg_type where typname = 'assistant_action_kind') then
    -- The complete list. Adding to it is a migration, which is the point.
    create type assistant_action_kind as enum
      ('task', 'snag', 'site_log_note', 'rfi', 'document_draft');
  end if;

  if not exists (select 1 from pg_type where typname = 'assistant_action_state') then
    create type assistant_action_state as enum
      ('proposed', 'confirmed', 'cancelled', 'failed');
  end if;

  if not exists (select 1 from pg_type where typname = 'chat_role') then
    create type chat_role as enum ('user', 'assistant');
  end if;
end $$;


-- ############################################################
-- ###  2. CHAT HISTORY
-- ############################################################
create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  -- Set from the first message, so the list is readable without opening each.
  title text,
  -- The project in context when the thread started, if any. Advisory only:
  -- every tool re-derives scope from the caller's own membership.
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_thread_user_idx
  on public.chat_threads (user_id, updated_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  role chat_role not null,
  content text not null,
  -- Which tools ran, with their arguments. Stored so "why did it say that" is
  -- answerable — an assistant whose reasoning cannot be inspected is one nobody
  -- should act on.
  tool_calls jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_msg_thread_idx
  on public.chat_messages (thread_id, created_at);

alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;

-- A conversation is private to the person who had it. Not project-scoped and
-- not visible to a founder: it is a person's own working notes with a tool, and
-- the DATA inside it was already gated by RLS when it was fetched.
drop policy if exists chat_thread_own on public.chat_threads;
create policy chat_thread_own on public.chat_threads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists chat_msg_own on public.chat_messages;
create policy chat_msg_own on public.chat_messages
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ############################################################
-- ###  3. PROPOSED ACTIONS
-- ############################################################
create table if not exists public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  thread_id uuid references public.chat_threads(id) on delete set null,

  kind assistant_action_kind not null,
  project_id uuid references public.projects(id) on delete cascade,

  -- Exactly the values that will be written, so the confirmation card and the
  -- insert cannot disagree. The card renders THIS, not a paraphrase.
  payload jsonb not null,

  state assistant_action_state not null default 'proposed',

  -- What it became. SET NULL rather than cascade: deleting the task must not
  -- delete the record that the assistant proposed it.
  created_task_id  uuid references public.tasks(id)     on delete set null,
  created_snag_id  uuid references public.snags(id)     on delete set null,
  created_rfi_id   uuid references public.rfis(id)      on delete set null,
  created_log_id   uuid references public.site_logs(id) on delete set null,
  created_doc_id   uuid references public.documents(id) on delete set null,

  error_text text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists assistant_action_user_idx
  on public.assistant_actions (user_id, created_at desc);

alter table public.assistant_actions enable row level security;

drop policy if exists assistant_action_own on public.assistant_actions;
create policy assistant_action_own on public.assistant_actions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- The one place a machine suggestion turns into a real record. Worth auditing
-- in its own right, separately from the target table's own audit row.
drop trigger if exists audit_assistant_actions on public.assistant_actions;
create trigger audit_assistant_actions
  after insert or update or delete on public.assistant_actions
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  4. RATE LIMIT
-- ############################################################
-- Gemini's free tier is generous but finite, and a chat panel invites a loop.
-- One row per user per day, incremented before every model call.
create table if not exists public.assistant_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null default (now() at time zone 'Asia/Kolkata')::date,
  call_count int not null default 0,
  primary key (user_id, usage_date)
);

alter table public.assistant_usage enable row level security;

drop policy if exists assistant_usage_own on public.assistant_usage;
create policy assistant_usage_own on public.assistant_usage
  for select to authenticated
  using (user_id = auth.uid());

-- No write policy: only the SECURITY DEFINER function below increments it, so
-- the counter cannot be reset by the thing being counted.
drop function if exists public.fn_assistant_quota(int);
create function public.fn_assistant_quota(p_limit int default 60)
returns table (used int, remaining int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_n     int;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  insert into public.assistant_usage (user_id, usage_date, call_count)
  values (v_me, v_today, 1)
  on conflict (user_id, usage_date)
    do update set call_count = public.assistant_usage.call_count + 1
  returning call_count into v_n;

  if v_n > greatest(coalesce(p_limit, 60), 1) then
    raise exception
      'You have used the assistant % times today, which is the daily limit. It resets at midnight.',
      v_n - 1
      using errcode = '53400';
  end if;

  return query select v_n, greatest(coalesce(p_limit, 60), 1) - v_n;
end $$;

revoke all on function public.fn_assistant_quota(int) from public, anon;
grant execute on function public.fn_assistant_quota(int) to authenticated;


-- ############################################################
-- ###  5. PROPOSING
-- ############################################################
-- Writes nothing but a proposal. SECURITY INVOKER, so the RLS on
-- assistant_actions applies and a proposal belongs to the person who asked.
drop function if exists public.fn_assistant_propose(uuid, text, uuid, jsonb);
create function public.fn_assistant_propose(
  p_thread  uuid,
  p_kind    text,
  p_project uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_kind not in ('task', 'snag', 'site_log_note', 'rfi', 'document_draft') then
    raise exception 'The assistant cannot propose "%".', p_kind;
  end if;

  insert into public.assistant_actions (thread_id, kind, project_id, payload)
  values (p_thread, p_kind::assistant_action_kind, p_project, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.fn_assistant_propose(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.fn_assistant_propose(uuid, text, uuid, jsonb) to authenticated;


-- ############################################################
-- ###  6. EXECUTING — the only write path, and it is short on purpose
-- ############################################################
-- SECURITY INVOKER. That single word is the whole safety story: the INSERTs
-- below obey the caller's RLS exactly as if they had typed the form themselves.
-- A supervisor confirming an RFI proposal is refused by `rfi_insert`, not by a
-- role check written here that could drift from it.
--
-- There is no branch for any financial table. Not "a branch that raises" — no
-- branch at all for expenses, budgets, POs, invoices, VOs, RA bills or
-- overheads. The named refusals below exist only so the ERROR MESSAGE is
-- useful; the protection is the absence of code.
drop function if exists public.fn_assistant_execute(uuid);
create function public.fn_assistant_execute(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a       public.assistant_actions;
  v_new   uuid;
  v_log   public.site_logs;
  v_text  text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- RLS already restricts this select to the caller's own rows.
  select * into a from public.assistant_actions where id = p_id;
  if a.id is null then
    raise exception 'That suggestion is no longer available.';
  end if;
  if a.state::text <> 'proposed' then
    raise exception 'That suggestion has already been %.', a.state;
  end if;

  if a.kind::text = 'task' then
    insert into public.tasks (project_id, title, trade, work_area, planned_date)
    values (a.project_id,
            a.payload->>'title',
            nullif(a.payload->>'trade', ''),
            nullif(a.payload->>'work_area', ''),
            coalesce((a.payload->>'planned_date')::date,
                     (now() at time zone 'Asia/Kolkata')::date))
    returning id into v_new;
    update public.assistant_actions
      set state = 'confirmed', created_task_id = v_new, decided_at = now()
      where id = p_id;

  elsif a.kind::text = 'snag' then
    insert into public.snags (project_id, work_area, description, severity)
    values (a.project_id,
            coalesce(nullif(a.payload->>'work_area', ''), 'Not stated'),
            a.payload->>'description',
            coalesce(nullif(a.payload->>'severity', ''), 'medium')::snag_severity)
    returning id into v_new;
    update public.assistant_actions
      set state = 'confirmed', created_snag_id = v_new, decided_at = now()
      where id = p_id;

  elsif a.kind::text = 'rfi' then
    insert into public.rfis (project_id, addressed_to, category, question, required_by)
    values (a.project_id,
            nullif(a.payload->>'addressed_to', ''),
            coalesce(nullif(a.payload->>'category', ''), 'design')::rfi_category,
            a.payload->>'question',
            (a.payload->>'required_by')::date)
    returning id into v_new;
    update public.assistant_actions
      set state = 'confirmed', created_rfi_id = v_new, decided_at = now()
      where id = p_id;

  elsif a.kind::text = 'site_log_note' then
    -- One log per person per project per day (001's unique constraint), so a
    -- note APPENDS to today's rather than failing or overwriting. Overwriting
    -- somebody's morning entry with an afternoon note would lose the morning.
    v_text := a.payload->>'note';
    select * into v_log from public.site_logs
    where project_id = a.project_id
      and log_date = (now() at time zone 'Asia/Kolkata')::date
      and created_by = auth.uid();

    if v_log.id is null then
      insert into public.site_logs (project_id, log_date, work_summary)
      values (a.project_id, (now() at time zone 'Asia/Kolkata')::date, v_text)
      returning id into v_new;
    else
      update public.site_logs
        set work_summary = concat_ws(E'\n', nullif(work_summary, ''), v_text)
        where id = v_log.id
      returning id into v_new;
    end if;

    update public.assistant_actions
      set state = 'confirmed', created_log_id = v_new, decided_at = now()
      where id = p_id;

  elsif a.kind::text = 'document_draft' then
    -- A note in the vault. It holds TEXT, not a file: the assistant has no
    -- storage access and inventing a file_path would produce a document that
    -- cannot be opened.
    insert into public.documents (project_id, folder, title, file_path, file_type, doc_kind)
    values (a.project_id,
            coalesce(nullif(a.payload->>'folder', ''), 'other')::doc_folder,
            a.payload->>'title',
            '', 'text/plain', 'assistant_draft')
    returning id into v_new;
    update public.assistant_actions
      set state = 'confirmed', created_doc_id = v_new, decided_at = now()
      where id = p_id;

  else
    -- Unreachable: the enum has five values and all five are handled above.
    -- Kept so that adding a sixth without a branch fails loudly rather than
    -- silently doing nothing.
    raise exception 'No execution path for "%".', a.kind;
  end if;

  return jsonb_build_object('id', v_new, 'kind', a.kind);
end $$;

revoke all on function public.fn_assistant_execute(uuid) from public, anon;
grant execute on function public.fn_assistant_execute(uuid) to authenticated;


drop function if exists public.fn_assistant_cancel(uuid, text);
create function public.fn_assistant_cancel(p_id uuid, p_reason text default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.assistant_actions
  set state = 'cancelled', decided_at = now(),
      error_text = nullif(btrim(p_reason), '')
  where id = p_id and state::text = 'proposed';
end $$;

revoke all on function public.fn_assistant_cancel(uuid, text) from public, anon;
grant execute on function public.fn_assistant_cancel(uuid, text) to authenticated;


-- ############################################################
-- ###  7. HOW USEFUL IS IT
-- ############################################################
-- Confirmed vs declined. An assistant nobody can evaluate is one that quietly
-- stays switched on forever.
drop function if exists public.fn_assistant_stats();
create function public.fn_assistant_stats()
returns table (
  proposed_count  int,
  confirmed_count int,
  cancelled_count int,
  confirm_rate_pct numeric,
  calls_today     int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::int,
    count(*) filter (where state::text = 'confirmed')::int,
    count(*) filter (where state::text = 'cancelled')::int,
    case when count(*) filter (where state::text <> 'proposed') > 0
      then round(count(*) filter (where state::text = 'confirmed') * 100.0
                 / count(*) filter (where state::text <> 'proposed'), 1) end,
    coalesce((select u.call_count from public.assistant_usage u
              where u.user_id = auth.uid()
                and u.usage_date = (now() at time zone 'Asia/Kolkata')::date), 0)
  from public.assistant_actions;
$$;

revoke all on function public.fn_assistant_stats() from public, anon;
grant execute on function public.fn_assistant_stats() to authenticated;


-- ############################################################
-- ###  8. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_assistant_quota', 'fn_assistant_propose',
                    'fn_assistant_execute', 'fn_assistant_cancel',
                    'fn_assistant_stats')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('chat_threads', 'chat_messages', 'assistant_actions',
                     'assistant_usage')
order by table_name;
