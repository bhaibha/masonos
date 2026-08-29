-- ============================================================
-- MASON OS — Migration 066: an aggregate must return ZERO ROWS to a client,
--                           never one row of zeros
--
-- FOUND BY TESTING, not by reading. The exhaustive client sweep swept 147
-- surfaces as a real signed-in client and 18 of them returned a row. Every
-- figure in every one of those rows was 0 or null — nothing leaked — but that
-- is precisely the failure this codebase has already been bitten by twice:
--
--   056: fn_mis_company returns NOTHING for a supervisor rather than a row of
--        zeros, because zeros read as "the company has no projects".
--   064: v_project_spend hands a supervisor ONE ROW OF ZEROS, so the assistant
--        would answer "nothing has been spent on Villa 12" — a confident lie,
--        and worse than a refusal.
--
-- The access control was never wrong. `is_member()` correctly returns false for
-- a client (065), so every one of these aggregates saw zero permitted rows.
-- The bug is that `count(*)` over zero rows is legitimately 0, and
-- `coalesce(sum(x), 0)` is legitimately 0 — so the database answered a question
-- it had just refused to answer.
--
-- Why it matters even though no rupee escaped: the client portal has no UI yet.
-- The first screen somebody builds against `fn_project_evm` will render
-- "Cost performance index: —" or, worse, "₹0 spent" on a job with ₹4 crore
-- against it. And an assistant, a webhook or an export reading these has no
-- dashboard in front of it to notice.
--
-- THE FIX, applied uniformly:
--
--     select * from ( <the existing aggregate, unchanged> ) q
--     where public.is_internal();
--
-- The inner aggregate still produces its single row; the outer filter removes
-- that row for a client and changes nothing for founder / pm / accounts /
-- supervisor. It is deliberately the SAME line in all fifteen places, so a
-- reviewer checks one thing fifteen times rather than fifteen things once.
--
-- Chosen over the alternatives on purpose:
--   * `having count(*) > 0` would also hide a legitimately empty result from an
--     internal user — a project with genuinely no snags would stop returning a
--     zero row and break the screens that read it.
--   * A role check inside each body would have to be written fifteen different
--     ways against fifteen different shapes, and would drift.
--
-- NOT covered here, on purpose: the project-scoped functions already gated on
-- `is_member()` keep that gate. This adds a second, coarser one. Two gates,
-- because the inner one is about WHICH project and the outer one is about
-- WHETHER THIS AUDIENCE EXISTS AT ALL.
--
-- Re-runnable: every function is create-or-replace with an unchanged signature,
-- the one view is drop-then-create (house rule — never `create or replace
-- view`), and the policy is drop-then-create.
-- ============================================================


-- ############################################################
-- ###  1. Company-wide aggregates — no argument, so nothing to guess
-- ############################################################

-- fn_company_pnl (039). Sums v_project_pnl, which is empty for a client.
create or replace function public.fn_company_pnl()
returns table (
  project_count      int,
  active_count       int,
  revenue            numeric,
  total_cost         numeric,
  gross_margin       numeric,
  blended_margin_pct numeric,
  retention_held     numeric,
  committed_open     numeric,
  profitable_count   int,
  bleeding_count     int
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    select
      count(*)::int,
      count(*) filter (where project_status::text = 'active')::int,
      sum(revenue)::numeric(14,2),
      sum(total_cost)::numeric(14,2),
      sum(gross_margin)::numeric(14,2),
      case when sum(revenue) > 0
        then round(sum(gross_margin) * 100.0 / sum(revenue), 1) end,
      sum(retention_held)::numeric(14,2),
      sum(committed_open)::numeric(14,2),
      count(*) filter (where gross_margin > 0 and total_cost > 0)::int,
      count(*) filter (where gross_margin < 0)::int
    from public.v_project_pnl
  ) q
  where public.is_internal();
$$;

comment on function public.fn_company_pnl() is
  'Totals over v_project_pnl, which already scopes rows to the caller. Returns '
  'ZERO ROWS to a client (066) rather than a row of zeros.';


