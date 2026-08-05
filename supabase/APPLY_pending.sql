-- ==============================================================
-- MASON OS — pending migrations.
--
-- PENDING: 035 only. 001–034 are all APPLIED (034 confirmed 2026-08-01).
-- Run this whole file in the Supabase SQL editor, then confirm.
--
-- Re-runnable: add-column-if-not-exists, and the function is dropped
-- before it is recreated because its signature changed.
-- ==============================================================

-- ============================================================
-- MASON OS — Migration 035: attachments on an RFI response
--
-- An answer to an RFI is very often a marked-up sketch, a revised detail or a
-- letter — not a paragraph of text. Until now only the QUESTION could carry
-- files, so the actual answer arrived by WhatsApp and lived nowhere.
--
-- ---------- WHY A SEPARATE COLUMN ----------
-- `attachments` stays what the question was raised with; `response_attachments`
-- is what came back. Merging them would make the record unable to answer "what
-- did we send, and what did they send back" — which is the whole reason to keep
-- an RFI log rather than a chat thread.
--
-- ---------- WHICH BUCKET ----------
-- Response files go in the `documents` bucket, not `site-photos`. A consultant
-- replies with a PDF or a DWG, and the site-photos path compresses everything
-- to JPEG — which would silently destroy a drawing. The documents bucket
-- uploads non-images byte-for-byte, and its RLS is is_member() plus the
-- confidential check, so every project member can open an RFI response exactly
-- as they can open the RFI itself.
--
-- The text answer is still mandatory: fn_answer_rfi refuses a blank response
-- whether or not a file came with it. "See attached" is a summary somebody can
-- read in a list; a bare file is not.
--
-- Re-runnable: add-column-if-not-exists, drop-then-create on the function
-- (its signature changes, so create-or-replace alone would leave the old
-- three-argument version behind as an overload).
-- ============================================================


-- ############################################################
-- ###  1. COLUMN
-- ############################################################

alter table public.rfis
  add column if not exists response_attachments text[] not null default '{}';

comment on column public.rfis.response_attachments is
  'Storage paths in the `documents` bucket — what the consultant sent back. '
  'Kept apart from `attachments`, which is what the question went out with.';


-- ############################################################
-- ###  2. fn_answer_rfi — now takes the files
-- ############################################################
-- The old signature must go first: adding a defaulted parameter creates an
-- OVERLOAD, and a later call with three arguments would then be ambiguous.
drop function if exists public.fn_answer_rfi(uuid, text, date);

create or replace function public.fn_answer_rfi(
  p_id       uuid,
  p_response text,
  p_date     date,
  p_files    text[] default '{}'
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_response), '') = '' then
    raise exception 'Record what the consultant actually said — the answer cannot be blank.'
      using errcode = '22023';
  end if;

  select project_id, status::text into v_project, v_status
  from public.rfis where id = p_id;

  if v_project is null then
    raise exception 'That RFI no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may record an RFI response.'
      using errcode = '42501';
  end if;
  if v_status = 'cancelled' then
    raise exception 'That RFI was cancelled — raise a new one instead.';
  end if;

  update public.rfis
     set response      = btrim(p_response),
         response_date = coalesce(p_date, current_date),
         responded_by  = auth.uid(),
         status        = 'answered'::rfi_status,
         -- Files APPEND rather than replace: correcting the wording of an
         -- answer should not silently drop the sketch that came with it.
         response_attachments =
           case
             when p_files is null or cardinality(p_files) = 0
               then response_attachments
             else response_attachments || p_files
           end,
         closed_at     = null,
         updated_at    = now()
   where id = p_id;
end $$;

revoke all on function public.fn_answer_rfi(uuid, text, date, text[]) from public, anon;
grant execute on function public.fn_answer_rfi(uuid, text, date, text[]) to authenticated;


-- ############################################################
-- ###  3. VERIFY
-- ############################################################
-- Expect one row: rfis.response_attachments.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'rfis'
  and column_name = 'response_attachments';

-- Expect exactly ONE fn_answer_rfi, taking four arguments. Two rows here means
-- the old overload survived and calls will be ambiguous.
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'fn_answer_rfi';
