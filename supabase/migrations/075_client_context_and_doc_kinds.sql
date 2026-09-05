-- ============================================================
-- MASON OS — Migration 075: revised contract in the portal, and
--                           document sharing that is opt-in BY TYPE
--
-- Two unrelated review findings, one migration because both touch the client
-- layer and both are small.
--
-- ############################################################
-- PART A — "110% of contract" without saying which contract
-- ############################################################
-- `v_client_spend_summary` compares spend against `projects.contract_value` —
-- the ORIGINAL contract. Once approved variations exist, that is the wrong
-- denominator: a client who signed three variations sees "112% of contract" and
-- reasonably concludes the job is over budget, when the truth is that they
-- asked for more work and approved the cost.
--
-- The firm has computed this correctly since 016: `v_project_contract` carries
-- `revised_contract_value = contract_value + approved variations`. That view is
-- founder/pm/accounts only (it also exposes pending and cancelled variation
-- values, which are the firm's negotiating position), so the client view
-- recomputes just the approved half.
--
-- ONLY APPROVED variations. A submitted VO is a proposal; including it would
-- show the client a contract value they have not agreed to, and quietly inflate
-- the denominator to make spend look better. Cancelled ones are excluded for
-- the obvious reason.
--
-- The three components are returned SEPARATELY, so the portal can show
-- "Contract + Approved variations = Revised contract" as an arithmetic the
-- client can check, rather than one number they have to trust.
--
-- ############################################################
-- PART B — a client should not see an RFI to your consultant
-- ############################################################
-- Today `documents.client_visible` can be set on ANY non-confidential document.
-- That is too broad, and the reason is structural: RFIs file into the
-- `drawings` folder, site instructions into `other`, VOs into `contracts` — all
-- with NO `doc_kind` — so an RFI to a consultant is indistinguishable from an
-- architectural drawing by folder alone.
--
-- Two halves:
--   1. `fn_doc_kind_shareable(text)` — the allow-list, in ONE place so the UI
--      and the database cannot disagree about what may be shared.
--   2. `fn_set_document_shared` re-emitted to refuse a kind that is not on it.
--
-- The firm chose: drawings/contracts/permits/photos (plain uploads, no kind),
-- variation orders, progress invoices, and QA plans. Excluded: RFIs, site
-- instructions, NCRs, purchase orders and comparative statements.
--
-- COMPARATIVE STATEMENTS ARE EXCLUDED AND ALWAYS WILL BE. They are a table of
-- what each vendor quoted. Sharing one hands the client the firm's entire
-- buying position, and no configuration screen should be able to turn that on —
-- which is why the allow-list is a function in a migration and not a settings
-- table.
--
-- BACKFILL. Documents filed before this migration have a null `doc_kind`, and
-- null means "a plain upload" — which is shareable. That would leave every
-- existing RFI and SI shareable, so they are stamped from their title prefix,
-- which the filing screens have always written (`RFI-0002 · RFI`).
-- Deliberately conservative: it only stamps rows whose title matches the
-- generated pattern AND whose doc_kind is still null.
--
-- Re-runnable: create-or-replace, drop-then-create for the view, and the
-- backfill is a no-op on a second run because doc_kind is no longer null.
-- ============================================================


-- ############################################################
-- ###  A1. The client's open book, with the right denominator
-- ############################################################

drop view if exists public.v_client_spend_summary cascade;

create view public.v_client_spend_summary as
select
  p.id                                            as project_id,
  coalesce(p.contract_value, 0)::numeric(14,2)    as contract_value,
  -- Approved variations only. A submitted VO is a proposal, not an agreement.
  coalesce(v.approved_value, 0)::numeric(14,2)    as variations_value,
  (coalesce(p.contract_value, 0)
     + coalesce(v.approved_value, 0))::numeric(14,2)
                                                  as revised_contract_value,
  -- How many, so the portal can say "3 approved variations" and the client can
  -- reconcile it against what they signed rather than taking a number on trust.
  coalesce(v.approved_count, 0)::int              as variations_count,
  coalesce(s.spent, 0)::numeric(14,2)             as spent,
  -- Against the REVISED figure. This is the number that changes: before, a
  -- client with variations saw a percentage of a contract that no longer
  -- described the job they had asked for.
  case when (coalesce(p.contract_value, 0) + coalesce(v.approved_value, 0)) > 0
    then round(
      coalesce(s.spent, 0) * 100.0
      / (coalesce(p.contract_value, 0) + coalesce(v.approved_value, 0)), 1)
  end                                             as pct_of_contract
from public.projects p
left join lateral (
  select sum(e.amount + e.gst_amount) as spent
  from public.expenses e
  where e.project_id = p.id and e.voided_at is null
) s on true
left join lateral (
  select
    sum(vo.cost_impact)                as approved_value,
    count(*)                           as approved_count
  from public.variation_orders vo
  where vo.project_id = p.id
    and vo.status::text = 'approved'
) v on true
where p.id = public.fn_client_project();

comment on view public.v_client_spend_summary is
  'Open book for the client. Spend measured against the REVISED contract '
  '(original + APPROVED variations only, 075) with the components returned '
  'separately so the arithmetic is checkable. No fee, no margin, no pending or '
  'cancelled variation values.';

grant select on public.v_client_spend_summary to authenticated;


-- ############################################################
-- ###  B1. Which document kinds may reach a client
-- ############################################################
-- IMMUTABLE and pure: it is a lookup, it consults no table and no session. That
-- also means the 066 warning about pure functions does not apply — there is
-- nothing here a client could learn by calling it, only the firm's policy,
-- which the client experiences anyway.

create or replace function public.fn_doc_kind_shareable(p_kind text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_kind, '') in (
    '',                       -- a plain upload: drawing, contract, permit, photo
    'variation_order',        -- the VO the client is asked to agree to
    'invoice',                -- the progress bill itself
    'qa_plan'                 -- test certificates and quality plans
  )
  -- NOT shareable, and each for its own reason:
  --   rfi                    a question to a consultant, often about a problem
  --   site_instruction       an instruction to the site, internal direction
  --   ncr                    a non-conformance: the firm's own defect record
  --   purchase_order         carries rates
  --   comparative_statement  carries every vendor's quote. Never shareable.
$$;

comment on function public.fn_doc_kind_shareable(text) is
  'The single source of truth for which document kinds may be shared with a '
  'client. Read by fn_set_document_shared and by the vault UI, so the button '
  'and the database can never disagree.';

revoke all on function public.fn_doc_kind_shareable(text) from public, anon;
grant execute on function public.fn_doc_kind_shareable(text) to authenticated;


-- ############################################################
-- ###  B2. Stamp the kind on documents filed before this migration
-- ############################################################
-- The filing screens have always written a title of the form `RFI-0002 · RFI`,
-- so the prefix is reliable. Only rows still null are touched, and only where
-- the title matches — a hand-uploaded document called "RFI response notes"
-- keeps its null kind and stays shareable, which is the safe direction for a
-- document somebody typed a name for themselves.

update public.documents
   set doc_kind = 'rfi'
 where doc_kind is null and title ~ '^RFI-[0-9]+ · ';

update public.documents
   set doc_kind = 'site_instruction'
 where doc_kind is null and title ~ '^SI-[0-9]+ · ';

update public.documents
   set doc_kind = 'variation_order'
 where doc_kind is null and title ~ '^VO-[0-9]+ · ';

update public.documents
   set doc_kind = 'purchase_order'
 where doc_kind is null and folder::text = 'purchase_orders';

-- Anything already shared that is NOT shareable under the new rule is
-- withdrawn. Doing this quietly is the point: leaving an RFI visible because it
-- was shared before the rule existed would make the rule advisory.
update public.documents
   set client_visible = false
 where client_visible
   and not public.fn_doc_kind_shareable(doc_kind);


-- ############################################################
-- ###  B3. Refuse a non-shareable kind at the door
-- ############################################################
-- Re-emitted from 069 with one added check. Everything else is unchanged.

create or replace function public.fn_set_document_shared(
  p_document uuid,
  p_shared   boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project      uuid;
  v_confidential boolean;
  v_kind         text;
begin
  select project_id, is_confidential, doc_kind
    into v_project, v_confidential, v_kind
  from public.documents
  where id = p_document;

  if v_project is null then
    raise exception 'That document no longer exists.' using errcode = '22023';
  end if;

  if not public.is_member(v_project) then
    raise exception 'That document is not on a project you work on.'
      using errcode = '42501';
  end if;

  if public.my_role()::text not in ('founder', 'pm') then
    raise exception 'Only a founder or project manager decides what the client sees.'
      using errcode = '42501';
  end if;

  if p_shared and v_confidential then
    raise exception 'A confidential document cannot be shared with a client.'
      using errcode = '42501';
  end if;

  -- 075. The UI hides the control for these, so reaching here means somebody
  -- called the API directly — which is exactly when the check has to hold.
  if p_shared and not public.fn_doc_kind_shareable(v_kind) then
    raise exception
      'A % is an internal record and cannot be shared with a client.',
      coalesce(replace(v_kind, '_', ' '), 'document')
      using errcode = '42501';
  end if;

  update public.documents
     set client_visible = p_shared
   where id = p_document;
end $$;

revoke all on function public.fn_set_document_shared(uuid, boolean) from public, anon;
grant execute on function public.fn_set_document_shared(uuid, boolean) to authenticated;


-- ############################################################
-- ###  B4. The curated view enforces it too
-- ############################################################
-- Belt and braces, and it matters: a document could have been shared before
-- this migration and missed by the backfill, or a future migration could add a
-- second way to set client_visible. The view is what the portal lists AND what
-- 070's storage policy keys on, so putting the rule here withdraws the row and
-- the file together.

drop view if exists public.v_client_documents cascade;

create view public.v_client_documents as
select d.id, d.project_id, d.folder, d.title, d.file_path, d.file_type,
       d.doc_kind, d.created_at
from public.documents d
where d.project_id = public.fn_client_project()
  and d.client_visible
  and not d.is_confidential
  and public.fn_doc_kind_shareable(d.doc_kind);

comment on view public.v_client_documents is
  'Documents shared with the client. Three independent conditions — shared, '
  'not confidential, and a shareable KIND (075) — so no single flag is '
  'load-bearing. 070''s storage policy reads this view, so a row and its file '
  'are withdrawn together.';

grant select on public.v_client_documents to authenticated;


-- ---------- 074 depends on v_client_documents? No, but 070's policy does ----------
-- `drop … cascade` above removes any dependent view. v_client_photos reads
-- `documents` directly, not this view, so it survives — this block proves it
-- rather than assuming, because 071 is what happens when that assumption is
-- wrong.
do $$
begin
  if not exists (
    select 1 from pg_views where schemaname = 'public' and viewname = 'v_client_photos'
  ) then
    raise exception
      'v_client_photos was dropped by the cascade — re-run migration 074.';
  end if;
end $$;


-- ---------- VERIFY ----------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'v_client_spend_summary'
      and column_name in ('revised_contract_value','variations_value','variations_count'))
                                                                     as spend_cols,
  public.fn_doc_kind_shareable(null)                                 as plain_upload_ok,
  public.fn_doc_kind_shareable('variation_order')                    as vo_ok,
  public.fn_doc_kind_shareable('rfi')                                as rfi_blocked,
  public.fn_doc_kind_shareable('comparative_statement')              as rates_blocked;
-- Expect: 3, true, true, false, false.