-- fn_company_net (040). Two different time spans in one figure — see 040's
-- header — and a row of zeros here reads as "the company broke exactly even".
create or replace function public.fn_company_net(
  p_from date,
  p_to   date
)
returns table (
  project_margin  numeric,
  overheads       numeric,
  net_position    numeric,
  overhead_count  int,
  sees_overheads  boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    with margin as (
      select coalesce(sum(gross_margin), 0)::numeric(14,2) as m
      from public.v_project_pnl
    ),
    oh as (
      select
        coalesce(sum(amount + gst_amount), 0)::numeric(14,2) as t,
        count(*)::int as n
      from public.company_expenses
      where voided_at is null
        and spend_date between p_from and p_to
        and public.my_role() in ('founder', 'accounts')
    )
    select
      margin.m,
      case when public.my_role() in ('founder', 'accounts') then oh.t end,
      case when public.my_role() in ('founder', 'accounts')
        then (margin.m - oh.t)::numeric(14,2) end,
      oh.n,
      public.my_role() in ('founder', 'accounts')
    from margin, oh
  ) q
  where public.is_internal();
$$;


-- The three expiry registers (028 -> 033 -> 034). One shape, three instances,
-- so one fix three times.
create or replace function public.fn_compliance_alert()
returns table (
  overdue_count   int,
  due_week_count  int,
  next_due_date   date,
  next_title      text
)
language sql
stable
set search_path = public
as $$
  select * from (
    with t as (select (now() at time zone 'Asia/Kolkata')::date as today)
    select
      (select count(*) from public.compliance_items c, t
        where c.status::text <> 'filed' and c.due_date < t.today)::int,
      (select count(*) from public.compliance_items c, t
        where c.status::text <> 'filed'
          and c.due_date >= t.today
          and c.due_date <= t.today + 7)::int,
      (select min(c.due_date) from public.compliance_items c
        where c.status::text <> 'filed'),
      (select c.title from public.compliance_items c
        where c.status::text <> 'filed'
        order by c.due_date, c.title limit 1)
  ) q
  where public.is_internal();
$$;

create or replace function public.fn_bg_alert()
returns table (
  expiring_count int,
  expired_count  int,
  next_expiry    date,
  next_bg_number text
)
language sql
stable
set search_path = public
as $$
  select * from (
    with t as (select (now() at time zone 'Asia/Kolkata')::date as today)
    select
      (select count(*) from public.bank_guarantees g, t
        where g.status::text in ('active', 'expired')
          and g.expiry_date >= t.today
          and g.expiry_date <= t.today + 30)::int,
      (select count(*) from public.bank_guarantees g, t
        where g.status::text in ('active', 'expired')
          and g.expiry_date < t.today)::int,
      (select min(g.expiry_date) from public.bank_guarantees g
        where g.status::text in ('active', 'expired')),
      (select g.bg_number from public.bank_guarantees g
        where g.status::text in ('active', 'expired')
        order by g.expiry_date, g.bg_number limit 1)
  ) q
  where public.is_internal();
$$;

create or replace function public.fn_insurance_alert()
returns table (
  expiring_count int,
  expired_count  int,
  next_expiry    date,
  next_policy    text
)
language sql
stable
set search_path = public
as $$
  select * from (
    with t as (select (now() at time zone 'Asia/Kolkata')::date as today)
    select
      (select count(*) from public.insurance_policies i, t
        where i.status::text in ('active', 'expired')
          and i.expiry_date >= t.today
          and i.expiry_date <= t.today + 30)::int,
      (select count(*) from public.insurance_policies i, t
        where i.status::text in ('active', 'expired')
          and i.expiry_date < t.today)::int,
      (select min(i.expiry_date) from public.insurance_policies i
        where i.status::text in ('active', 'expired')),
      (select i.policy_number from public.insurance_policies i
        where i.status::text in ('active', 'expired')
        order by i.expiry_date, i.policy_number limit 1)
  ) q
  where public.is_internal();
$$;


-- ############################################################
-- ###  2. Project-scoped aggregates — called with the client's OWN project id
-- ############################################################
-- These already carry `is_member()`, which returns false for a client since
-- 065. That is why every figure came back 0. The wrapper removes the row.
--
-- Note the attack this closes: a client's own project id is the ONE id they
-- legitimately know, and it is exactly the argument these functions take.

