-- ============================================================
-- MASON OS — Migration 048: inspection comments replace the ITP machinery
--
-- 043–047 built a structured Inspection & Test Plan: templates, points, hold
-- points, 627 checklist questions, derived results. The founder has looked at
-- it against how the firm actually works and asked for something else, which
-- is the right call and worth stating plainly:
--
--   a site walk produces OBSERVATIONS, not thirty-question forms.
--
-- Somebody — the PM, the founder, or the client walking their own house —
-- sees something wrong, writes it down, photographs it, says how urgent it is,
-- and it becomes work for a named person. That is the whole loop. Everything
-- else was ceremony.
--
-- ---------- WHAT IS BEING REMOVED, AND WHAT THAT COSTS ----------
-- Dropped outright: itp_templates, itp_template_items, itp_items, itp_checks,
-- inspections, inspection_checks, their enums and their nine functions, plus
-- all 8 seeded templates / 72 points / 627 questions.
--
-- Two real losses, named so nobody is surprised later:
--   * The HOLD-POINT BLOCK goes. `fn_set_activity_progress` is re-emitted
--     without it — there are no hold points left to check, so leaving the
--     lookup in place would be a join against a table that no longer exists.
--     Nothing now stops progress being recorded past an uninspected stage.
--   * The 500 transcribed questions from the firm's own sheets go with the
--     tables. They are still in migration 046 in the repo, so they can be
--     brought back by re-running it if the structured plan is ever wanted.
--
-- NCRs STAY. A comment is an observation that becomes a task; an NCR is the
-- formal non-conformance with its number, corrective action and close-out.
-- The comment has no status of its own — closing the task IS the closure, and
-- two competing status fields on one observation is how a list stops being
-- believed.
--
-- ---------- ONE ACT, ONE TRANSACTION ----------
-- `fn_raise_inspection_comment` writes the comment AND its task together. The
-- point of the feature is that the observation reaches somebody; a comment
-- that existed without its task would be a note nobody was told about, which
-- is exactly the failure the founder is trying to fix.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. PROGRESS WITHOUT THE HOLD-POINT BLOCK
-- ############################################################
-- 042's version, restored. The 043 guard queried `itp_items`, which this
-- migration drops — so it has to go first, before the table under it does.
create or replace function public.fn_set_activity_progress(
  p_id           uuid,
  p_pct          numeric,
  p_actual_start date default null,
  p_actual_end   date default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then
    raise exception 'Progress must be between 0 and 100.';
  end if;

  select project_id into v_project
  from public.schedule_activities where id = p_id;
  if v_project is null then
    raise exception 'That activity no longer exists.';
  end if;

  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot update progress.' using errcode = '42501';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  update public.schedule_activities
     set pct_complete = p_pct,
         actual_start = coalesce(p_actual_start, actual_start,
                                 case when p_pct > 0 then (now() at time zone 'Asia/Kolkata')::date end),
         actual_end   = case
                          when p_actual_end is not null then p_actual_end
                          when p_pct >= 100 then coalesce(actual_end, (now() at time zone 'Asia/Kolkata')::date)
                          else null
                        end,
         updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_activity_progress(uuid, numeric, date, date)
  from public, anon;
grant execute on function public.fn_set_activity_progress(uuid, numeric, date, date)
  to authenticated;


-- ############################################################
-- ###  2. UNPICK THE NCR's LINKS TO THE ITP
-- ############################################################
-- Dropping a referenced table with CASCADE removes the constraint but leaves
-- the column holding ids that point at nothing. Drop the columns.
alter table public.ncrs drop column if exists itp_item_id;
alter table public.ncrs drop column if exists inspection_id;


-- ############################################################
-- ###  3. DROP THE ITP MACHINERY
-- ############################################################
drop function if exists public.fn_apply_itp_template(uuid, uuid);
drop function if exists public.fn_save_itp_template(uuid, text, text);
drop function if exists public.fn_request_inspection(uuid);
drop function if exists public.fn_delete_itp_item(uuid);
drop function if exists public.fn_blocking_holds(uuid);
drop function if exists public.fn_inspection_checks(uuid);
drop function if exists public.fn_seed_itp_checks(text, text, text[]);
-- every arity this module ever had
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[]);
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[], jsonb);
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[], jsonb, text);