create or replace function public.fn_project_evm(
  p_project   uuid,
  p_data_date date default null
)
returns table (
  data_date       date,
  activity_count  int,
  bac             numeric,
  pv              numeric,
  ev              numeric,
  ac              numeric,
  sv              numeric,
  cv              numeric,
  spi             numeric,
  cpi             numeric,
  eac             numeric,
  etc             numeric,
  vac             numeric,
  pct_complete    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    with dd as (
      select coalesce(p_data_date, (now() at time zone 'Asia/Kolkata')::date) as d
    ),
    a as (
      select * from public.fn_activity_evm(p_project, (select d from dd))
    ),
    t as (
      select
        count(*)::int                          as n,
        coalesce(sum(a.bac), 0)::numeric(14,2) as bac,
        coalesce(sum(a.pv),  0)::numeric(14,2) as pv,
        coalesce(sum(a.ev),  0)::numeric(14,2) as ev,
        coalesce(sum(a.ac),  0)::numeric(14,2) as ac
      from a
    )
    select
      (select d from dd),
      t.n,
      t.bac,
      t.pv,
      t.ev,
      t.ac,
      (t.ev - t.pv)::numeric(14,2),
      (t.ev - t.ac)::numeric(14,2),
      case when t.pv  > 0 then round(t.ev / t.pv,  3) end,
      case when t.ac  > 0 then round(t.ev / t.ac,  3) end,
      case when t.ev  > 0 and t.ac > 0
        then round(t.bac * t.ac / t.ev, 2) end,
      case when t.ev  > 0 and t.ac > 0
        then round(t.bac * t.ac / t.ev - t.ac, 2) end,
      case when t.ev  > 0 and t.ac > 0
        then round(t.bac - t.bac * t.ac / t.ev, 2) end,
      case when t.bac > 0 then round(t.ev * 100.0 / t.bac, 1) end
    from t
  ) q
  where public.is_internal();
$$;

comment on function public.fn_project_evm(uuid, date) is
  'Project earned value. Zero rows for a client (066): "CPI —" on a client '
  'screen would be a cost figure rendered as an absence, not a refusal.';


create or replace function public.fn_expense_total(
  p_project  uuid,
  p_from     date           default null,
  p_to       date           default null,
  p_category int            default null,
  p_source   expense_source default null
)
returns table (
  total_amount   numeric(14,2),
  total_gst      numeric(14,2),
  total_with_gst numeric(14,2),
  entry_count    bigint
)
language sql stable security invoker set search_path = public
as $$
  select * from (
    select
      coalesce(sum(e.amount), 0)::numeric(14,2),
      coalesce(sum(e.gst_amount), 0)::numeric(14,2),
      coalesce(sum(e.amount + e.gst_amount), 0)::numeric(14,2),
      count(*)
    from public.expenses e
    where e.project_id = p_project
      and e.voided_at is null
      and (p_from     is null or e.expense_date >= p_from)
      and (p_to       is null or e.expense_date <= p_to)
      and (p_category is null or e.category_id  =  p_category)
      and (p_source   is null or e.source       =  p_source)
  ) q
  where public.is_internal();
$$;


create or replace function public.fn_qa_summary(p_project uuid)
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
  select * from (
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
      where project_id = p_project
        and folder = 'qc_certificates'
        and coalesce(doc_kind, 'qa_plan') = 'qa_plan'
    )
    select c.open_c, c.urgent_c, c.high_c, c.total_c,
           n.open_n, n.minor_n, n.major_n, n.crit_n, n.corr_n, n.closed_n,
           d.docs
    from c, n, d
  ) q
  where public.is_internal();
$$;


create or replace function public.fn_safety_summary(p_project uuid)
returns table (
  last_incident_at    timestamptz,
  days_since_incident int,
  open_incidents      int,
  week_checklist_days int,
  week_days_elapsed   int
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
    with today as (
      select (now() at time zone 'Asia/Kolkata')::date as d
    ),
    wk as (
      select date_trunc('week', (select d from today))::date as monday,
             (select d from today) as today
    ),
    li as (
      select max(occurred_at) as last_at
      from public.incidents where project_id = p_project
    )
    select
      li.last_at,
      case
        when li.last_at is null then null
        else (select d from today)
             - (li.last_at at time zone 'Asia/Kolkata')::date
      end,
      (select count(*)::int from public.incidents
         where project_id = p_project and status = 'open'),
      (select count(distinct check_date)::int from public.safety_checklists
         where project_id = p_project
           and check_date between (select monday from wk) and (select today from wk)),
      ((select today from wk) - (select monday from wk) + 1)::int
    from li
  ) q
  where public.is_internal();
$$;


create or replace function public.fn_project_clash_summary(p_project uuid)
returns table (
  open_count       int,
  resolved_count   int,
  verified_count   int,
  open_high        int,
  oldest_open_days int,
  awaiting_rfi     int
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
    select
      count(*) filter (where c.status::text = 'open')::int,
      count(*) filter (where c.status::text = 'resolved')::int,
      count(*) filter (where c.status::text = 'verified')::int,
      count(*) filter (where c.status::text = 'open'
                         and c.severity::text = 'high')::int,
      max(current_date - c.created_at::date)
        filter (where c.status::text = 'open')::int,
      count(*) filter (where c.status::text = 'open'
                         and c.rfi_id is not null
                         and r.response is null)::int
    from public.clashes c
    left join public.rfis r on r.id = c.rfi_id
    where c.project_id = p_project
      and public.is_member(c.project_id)
  ) q
  where public.is_internal();
$$;


create or replace function public.fn_photo_analysis_summary(p_project uuid)
returns table (
  total_count     int,
  suggested_count int,
  accepted_count  int,
  dismissed_count int,
  accept_rate_pct numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
    select
      count(*)::int,
      count(*) filter (where status::text = 'suggested')::int,
      count(*) filter (where status::text = 'accepted')::int,
      count(*) filter (where status::text = 'dismissed')::int,
      case when count(*) filter (where status::text <> 'suggested') > 0
        then round(
          count(*) filter (where status::text = 'accepted') * 100.0
          / count(*) filter (where status::text <> 'suggested'), 1)
      end
    from public.photo_analyses
    where project_id = p_project
      and public.is_member(project_id)
  ) q
  where public.is_internal();
$$;


create or replace function public.fn_project_approval_summary(p_project uuid)
returns table (
  pending_count       int,
  approved_count      int,
  rejected_count      int,
  oldest_pending_days int,
  no_evidence_count   int
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
    select
      count(*) filter (where a.status::text = 'pending')::int,
      count(*) filter (where a.status::text = 'approved')::int,
      count(*) filter (where a.status::text = 'rejected')::int,
      max((current_date - a.created_at::date))
        filter (where a.status::text = 'pending')::int,
      count(*) filter (where a.status::text <> 'pending'
                         and cardinality(a.evidence) = 0)::int
    from public.client_approvals a
    where a.project_id = p_project
      and public.is_member(a.project_id)
  ) q
  where public.is_internal();
$$;


-- fn_labour_headcount_check (054). Two headcounts and their variance. A client
-- reading "site log 0, attendance 0, variance 0" would conclude nobody worked.
create or replace function public.fn_labour_headcount_check(
  p_project uuid,
  p_date    date
)
returns table (
  site_log_total   int,
  attendance_total int,
  variance         int
)
language sql
stable
set search_path = public
as $$
  select * from (
    select
      coalesce((select sum(coalesce(s.labour_mason,0) + coalesce(s.labour_helper,0)
                         + coalesce(s.labour_other,0))::int
                from public.site_logs s
                where s.project_id = p_project and s.log_date = p_date), 0),
      coalesce((select sum(a.workers_present)::int
                from public.labour_attendance a
                where a.project_id = p_project and a.work_date = p_date
                  and a.voided_at is null), 0),
      coalesce((select sum(a.workers_present)::int
                from public.labour_attendance a
                where a.project_id = p_project and a.work_date = p_date
                  and a.voided_at is null), 0)
      - coalesce((select sum(coalesce(s.labour_mason,0) + coalesce(s.labour_helper,0)
                           + coalesce(s.labour_other,0))::int
                  from public.site_logs s
                  where s.project_id = p_project and s.log_date = p_date), 0)
  ) q
  where public.is_internal();
$$;


-- ############################################################
-- ###  3. v_portfolio_summary — the one view with the same shape
-- ############################################################
-- Drop-then-create, never `create or replace view` (house rule — it has bitten
-- this repo three times). CASCADE is not needed: nothing reads this view.

drop view if exists public.v_portfolio_summary;

create view public.v_portfolio_summary with (security_invoker = true) as
select * from (
  select
    count(*)::int                                              as project_count,
    count(*) filter (where p.status = 'active')::int           as active_count,
    count(*) filter (where s.remaining < 0)::int               as over_budget_count,
    coalesce(sum(s.total_spent), 0)::numeric(14,2)             as total_spent,
    coalesce(sum(s.total_budget), 0)::numeric(14,2)            as total_budget,
    coalesce(sum(s.remaining), 0)::numeric(14,2)               as remaining,
    case
      when coalesce(sum(s.total_budget), 0) > 0
        then round(sum(s.total_spent) * 100.0 / sum(s.total_budget), 1)
    end                                                        as pct_used
  from public.v_project_spend s
  join public.projects p on p.id = s.project_id
) q
where public.is_internal();