drop table if exists public.inspection_checks   cascade;
drop table if exists public.inspections         cascade;
drop table if exists public.itp_checks          cascade;
drop table if exists public.itp_items           cascade;
drop table if exists public.itp_template_checks cascade;
drop table if exists public.itp_template_items  cascade;
drop table if exists public.itp_templates       cascade;

drop type if exists check_result;
drop type if exists inspection_result;
drop type if exists itp_status;
drop type if exists itp_type;


-- ############################################################
-- ###  4. PRIORITY AND ASSIGNMENT ON A TASK
-- ############################################################
-- Four levels, not five. A scale people can hold in their head is a scale they
-- use; "medium-high" is where a priority field starts meaning nothing.
do $$ begin
  create type task_priority as enum ('low', 'normal', 'high', 'urgent');
exception when duplicate_object then null; end $$;

alter table public.tasks
  add column if not exists priority task_priority not null default 'normal';

-- Optional. A task with nobody named is still a task on the project's list —
-- forcing an assignee would mean inventing one to get past the form.
alter table public.tasks
  add column if not exists assigned_to uuid references public.profiles(id);

create index if not exists tasks_priority_idx
  on public.tasks (project_id, planned_date, priority);


-- ############################################################
-- ###  5. INSPECTION COMMENTS
-- ############################################################
-- What somebody saw on a walk. Deliberately thin: where, what, how urgent,
-- photographs, and who raised it.
create table if not exists public.inspection_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  observed_on date not null default (now() at time zone 'Asia/Kolkata')::date,

  -- "First floor, master bedroom" — the same field the site checklists call
  -- LOCATION, and the first thing anybody asks about a defect.
  location text not null,
  comment  text not null,

  priority task_priority not null default 'normal',
  photos   text[] not null default '{}',

  -- Free text on purpose. A client walking their own house is not a user of
  -- this app and never will be; their name against their own observation is
  -- what makes the record honest.
  raised_for text,

  -- The task this became. SET NULL, never cascade: deleting the task must not
  -- delete the record of what was seen.
  task_id uuid references public.tasks(id) on delete set null,

  raised_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists insp_comment_idx
  on public.inspection_comments (project_id, observed_on desc);


-- ############################################################
-- ###  6. RLS
-- ############################################################
alter table public.inspection_comments enable row level security;

-- Every project member reads and raises. Site people see the most, and a
-- module only the PM can write to is a module nothing gets written to.
drop policy if exists insp_comment_read on public.inspection_comments;
create policy insp_comment_read on public.inspection_comments
  for select to authenticated using (public.is_member(project_id));

-- Insert goes through the RPC, which also creates the task. No direct-insert
-- policy, so a comment cannot exist without the task that tells somebody.
drop policy if exists insp_comment_update on public.inspection_comments;
create policy insp_comment_update on public.inspection_comments
  for update to authenticated
  using (
    public.my_role() in ('founder', 'pm') and public.is_member(project_id)
  )
  with check (
    public.my_role() in ('founder', 'pm') and public.is_member(project_id)
  );

drop policy if exists insp_comment_delete on public.inspection_comments;
create policy insp_comment_delete on public.inspection_comments
  for delete to authenticated
  using (
    public.my_role() in ('founder', 'pm') and public.is_member(project_id)
  );


-- ############################################################
-- ###  7. AUDIT
-- ############################################################
drop trigger if exists audit_inspection_comments on public.inspection_comments;
create trigger audit_inspection_comments
  after insert or update or delete on public.inspection_comments
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  8. RAISE ONE — COMMENT AND TASK TOGETHER
-- ############################################################
-- The task is the point. An observation that did not reach anybody is the
-- exact failure this feature exists to fix, so the two are written in one
-- transaction and there is no path that makes only the comment.
create or replace function public.fn_raise_inspection_comment(
  p_project     uuid,
  p_location    text,
  p_comment     text,
  p_priority    text default 'normal',
  p_photos      text[] default '{}',
  p_raised_for  text default null,
  p_assigned_to uuid default null,
  p_due_date    date default null,
  p_trade       text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_task uuid; v_title text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot raise an inspection comment.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_location), '') = '' then
    raise exception 'Say where it is. A defect with no location is a defect nobody can find.';
  end if;
  if coalesce(btrim(p_comment), '') = '' then
    raise exception 'Say what is wrong.';
  end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Priority must be low, normal, high or urgent.';
  end if;

  -- The task's title is the observation itself, trimmed to something that fits
  -- a list. The full text stays on the comment.
  v_title := btrim(p_comment);
  if length(v_title) > 90 then
    v_title := left(v_title, 87) || '…';
  end if;

  insert into public.tasks
    (project_id, title, trade, work_area, planned_date, priority, assigned_to, created_by)
  values
    (p_project,
     v_title,
     nullif(btrim(coalesce(p_trade, '')), ''),
     btrim(p_location),
     coalesce(p_due_date, (now() at time zone 'Asia/Kolkata')::date),
     p_priority::task_priority,
     p_assigned_to,
     auth.uid())
  returning id into v_task;

  insert into public.inspection_comments
    (project_id, location, comment, priority, photos, raised_for, task_id, raised_by)
  values
    (p_project, btrim(p_location), btrim(p_comment),
     p_priority::task_priority, coalesce(p_photos, '{}'),
     nullif(btrim(coalesce(p_raised_for, '')), ''),
     v_task, auth.uid())
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.fn_raise_inspection_comment(
  uuid, text, text, text, text[], text, uuid, date, text) from public, anon;