comment on view public.v_portfolio_summary is
  'Single-row roll-up across every project the caller can see. Inherits the '
  'voided-expense exclusion from v_project_spend. Returns ZERO ROWS to a '
  'client (066), not a row of zeros.';

grant select on public.v_portfolio_summary to authenticated;


-- ############################################################
-- ###  4. The assistant is not part of the client portal
-- ############################################################
-- The Edge Function already answers a client 403. That is the courtesy; this is
-- the protection (the 064 rule — make the forbidden thing unreachable, not
-- forbidden).
--
-- fn_assistant_quota RAISES rather than returning zero rows, because it is a
-- WRITE: it increments the counter before it answers. A client calling it was
-- silently consuming a quota row — which is how the sweep created the one
-- `assistant_usage` row it then reported as a finding.

create or replace function public.fn_assistant_quota(p_limit int default 60)
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

  -- 066: refuse BEFORE the insert, so a client cannot create a usage row.
  if public.is_client() then
    raise exception 'The assistant is not part of the client portal.'
      using errcode = '42501';
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


create or replace function public.fn_assistant_stats()
returns table (
  proposed_count   int,
  confirmed_count  int,
  cancelled_count  int,
  confirm_rate_pct numeric,
  calls_today      int
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
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
    from public.assistant_actions
  ) q
  where public.is_internal();
$$;


-- The usage table itself. `user_id = auth.uid()` was correct while every
-- account belonged to the firm — the 065 lesson, one more time.
drop policy if exists assistant_usage_own on public.assistant_usage;
create policy assistant_usage_own on public.assistant_usage
  for select to authenticated
  using (user_id = auth.uid() and public.is_internal());


-- ############################################################
-- ###  5. fn_schedule_template — 120 rows of the firm's own method
-- ############################################################
-- A pure function, so no RLS ever applied to it and it happily handed a client
-- the firm's entire construction sequence: every activity, its duration, and
-- what runs in parallel with what. Not confidential like a rate, but it is how
-- Your Masons builds, and there is no reason a client should be able to read it
-- out of the API.
--
-- Adding the filter means it consults auth.uid(), so it can no longer be
-- IMMUTABLE. It becomes STABLE — which is what it always should have been for
-- anything that will now look at the session.
--
-- The 120 rows are NOT copied into this migration. The original function is
-- renamed to `_rows` and kept exactly as it is — pure, immutable, and now
-- unreachable from the API — and `fn_schedule_template` becomes a thin filter
-- over it. Copying the table would create a second copy of the firm's build
-- sequence that has to be kept in step with the first, which is how the two
-- eventually disagree about how long a slab takes to cure.

do $do$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_schedule_template_rows'
  ) then
    alter function public.fn_schedule_template(int)
      rename to fn_schedule_template_rows;
  end if;
end $do$;

-- Not callable from the API: the only way in is through the filtered wrapper.
revoke all on function public.fn_schedule_template_rows(int)
  from public, anon, authenticated;

create or replace function public.fn_schedule_template(p_floors int)
returns table (
  seq       int,
  code      text,
  name      text,
  base_days numeric,
  kind      text,
  par       boolean,
  phase     text
)
language sql
stable
security definer            -- so it may call the revoked _rows function
set search_path = public
as $$
  select t.* from public.fn_schedule_template_rows(p_floors) t
  where public.is_internal();
$$;

revoke all on function public.fn_schedule_template(int) from public, anon;
grant execute on function public.fn_schedule_template(int) to authenticated;


-- ---------- VERIFY ----------
-- Run as the founder through the app, NOT from the SQL editor: as `postgres`,
-- auth.uid() is null, my_role() is null, is_internal() is FALSE, and every
-- function below correctly returns zero rows. That is the gate working, and it
-- is exactly the 038 trap.
--
-- The real verification is the client sweep: re-run client-security-sweep.js as
-- the test client. It must report 0 failures across all 147 surfaces.

select
  count(*) filter (where p.proname = 'fn_company_pnl')            as company_pnl,
  count(*) filter (where p.proname = 'fn_project_evm')            as project_evm,
  count(*) filter (where p.proname = 'fn_schedule_template')      as schedule_template,
  count(*) filter (where p.proname = 'fn_assistant_quota')        as assistant_quota
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public';
-- Each must be exactly 1 — two means an overload survived (the 035 trap).