grant execute on function public.fn_raise_inspection_comment(
  uuid, text, text, text, text[], text, uuid, date, text) to authenticated;


-- ############################################################
-- ###  9. THE QA SUMMARY, REBUILT
-- ############################################################
-- No ITP counts left to report. What the founder now wants at a glance is:
-- how many observations are still outstanding, how urgent they are, and how
-- many formal NCRs are open.
--
-- "Outstanding" is read from the TASK, not from the comment — the comment has
-- no status of its own, deliberately. A comment whose task is done, or whose
-- task was deleted, is closed.
drop function if exists public.fn_qa_summary(uuid);

create function public.fn_qa_summary(p_project uuid)
returns table (
  open_comments     int,
  urgent_comments   int,
  high_comments     int,
  total_comments    int,
  open_ncrs         int,
  ncr_minor         int,
  ncr_major         int,
  ncr_critical      int,
  corrected_ncrs    int,
  closed_ncrs       int,
  qa_docs           int
)
language sql
stable
security invoker
set search_path = public
as $$
  with c as (
    select
      count(*) filter (where t.id is not null and t.status <> 'done')::int as open_c,
      count(*) filter (where t.id is not null and t.status <> 'done'
                         and ic.priority = 'urgent')::int                 as urgent_c,
      count(*) filter (where t.id is not null and t.status <> 'done'
                         and ic.priority = 'high')::int                   as high_c,
      count(*)::int                                                       as total_c
    from public.inspection_comments ic
    left join public.tasks t on t.id = ic.task_id
    where ic.project_id = p_project
  ),
  n as (
    select
      count(*) filter (where status in ('open', 'corrected'))::int as open_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'minor')::int as minor_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'major')::int as major_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'critical')::int as crit_n,
      count(*) filter (where status = 'corrected')::int as corr_n,
      count(*) filter (where status = 'closed')::int    as closed_n
    from public.ncrs where project_id = p_project
  ),
  d as (
    select count(*)::int as docs
    from public.documents
    where project_id = p_project and folder = 'qc_certificates'
  )
  select c.open_c, c.urgent_c, c.high_c, c.total_c,
         n.open_n, n.minor_n, n.major_n, n.crit_n, n.corr_n, n.closed_n,
         d.docs
  from c, n, d;
$$;

revoke all on function public.fn_qa_summary(uuid) from public, anon;
grant execute on function public.fn_qa_summary(uuid) to authenticated;


-- ############################################################
-- ### 10. VERIFY
-- ############################################################
-- Expect NO rows: every ITP table is gone.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('itp_templates', 'itp_template_items', 'itp_items',
                     'itp_checks', 'inspections', 'inspection_checks')
order by table_name;

-- Expect NO rows: every ITP function is gone.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_apply_itp_template', 'fn_save_itp_template',
                  'fn_request_inspection', 'fn_record_inspection',
                  'fn_inspection_checks', 'fn_blocking_holds',
                  'fn_delete_itp_item')
order by proname;

-- Expect one row: inspection_comments.
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'inspection_comments';

-- Expect priority and assigned_to on tasks.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'tasks'
  and column_name in ('priority', 'assigned_to')
order by column_name;

-- Expect ONE arity each.
select proname, count(*) as arities from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_qa_summary', 'fn_raise_inspection_comment',
                  'fn_set_activity_progress')
group by proname
order by proname;

-- A row of zeros on a project with nothing raised yet.
select * from public.fn_qa_summary(
  (select id from public.projects order by created_at limit 1));
