# PROGRESS — Mason OS
> Cowork: read CLAUDE.md + ROADMAP.md + this at session start; update at session end.

## M36 CLIENT COMMUNICATION LOG (2026-09-09) — dispute material

Three tables, one screen under Tasks: the log itself, a commitments tracker and
a complaint register. Migration 083.

### The commercial flag is the money rule applied to free text
A client log is mostly commercial — "they think the terrace railing is too
expensive", "agreed ₹2L for the extra bathroom". A summary field **cannot be
column-gated** the way `po_lines.rate` is (012); there is no column to revoke.

So the row carries `is_commercial`, `cce_read` hides those rows from
supervisors, and **the default is TRUE**. That direction is the whole safety of
it: a hurried entry is hidden rather than exposed, and somebody has to
deliberately mark a conversation as site-only. A BEFORE trigger also forces it
true whenever the entry links to a VO or an approval, so the person typing does
not have to remember. Same family as 023's `has_cost_implication` — flag the
row, let the policy hide it, never restate the money rule where it can drift.

Supervisors read their project's non-commercial entries and **cannot write at
all**. A supervisor who took the call tells the office, which is how the firm
works anyway.

### The 24-hour freeze
"Append-only-feel, edits tracked in audit" needed a decision about how long an
edit stays possible. Editable-forever means the entry AS DISPLAYED can be
silently rewritten in 2028 and a reader has to dig through `audit_log` to know —
which makes "append-only" a description of the UI rather than a property of the
data. Never-editable makes a typo permanent.

So: 24 hours, enforced by `fn_comm_entry_freeze`, a TRIGGER rather than a form
rule — a form-only check disappears the first time anything talks to the API
(the 050 lesson). The error names the remedy: log a new entry correcting it.
No DELETE policy at all.

Deliberately NOT applied to commitments and complaints: those describe an OPEN
state that is supposed to change. Freezing them would make the registers
useless.

### Three tables, not one
A commitment has a due date and a done/pending state; a complaint has a
resolution note and an open/resolved state. One table behind a `kind` column
would leave half the columns null on every row and make "show me everything
overdue" a query about which nulls matter. Both link to an entry through a
NULLABLE `entry_id` — a promise made on a call points at it, one that arrives
another way is still tracked — and ON DELETE SET NULL, because deleting the
record of a phone call must not delete the promise made during it (031).

Closing constraints do the work the form only asks for: `ccm_closed_has_date`
refuses a commitment marked done with no date, `ccp_resolved_needs_both`
refuses a complaint marked resolved with no account of how.

### A test that proved nothing, caught
The first run of the constraint tests reported both as "refused" — but they had
failed on `created_by` being null, because the test ran as `postgres` where
`auth.uid()` is null. Neither CHECK constraint had been exercised at all. Fixed
by supplying `created_by` and asserting the valid version is also accepted. The
066 lesson in miniature: a test proves only what it thought to ask, and a green
result is worth checking twice when it comes for free.

### Verified by query, not by reading
Founder sees 2 entries, **the supervisor sees only the non-commercial 1**, the
client 0. A supervisor INSERT refused. A VO link forcing `is_commercial` true
even when sent false. An edit inside the window accepted, one at 30 hours
refused with the readable message. `DELETE 0`.

## M21 PETTY CASH (2026-09-09) — the module that had a backend and no screen

Built since 002, reachable by nobody. Now: account list with the live balance,
open an imprest (founder/accounts), daily entry form, entry list with a running
balance and the void path, and reconciliation.

### A bug that had been live for seven months
`fn_pc_to_expense` mirrors a petty cash SPEND into the ledger with
`coalesce(new.category_id, 999)` — meaning "fall back to Misc". But
`expense_categories.id` is a **SERIAL** and the 002 seed inserts `(name, sort)`
without ids, so 'Misc' is **id 18 with sort 999**. There has never been a
category with id 999.

So an uncategorised petty cash spend raised
`expenses_category_id_fkey`, and because the trigger runs in the same
transaction **the entry itself was refused**. `petty_cash_entries.category_id`
is nullable, so the schema openly invites the case that breaks it.

Nobody reported it because there was no screen — it would have fired on the
first spend logged through the UI this session was written to build. The 069
lesson again: a capability nobody exercises is a capability nobody discovers is
broken. Found by RUNNING the migration chain, not by reading it. Repaired in
082 §0: resolve Misc by NAME, and raise a sentence naming the fix if it is ever
absent rather than inventing master data (050).

### Migration 082 — a count is a record
`petty_cash_counts`. The design decision is `book_balance` being **stored and
frozen** rather than derived on read: a reconciliation is evidence about a
moment, and voiding an entry from three weeks ago must not silently restate
what last month's count was checked against. Proven by test — voiding an entry
moved the live balance 21750 → 24750 while both stored counts stayed at 22000.

`variance` is GENERATED, because it is a consequence of two columns on the same
row and nobody should have a field to type it into (033). A variance with no
note is refused by a CHECK constraint, not only by the form.

**No adjusting entry, deliberately.** A count that disagrees is REPORTED and
nothing else. One line would write a `spend` for the difference — and that line
would move real money in the project ledger because two numbers did not match.
`pc_entry_type` is left alone for the same reason: an 'adjustment' value would
create a category of spend that never had a receipt.

**Append-only**: SELECT and INSERT policies, no UPDATE and no DELETE. A
mis-typed count is corrected by counting again, which is also what happens with
actual cash.

### One component, two doorways
`/money/petty-cash` for the office and `/tasks/petty-cash` for the holder.
`/money` is MONEY_ROLES, which excludes the supervisor who usually holds the
tin — while `pca_read`/`pce_read` (002, re-emitted in 078) have always granted
a HOLDER their own account, and the roles matrix has always said "petty-cash
entry". The permission existed and was unreachable.

The same component serves both because **RLS already separates them**. Nothing
filters by role to decide which accounts appear; a client-side filter would be
a second copy of the policy and the two would drift. Role decides only which
BUTTONS exist — opening an account is founder/accounts (`pca_write`), voiding
is founder/accounts (021) — and they are hidden rather than shown-and-refused.
The Tasks tab is supervisor-only, because everyone else already has the screen
under Money.

### Two smaller judgements
- **Topping up is an ENTRY, never an edit to `imprest_amount`.** Raising the
  imprest figure would restate every historical balance and the tin would
  appear to have held more money last month than it did.
- **The running balance is walked BACKWARDS from `v_petty_cash_balance`**, not
  summed forwards from the imprest. Summing would be a second implementation of
  the view's arithmetic in TypeScript, and the two would eventually disagree
  about a voided row.

## GRN + SNAG DOCUMENTS (2026-09-08) — the two that didn't exist

The letterhead pass covered every letterhead in the repo, but two document types
the firm asked for had no generator at all: **goods receipt notes** and **snag
reports**. Built now, on the shared letterhead.

### Migration 081 — a GRN needs a number
`goods_receipts` has had no human-readable reference since 012. Fine while the
GRN only appeared beside its PO in the app; not fine once it is a printed sheet
somebody files. `GRN-0001` from a sequence, matching PO-000042 / SNG-0001 /
NCR-0001 / CA-0001 / CLH-0001.

**The order of the backfill and the setval IS the migration.** Number the
existing rows first, then advance the sequence past the highest number used —
the other way round hands the next real receipt a number a historical row
already holds, and the UNIQUE refuses the insert. That is exactly the collision
the September test-data clear produced. The setval is wrapped in `greatest()` so
a re-run cannot wind the sequence backwards and reintroduce it.

**No guard trigger, and that is a decision.** 060 and 062 both refuse changes to
their document number with a BEFORE UPDATE trigger, because those tables have
writable UPDATE policies. `goods_receipts` has SELECT and INSERT and **no UPDATE
policy at all** — the 069 lesson inverted: here the absence of a policy is
already the protection, and a trigger would guard a welded door.

Verified with the ACTUAL 001–080 chain as fixtures (pgserver, one process):
three clean runs, verify block `1/1/1/1/0/0/t`, three receipts inserted OUT of
chronological order and numbered correctly, and the next receipt taking
**GRN-0004** without collision.

### The GRN carries no money, and that is why there is only one of it
The PO needs two variants — priced office copy, rate-free delivery copy —
because supervisors may not see rates. A GRN needs one, because a goods receipt
has nothing to hide: it records what physically arrived. `po_lines.rate` is
revoked at the column level (012) anyway, so a priced variant would fail for the
very people who receive deliveries. Ordered vs received per line, with short and
over **named on the line** rather than left to be worked out by subtracting two
columns. Three signature blocks, not two: the driver, our store, and the office.

**No running balance, deliberately.** `grn_lines` rows survive a void (voiding
reverses the material_inward rows it created, not the receipt lines), so a
browser-side sum of received-to-date would overstate. The correct cumulative
figure is `v_po_match.qty_received`, computed in Postgres, and it belongs on the
match screen. A delivery note that quietly disagreed with the match screen would
be worse than one that doesn't try.

A voided GRN still prints, with the VOID watermark — the stock was reversed, but
the note is the record that a lorry once turned up.

### Two snag documents, because there are two readers
- **Snag list** (`generateSnagListPdf`) — grouped **by work area**, because a
  punch list is walked rather than read. Prints what the on-screen filter is
  showing and says so on the sheet; an ambiguous scope starts an argument. The
  DLP window is stated in words. Descriptions elide at two lines: a punch list
  whose rows run to a paragraph stops being walkable.
- **Snag sheet** (`generateSnagPdf`) — one defect, NCR-shaped, with ruled lines
  in the rectification block so it can be completed by hand on site and
  photographed back.

**Photos are counted, not embedded** — the NCR precedent. Embedding means
downloading each object from storage, which turns these into async functions,
and fifty snags at two pictures each is a document nobody can email.

An empty list says *"This states that nothing is recorded, not that the works
have been inspected."* The 063 rule: an empty result must not read as an
all-clear.

### Role gates
Downloading either document is open to every role that can see the record —
there is no money on them. **Filing to the vault is gated on `canUploadDocs`**,
because `docs_write` (003) excludes supervisors, and offering a button RLS will
refuse is the thing this codebase keeps deciding not to do. The new
`doc_kind`s (`grn`) are not on `fn_doc_kind_shareable`'s allow-list (075), so
they can never be ticked visible to a client — the right default, and it needs
no migration because an unknown kind is refused.

### Found by rendering, not by reading
The GRN's material column collided with the right-aligned ordered quantity —
"TMT bar Fe500D 16mm — IS 1786, supplied in 12 m" printed straight through
"1,800.00 kg". The wrap width was computed from the column position, ignoring
that a right-aligned number grows leftwards into it. Fixed by measuring the
widest quantity with `getTextWidth` and reserving it; a fixed guess would be
right until somebody orders 12,000.00 kg of something. **The same latent bug
exists in poPdf's line table** — its quantities are shorter so it has not fired,
and it is left alone rather than changed without a case that reproduces it.

## LETTERHEAD (2026-09-08) — one definition, ten documents

`src/lib/pdf/letterhead.ts` is now the only letterhead in the app. Ten
generators each carried their own copy of the same block — same colours, same
brass rule, six slightly different sets of y-increments and three different
opinions about whether the tagline was optional. Changing the company's phone
number meant editing ten files and hoping.

`drawLetterhead(doc, { margin, scale })` draws it and **returns the y where the
caller's content starts**, so a generator never has to know how tall the header
is. `scale: 'compact'` is the landscape/dense variant (comparative statement,
MIS board pack). Layout is mark top-left, name and tagline beside it, the
postal and GSTIN block right-aligned, brass rule under the lot — about 20pt
shorter than the stacked version it replaces, so every portrait document gained
two lines of body space.

**The BBS sheet gets the mark only, NOT the letterhead** (`drawLogoMark`). That
sheet is the firm's own printed form, transcribed verbatim in 046/053; replacing
its heading with our stationery would be improving somebody's document without
being asked.

### The one thing that will bite whoever edits this
**jsPDF writes embedded bitmaps UNCOMPRESSED unless told otherwise.** The same
mark costs **347 KB** per document with no compression argument and **47.6 KB**
with `compression: 'FAST'` — measured, not estimated. That is the difference
between a purchase order a vendor can be emailed and one they cannot. Both
`drawLetterhead` and `drawLogoMark` pass it; anything that calls `addImage`
directly must too. jsPDF keys images by alias, so a three-page bar bending
schedule pays the 47.6 KB once, not three times.

### Why the artwork is base64 in a .ts file
Every generator is SYNCHRONOUS (`generatePoPdf(opts): void`). Loading the PNG
from `public/` would need an `Image.onload` and an async signature rippling
through ten generators and every call site. Inlining keeps them synchronous —
and a PO still prints with its letterhead on a site phone that is offline.

The format was MEASURED rather than guessed: seven candidates were embedded
through real jsPDF, rasterised at 300 dpi and compared at 4x magnification.
403x440 **palette PNG (colour type 3) with a tRNS alpha table**, 64 colours,
19 KB on disk / 26 KB of base64. At the letterhead's 46pt that is ~690 dpi, so
it stays crisp on a 600 dpi office laser. Full RGBA is 126 KB and
indistinguishable; 32 colours starts to show tonal steps in the gradient.
Palette + alpha is the risky combination in jsPDF, which is exactly why it was
tested through the library rather than reasoned about.

`drawLogoMark` catches a throw from `addImage` and returns 0, and the text block
slides left into the space. A document that refuses to generate because of its
logo is a far worse failure than one that prints without it.

### Footers
`drawPageFooters(doc, …)` must be called LAST — the page count is not known
until the body is laid out — and it restores the page pointer afterwards so a
caller that keeps drawing is not silently writing onto page 1. Default is
**multi-page only**: "Page 1 of 1" on a one-page invoice is noise, and this
firm's invoices are almost always one page. The BBS sheet and the MIS report
pass `onlyIfMultiPage: false`, because their notes (the constants a schedule was
cut to; that the MIS is scoped to the preparer) are the document's provenance
rather than decoration.

### Verified by rendering, not by reading
All ten were generated headlessly through the real modules (esbuild-bundled,
`jsPDF.API.save` patched to write to disk), rasterised with pdftoppm and looked
at: PO, delivery order, progress bill, VO, SI, RFI, RA bill (2 pages),
NCR, comparative statement (2 pages), MIS, BBS (3 pages). Header crisp at
300 dpi, no collisions, footers on the multi-page ones only, mark clear of the
BBS title box. Documents run 55–75 KB.

## BRAND MARK (2026-09-08) — the YM monogram wired in

Source artwork: 2048×2048 gold-on-charcoal, carrying a Gemini watermark
bottom-right. Pipeline (scripts were scratch, the outputs are in `public/`):

1. **Watermark painted out BEFORE measuring**, with the sampled field colour
   `[30,30,32]`. Measuring first would have dragged the bounding box into the
   corner and off-centred every icon.
2. Gold lifted onto transparency — alpha from `max(R,G,B)` with LO=60/HI=200
   (measured: field ≤56, gold ≥143 at p90), then **un-composited**
   `G = (C − (1−a)·B) / a`. Without that step every edge keeps a dark fringe,
   which is invisible on charcoal and obvious the moment the mark sits on cream.
3. Tight crop → 1126×1230. **Thinnest stroke 8px**, i.e. 3.64px at 512,
   1.36px at 192, **0.23px at 32**. That measurement is why there are two
   variants rather than one file scaled down — it is not a judgement call.
4. Connected-component labelling to split the artwork: comps 4/5 are the
   columns, comp 6 the **Y**, comp 7 the **M**. A flood fill from the centre had
   caught only the Y (the letters are separate components) and a guessed crop
   window had caught column fragments; both were visible on a contact sheet and
   neither was visible in the code.

**Two forms, and which is which:**
- `logo-full.png` (440×481, 25KB) — monogram inside the arch. Legible from
  about 80px. Login screen at 104px, and the 512 icon.
- `logo-mark.png` (160×202, 6KB) — monogram alone. Portal header at 38px, and
  the 192/maskable/favicon icons, thickened by a 3px max-filter **on the alpha
  channel only** so the letterforms fatten without the gold going flat.

Both are gold on TRANSPARENT. The charcoal tile belongs to the app icon, where
the OS owns the surface behind it; on screen the mark sits on the page.

Icons generated: `icon-512` (full mark, 0.78 coverage), `icon-192` (mark,
0.72), `icon-maskable-512` (**full mark at 0.58** — Android crops to a circle of
80% diameter, so the safe zone is much smaller than it looks),
`apple-touch-icon`, `favicon-32`, `favicon.ico` (16/32/48).

Manifest: `theme_color` **#1A1A18**, `background_color` #FAF8F5, short_name YMS.
**Known consequence, chosen deliberately**: the Android splash draws the icon on
the background colour, so a charcoal tile appears on cream for a beat. The
alternative — a charcoal background — would flash dark before a cream app.

`public/favicon.svg` was the old generic mark and is DELETED, not merely
unreferenced: leaving it means the previous logo is still served at a path
browsers ask for by habit. `sw.js` bumped `yms-v3` → **`yms-v4`** and its SHELL
list now carries the logos — the login screen is the first thing an offline user
sees, and a missing mark there reads as a broken app rather than a dead network.
The files are referenced by LITERAL path, never imported: a Vite-hashed URL
could not appear in that list. Renaming one means editing `sw.js` too.

## CYBER REVIEW (2026-09-07) — proportionate to 15 users

### Assistant prompt-injection audit — it holds
Read line by line, not assumed:
- Built ONLY from the caller's Authorization header. No service-role key
  anywhere in the assistant. Every query is the caller's own.
- Role read from `profiles`; a **client is refused outright** before the model
  is reached.
- **`runTool` re-checks `def.roles.includes(role)` at EXECUTION**, not just when
  building the declarations. This is the load-bearing line: a model that
  hallucinates or is talked into calling `project_spend` as a supervisor is
  refused by the server, not by the prompt.
- No text-to-SQL. Nineteen named tools, each one hard-coded query.
- Writes are propose → human confirm → `fn_assistant_execute`, which is
  **SECURITY INVOKER** (064 line 312) — an assistant write obeys the caller's
  own policies exactly as if they had typed the form.

**The genuine injection surface is `search_knowledge`**: it returns passages
from PDFs somebody uploaded, into the model's context. A poisoned document
could steer an ANSWER or produce a bogus proposal card. It cannot exceed RLS,
cannot call a tool the role lacks, and cannot write anything without a human
clicking confirm. Bounded, and worth knowing about.

### Real gap found and FIXED
No cap on inbound size. `message` and each `history` entry came from the
browser uncapped; the daily counter limited turns, not their size. Now clipped
to 4000 characters each (~1000 tokens). Cost, not security — but 60 turns a day
of megabyte prompts is a real bill.

### Still unbounded (recommended, not done)
`learn-draft` has **no per-user quota** — a PM can click Draft repeatedly. One
line reusing `fn_assistant_quota` would fix it, at the cost of sharing one
daily budget with the assistant. `photo-analyse` is naturally capped by the
unique index on `photo_path` (061): one analysis per photo, ever.

### Deploy note
`supabase functions deploy assistant` for the input cap.

## RENAMED TO "YMS" (2026-09-07) — app only, redeploy

`short_name` **YMS** (under the home-screen icon) · `name` **YMS — Your
Masons** (install prompt and splash) · tab title, `apple-mobile-web-app-title`,
service-worker push fallback all match.

**The name was in nine places, not one.** `src/lib/appName.ts` now holds
`APP_NAME` / `APP_NAME_FULL` and the five screens, the NCR PDF and the project
archive read from it. Three files still carry the string literally because they
are outside the TypeScript build and cannot import it — **`index.html`,
`public/manifest.webmanifest`, `public/sw.js`** — those are what to grep if the
name changes again.

External documents (NCR PDF, project archive) use `APP_NAME_FULL`: a consultant
reading an NCR should not meet a bare acronym.

`CACHE_VERSION` bumped `mason-os-v2` → `yms-v3`. The activate handler deletes
every cache not starting with the current version, so the old shell — holding
an index.html with the old title — goes with it. **Without the bump the rename
would not have appeared.**

### Two things to expect after deploying
- **An already-installed home-screen icon keeps its old label.** The OS reads
  the manifest at install time. Remove it and re-add to get "YMS".
- The in-app wordmark now reads **Your Masons / YMS**, which is slightly
  redundant. If you would rather the eyebrow went, it is one line in
  `AppShell.tsx`, `Login.tsx`, `MfaChallenge.tsx`, `SetPassword.tsx` and
  `AccountClosed.tsx`.

## TWO-FACTOR (TOTP) — 2026-09-07

**No migration. App only — redeploy after `npm run build`.**
**One dashboard switch first: Authentication → Multi-Factor → enable TOTP.**
Without it `enroll()` refuses and the Security screen says so in words rather
than passing through "MFA enrollment is disabled".

`src/lib/mfa.ts` wraps the Supabase MFA API · `/security` enrols (QR + manual
key + verify) and removes · `/mfa` is the sign-in challenge · `RequireAuth`
routes to it.

### The thing to understand
`signInWithPassword` **succeeds** for a user with a verified factor — it hands
back a real session at **aal1**. The password is never refused. What the app
does is refuse to go anywhere until the session reaches aal2. So the gate is in
`RequireAuth`, checked BEFORE the 078 deactivation branch and the 077 password
branch: an aal1 session survives a reload, and a check that only ran in the
login form could be skipped by refreshing the page.

**This is an app-level gate, not RLS.** A determined holder of a stolen password
plus the anon key could still talk to PostgREST on an aal1 session. Enforcing
`auth.jwt()->>'aal' = 'aal2'` in RLS is possible but would lock out every user
who has NOT enrolled, so it is not on until enrolment is universal. Same shape
as 077: this protects against a password alone at the front door.

### Break-glass — lost phone
Only somebody with database access can undo it:
```sql
delete from auth.mfa_factors
 where user_id = (select id from auth.users where email = 'them@example.com');
```
They then sign in with the password alone and enrol again.

## "CONFIRM EMAIL" IS ON — direct-created users were ALREADY fine
`admin-create-user` has always passed `email_confirm: true` to
`admin.auth.admin.createUser`, so a directly-created team member or client is
confirmed at the moment of creation and can sign in immediately. Turning on
"Confirm email" does not change that — the admin flag confirms regardless.
**Nothing needed building.** Invited users confirm by clicking the invitation,
which is correct: an invite exists precisely to prove the address.

Check nobody is stranded from before:
```sql
select u.email, u.created_at, p.role
from auth.users u left join public.profiles p on p.id = u.id
where u.email_confirmed_at is null order by u.created_at;
```
Any row there predates the flag or was made by hand in the dashboard. Fix:
```sql
update auth.users set email_confirmed_at = now()
 where email = 'them@example.com' and email_confirmed_at is null;
```

## SECURITY ADVISOR AUDIT (2026-09-06, migration 079)

**Run migration 079 before testing.** No behaviour change — it converts three
views and pins search_path on six functions.

### The 23 "Security Definer View" errors
All 22 owner-run views in the database were queried as **founder / pm /
accounts / supervisor / client** against a real PostgreSQL carrying real rows.
**None leaks.** Every money-bearing view returns 0 rows to a supervisor and 0
to a client; every `v_client_*` view returns 0 to all four internal roles and
its own rows to the client.

Three of them never needed owner rights and are now `security_invoker`:
`v_labour_cost`, `v_labour_project_cost`, `v_pnl_by_category` — counts
identical for all five roles before and after.

The other 19 must stay owner-run: 8 read a column REVOKED from `authenticated`
(`contract_value`, `management_fee_pct`, `po_lines.rate`,
`material_inward.rate`, `budget_amount`), 10 serve the client portal where
`is_member()` is false by construction, and `v_client_roster` reads
`auth.users`. Converting any of them returns a permission error to the founder
rather than tightening anything.

### The warnings
| finding | count | verdict |
|---|---|---|
| Functions with mutable search_path | 6 | **REAL — fixed in 079** |
| Policies calling auth fns per row (`auth_rls_initplan`) | ~152 | performance lint, deliberately deferred |
| Multiple permissive policies (`profiles` UPDATE) | 1 | safe by design — founder-edits-anyone OR edit-your-own |
| Tables with RLS disabled | **0** | — |
| Tables with RLS and no policy | **0** | — |
| Policies granting to `anon` / `public` | **0** | — |
| Extensions in `public` | **0** | — |

All 107 SECURITY DEFINER functions already pinned their search_path; the six
that did not were SECURITY INVOKER. Two of them (`is_founder`,
`fn_storage_project`) are read by RLS policies, which is what made this worth
fixing rather than dismissing.

### The 20th error: "Exposed Auth Users" (migration 080)
`v_client_roster` joins `auth.users` for `email` + `last_sign_in_at` (076).
Not an open door — it was gated at founder/pm/accounts and proven to return
zero rows to supervisors and clients. But the gate was **wider than every
consumer**: the only screen reading it is Admin → Clients, and `ADMIN_ROLES`
is `['founder']`. 080 narrows the view to `is_founder()` and moves
`fn_client_roster_summary` with it, so a PM gets zero rows rather than a row
of zeros. Roster access went **1/1/1/0/0 → 1/0/0/0/0** across
founder/pm/accounts/supervisor/client.

**The advisor will still show this error after 080** — it fires on the JOIN,
not the gate. Clearing it outright means moving `email` behind a SECURITY
DEFINER function; that is more machinery for an exposure now one role wide, so
it is an accepted error rather than an unexamined one.

### Dashboard toggles (cannot be set from SQL)
- Auth → leaked password protection: **ON**
- Auth → OTP / magic-link expiry: **≤ 1 hour**
- Auth → MFA: enable TOTP for the founder at least
- Postgres version: apply the patch upgrade when offered

## TEST DATA CLEARED (2026-09-06)

AADHYA and IHA were emptied of the records entered while checking the tabs —
41 tables, everything from expenses and invoices to snags, site logs and labour
attendance. **Kept:** both project rows, team assignments, client links,
AADHYA's 18 budget lines and its 142-activity programme.

All thirteen document sequences were then reset, so the firm's first real
document on each register is PO-000001 / VO-0001 / SI-0001 / RFI-0001 /
INV-P-0001. Verified: 11 of 11 registers report zero rows with the next number
at 1.

**Sequences do not roll back or reset on DELETE** — this is the thing to
remember. Clearing rows leaves the counter where it was, and resetting a
counter while numbered rows still exist causes a duplicate-key failure on the
next document, because `vo_number`, `invoice_number` and `po_number` are all
UNIQUE. Reproduced deliberately during this work. Order is always: clear first,
then reset.

Tools in `tools/`, all of which roll back by default:
  `clear-project-records.sql`  empty a project, keep the project
  `test-data-inventory.sql`    what is in the database, per project and user
  `user-delete-audit.sql`      which users can actually be deleted
  `remove-test-data.sql`       delete whole test projects and test users

The report in `clear-project-records.sql` writes to a TEMP TABLE and is read by
one final SELECT, **not `raise notice`** — the Supabase SQL editor does not
display notices, so a dry run reported through them shows the founder nothing.
Found the first time it was run for real.

Storage was NOT cleared in the same pass: deleting a `documents` row leaves the
object in the bucket. §4 of the clear script does it, commented out.

## "DEACTIVATE" NOW ACTUALLY DEACTIVATES (2026-09-06, migration 078)

**Run migration 078 before testing. Redeploy the app after.**

### The bug
Asked how to delete a user, the honest answer is that they are not deletable —
`profiles.id` is referenced by 104 foreign keys across 36 migrations and none of
them cascade, so Postgres refuses to remove anybody who has ever created a
record. CLAUDE.md has said "deactivate instead" since 022.

Checking that the alternative worked showed it did not. **`profiles.is_active`
was read by exactly nothing in the database** — not one policy, not one helper.
A deactivated staff member could still sign in and see every expense, vendor
rate and document their role allowed. The button removed them from assignee
dropdowns and from the daily push digest, and that was the whole of it.

Clients were the exception and were already safe: "Remove portal access" deletes
the `client_projects` row, so `fn_client_project()` returns null and every
curated view empties. Suspending a client, though, did nothing.

### The fix
- `is_active_user()`, and `my_role()` returns NULL for an inactive profile —
  which closes is_founder / is_internal / is_client / fn_client_project and
  every role-named policy at once.
- `is_member()` checks it FIRST, because it otherwise falls through to
  `project_members`, whose rows are deliberately kept so reactivation restores
  exactly what the person had.
- The twelve own-row policies that grant on `auth.uid()` re-emitted with the
  active check. Found by querying `pg_policies`, not by grepping — two of them
  (petty cash entries, reached through a subquery) were invisible to a grep.
- `fn_profile_active_guard` refuses deactivating yourself or the last active
  founder, as a BEFORE UPDATE trigger because Admin PATCHes the table directly.
- `AccountClosed.tsx` + a RequireAuth branch, so a deactivated user is TOLD
  rather than shown a dashboard of zeros.

Deliberately left open: `profiles_read` on your own row (or the app cannot tell
you why it stopped), and the four `push_subscriptions` own-row policies (no
company data, and the digest already filters `is_active`).

### Admin -> Team now separates them (UI only, no migration)
Deactivated staff move out of the working list into a collapsed **Deactivated
(n)** section at the bottom. Separated rather than hidden: Reactivate lives on
the card and users are not deletable (022), so hiding them outright would mean
somebody returning from leave could only be restored with SQL. The toast names
where the card went, because a row that simply vanishes reads as a delete.
Admin -> Clients still shows suspended clients inline; ask if that should match.

### Verified on a real PostgreSQL (001-077 chain as fixtures, three clean runs)
A PM with one project, before and after deactivation: `my_role()` pm → NULL,
`is_member()` t → f, and expenses / tasks / documents / projects / vendors /
v_project_pnl / petty cash accounts / petty cash entries / client_projects all
went from non-zero to **0 rows**. Updating their own expense, deleting their own
document and updating their own profile all went from 1 row to 0, and inserting
a petty-cash entry was refused outright. Reactivating restored **every one of
those numbers exactly**. A suspended client: `is_client()` t → f,
`fn_client_project()` → NULL, `v_client_project` 1 → 0, message insert refused.
The founder's own figures were unchanged throughout.

Both guards fired. Only the self-deactivation one is reachable through the app —
see CLAUDE.md for why.

**Not a substitute for revoking the password.** The account can still sign in;
the JWT simply buys nothing. For a hostile departure, deactivate here AND reset
the password in Supabase.

## ONBOARDING: DIRECT OR BY INVITE (2026-09-05, migration 077)

**Run migration 077 and redeploy `admin-create-user`.**

### What was already there
Both Admin forms have always created accounts DIRECTLY with a founder-typed
password. Roles map correctly, clients link to one project, staff link to
project_members, and Team/Clients are already separate tabs with separate types
and separate Edge Function branches. Three of the four requirements in the
request were already satisfied — verified rather than assumed, see below.

### What was actually missing
1. **The invite option.** `admin-create-user` now takes `mode: 'direct' |
   'invite'`; invite calls `inviteUserByEmail` with a redirect to
   /set-password. Both forms get a shared `CreateModePicker` so the two cannot
   drift. Direct is first and is the default, because an invite silently fails
   until custom SMTP is configured — and the function detects that specific
   failure and says to use "Set a password" instead.
2. **Nothing enforced the password change.** The Team form has always said
   "ask them to change it" and nothing made them. `profiles.must_change_password`
   is now set on the direct path, `RequireAuth` routes those accounts to
   /set-password, and `fn_clear_password_change` clears it once they have
   actually chosen one.

### Verified on a real PostgreSQL
A directly-created **client**: `role=client`, `is_client=t`, `is_internal=f`,
`is_member=f`, linked to one project — and **0 rows** on expenses, projects,
tasks, vendors and v_project_pnl, with 1 row on v_client_project.

A directly-created **supervisor**: `role=supervisor`, `is_internal=t`,
`is_member=t` on their project, and **0 rows** on expenses, v_project_pnl and
v_client_roster. (Tasks also read 0, but only because the test database has no
tasks — that is data, not a permission result, and is not evidence either way.)

`fn_clear_password_change` cleared only the CALLER's row: the supervisor's flag
went false while the client's stayed true.

## PASSWORD RECOVERY, BOTH DIRECTIONS (2026-09-05, migration 076)

**Run migration 076.**

Two ways in, because there are two people who get stuck:

- **The client, on their own** — "Forgot your password?" on the login form
  (built with the invite flow). Sends a recovery link to /set-password.
- **The founder, on their behalf** — **Send reset link** on each card in
  Admin -> Clients. Uses the anon key and `resetPasswordForEmail`; no Edge
  Function, no service-role key, nothing new to deploy.

### 076 — the roster learns two facts
`v_client_roster` had a name and exposure counts and no way to reach anybody.
It now carries `email`, `last_sign_in_at` and `has_signed_in`, joined from
auth.users. Safe because the view is owner-run and its WHERE clause is
unchanged: founder and accounts see every client, a PM sees their own projects'
clients, **supervisor and client get zero rows** — verified on a real
PostgreSQL, along with 067's summary function still resolving after the rebuild.

### The distinction that matters
A client who has **never signed in** did not forget a password — they never had
one. A reset link is the wrong email and leaves them exactly as stuck while the
founder believes the problem is solved. So the card shows their sign-in state,
and where a reset cannot help it shows a sentence instead of a button:
*"Has never signed in. They still need to set a password — send them their
invitation again rather than a reset link."*

Re-sending an invitation is service-role work and still waits on SMTP.

### Recovery email template
Supabase -> Auth -> Email Templates -> **Reset password**:
```html
<h2>Reset your password</h2>
<p>Follow the link below to choose a new password for Mason OS.</p>
<p><a href="{{ .SiteURL }}/set-password?token_hash={{ .TokenHash }}&type=recovery">Choose a new password</a></p>
<p>This link can only be used once and expires shortly. If you didn't ask for it, ignore this email.</p>
```

### Still blocked on SMTP
Supabase's built-in mailer **only delivers to members of the project team** and
is capped at 2 messages/hour, so no email reaches a real client until custom
SMTP is configured. Both templates and both code paths are ready; nothing has
been sent end to end yet.

## CLIENT INVITE / SET-PASSWORD FLOW (2026-09-05, no migration)

The invite email always landed on `/login`. Two independent causes, neither of
them in the email template — which is why editing the template never helped:

1. `supabase.ts` sets `detectSessionInUrl: false`, so supabase-js never consumed
   the token in the URL and no session ever appeared.
2. With no session, `RequireAuth` renders `<Navigate to="/login">`, and a
   react-router navigation to a new path **discards the hash**. The token was
   destroyed on the way to the wrong screen.

### What was built
- **`src/lib/authLink.ts`** — captures the token at MODULE LOAD, before the
  router mounts. Reads both wire formats (`#access_token=…&type=invite` and
  `?token_hash=…&type=invite`) plus the error form
  (`#error=…&error_code=otp_expired`), stores it module-level so a redirect or a
  StrictMode double-render cannot lose it, then strips the credentials out of
  the address bar with `replaceState`.
- **`/set-password`** — registered OUTSIDE `RequireAuth`, because with the
  `token_hash` form there is no session yet. Three phases: consuming, ready,
  dead. Consumes via `setSession` (hash) or `verifyOtp` (token_hash), takes a
  password through `updateUser`, then routes by role — client to `/portal`,
  staff to `/dashboard`.
- **Expiry handled in words**, not a blank error: "This link has expired —
  invitation links are valid for a short time and can only be used once. Ask
  your project team to send a new one."
- **"Forgot your password?" on the login form**, sending a recovery link to the
  same screen. Without it a recovery token could never be generated from inside
  the app. The success message is identical whether or not the address exists,
  so the form cannot be used to enumerate the firm's clients.

### `detectSessionInUrl` stays FALSE, deliberately
Turning it on would have "worked" and created a subtler bug: supabase-js would
swallow the hash, hand us a session, satisfy `RequireAuth`, and drop the invited
client into the portal **with no password set** — able to use the app once and
never able to sign in again. An invite must terminate at a password prompt, so
consuming the token is the app's decision to make, at the moment it is ready.

### Email template (Supabase → Auth → Email Templates → Invite user)
```html
<h2>You have been invited</h2>
<p>Your project team at Your Masons has set up your client portal.</p>
<p><a href="{{ .SiteURL }}/set-password?token_hash={{ .TokenHash }}&type=invite">Set your password</a></p>
<p>This link can only be used once and expires shortly.</p>
```
Reset password template is identical with `type=recovery`.

Deliberately NOT `{{ .ConfirmationURL }}`: that routes through
`/auth/v1/verify`, which some corporate mail scanners (Microsoft Defender Safe
Links) PREFETCH, consuming the one-time token before the human clicks it — the
invite then reports "expired" on first use. The `token_hash` form is inert until
the app calls `verifyOtp`. Both forms are handled either way.

Still open: `inviteUserByEmail` is not yet wired into `admin-create-user` — the
founder still sets an initial password. Needs SMTP configured on the Supabase
project first.

## CLIENT PORTAL REVIEW — CONTEXT AND DOCUMENT TYPES (2026-09-03, migration 075)

Three review findings. **Run migration 075.**

### 1. "110% of contract" now says WHICH contract
`v_client_spend_summary` measured spend against the ORIGINAL contract value, so
a client with approved variations saw a percentage over 100 with no explanation.
It now returns `contract_value`, `variations_value`, `variations_count` and
`revised_contract_value` separately, and both Open Book and Bills show the
arithmetic — original + approved variations = revised — rather than one number
the client has to take on trust. **Approved variations only**; a submitted VO is
a proposal, and counting it would inflate the denominator.

Bills additionally shows **billed to date** against the same baseline.

### 2. Document sharing is opt-in BY TYPE
The root problem was structural: RFIs file into the `drawings` folder, site
instructions into `other`, VOs into `contracts` — and no filing screen stamped
`doc_kind`, so an RFI to a consultant looked exactly like an architectural
drawing. All five screens now stamp the kind at creation.

**Shareable:** plain uploads (drawings, contracts, permits, photos), variation
orders, progress invoices, QA plans and test certificates.
**Never shareable:** RFIs, site instructions, NCRs, purchase orders, and
comparative statements — the last of those carries every vendor's quote, which
is why the list is a function in a migration rather than a settings screen.

Enforced in three independent places: the vault hides the toggle (and says why),
`fn_set_document_shared` raises, and `v_client_documents` filters — which also
withdraws the file, since 070's storage policy reads that view. A backfill
stamps existing documents and **withdraws anything already shared** that the new
rule excludes.

### 3. Approvals and messages, proven end to end
On a real PostgreSQL, as an actual client:
- pending approvals visible through `v_client_approvals`
- rejection with no reason -> **refused** ("Please say briefly why…")
- approve one, reject one with a reason -> both recorded, `method` becomes
  `signed`, `decided_by` stamped
- deciding an already-decided item -> **refused**
- the internal register shows the decision, the reason and the decider
- messages both directions, `author_name` null on the client's own
- the "From your client" strip then reports 1 unread, 2 unseen rejections

Also confirmed: the client cannot read `client_approvals` directly — only
through the curated view. My first test fixture selected from the base table and
was correctly refused.

## CLIENT PORTAL — SCREENS, SHARING, MESSAGES (2026-09-03, migrations 068-074)

The portal is now a working two-way surface, not a data layer with a holding
page. **Run 070, 071, 072, 073 and 074** — `supabase/APPLY_pending.sql` holds
all five in order.

### CP3 — the client's screens
`/portal` on its own shell (never AppShell, so no internal chrome can leak in):
Progress (budget-weighted %, stages by phase, open-book spend by category vs
contract), Photos (gallery + lightbox), Documents, Bills, Approvals
(approve / ask-for-a-change, reason required), Messages.

### CP4 — sharing, on the thing being shared
**Share with client** on a document in the vault, and on a saved photo in the
site log. Founder/PM only. Hidden entirely on a confidential document, because
the view and the storage policy both refuse one regardless of the flag —
offering the control would promise something Postgres then declines. Publishing
never lives on the Admin screen, which only REPORTS the counts.

### Five bugs found by using it, four of them mine
- **068** — 065 exposed document/photo ROWS but never touched storage, whose
  policies key on `is_member()`, which 065 had just made false for a client. The
  portal would have listed files nobody could open.
- **069** — `documents` had **no UPDATE policy at all**, so every update was
  refused: migration 031's sub-folder move never worked in production. Fixed
  with two narrow SECURITY DEFINER functions rather than a policy, because an
  RLS UPDATE policy cannot restrict WHICH column.
- **070** — 068's storage policies could never have worked: a policy's subquery
  is itself subject to RLS on the table it reads. Re-emitted against the
  owner-run views.
- **071** — 065 clobbered 060's internal approvals register by reusing its view
  name. The founder's Approvals screen had been blind since 065 was applied.
  Restored as `v_approval_register`.
- **074** — the Photos tab only knew about site-log photos, so images shared
  from the vault's Photos folder landed in Documents. Now one gallery over both
  routes, each row carrying its own bucket.

### Client messages, both sides (072)
`/tasks/messages` — the thread and a reply box, founder/PM write, supervisor
reads. Marking read happens when a human OPENS the thread, not on a button.
No read receipt for the client, on purpose: "read ✓✓" followed by a week of
silence is worse than showing nothing.

### "From your client" (073)
A dashboard strip above the compliance and expiry alerts, because a person
waiting on an answer outranks a date on a calendar. Four derived signals —
unread messages, changes requested, new approvals, approvals aging on the
client — and **no stored "important" flag**: a flag true for everything is a
permanent badge, and a permanent badge is one people stop seeing. Urgent only
for a change request. Clears itself when somebody opens the register or thread.

### Still open
- **Client sets their own password.** Today the founder types one and tells
  them, so the firm knows the client's password and there is no recovery.
  Supabase Auth has `inviteUserByEmail` and `resetPasswordForEmail`; both need
  SMTP configured on the project first — a decision, not a code change.
- **Timeline and milestones on the client home.** `v_client_progress` already
  carries planned/actual dates; the screen does not render them yet.
- The approvals form still asks "How they said it" at creation, which was
  written before the portal existed and has no honest answer when you are
  ASKING rather than recording.

## CLIENT ADMINISTRATION (2026-08-29, migration 067)

`/admin/clients` — the founder grants and revokes portal access without the SQL
editor. Third tab alongside Projects and Team, deliberately separate from Team.

- `v_client_roster` leads with EXPOSURE per client: documents shared, photos
  published, bills visible, approvals pending, unread messages. Owner-run, the
  WHERE clause is the access control, carries no money.
- **Suspend** (reversible, the handover case) and **Remove access** (deletes the
  link, deactivates, keeps the profile) are separate buttons. One "remove" would
  hide which happened.
- `admin-create-user` gained a `client` branch — it could not create a client at
  all before, which is why the first account was made by hand in SQL. It writes
  auth user + profile + `client_projects` together and deletes the user if the
  link fails, so a half-created client cannot exist.
- Not built, on purpose: no "view as client" (needs a client session, i.e. an
  impersonation path) and no permission-toggle grid (the curated views ARE the
  permission model).

**Still to do:** run migration 067 and `supabase functions deploy
admin-create-user`, then re-run `client-security-sweep.js` as the test client —
it now covers `v_client_roster` and all five new functions and must stay at 0
failures.

## CLIENT SECURITY — VERIFIED END TO END (2026-08-29, migration 066)

The client portal data layer (065) is now proven against a real signed-in client,
not just reasoned about.

**What was run.** `client-security-sweep.js` pasted into the browser console as
`testclient@yourmasons.test`: **147 surfaces** — 70 RLS tables, 36 internal views
and 39 read-only RPCs, every project-scoped one called with the client's OWN
project id, which is the single id a client legitimately knows.

**First result: 18 of 147 returned a row.** Every figure in every one of them was
`0` or `null` — nothing leaked, `is_member()` did its job — but that IS the
failure this repo has been bitten by twice before (056, 064): an aggregate over
zero permitted rows answers `0` rather than nothing. The portal has no UI yet, so
the first screen built against `fn_project_evm` would have rendered "₹0 spent" on
a ₹4 crore job.

**Migration 066 closes all 18** with one uniform line —
`select * from ( <the aggregate> ) q where public.is_internal();` — across fifteen
functions, plus `v_portfolio_summary` rebuilt, `assistant_usage`'s select policy
tightened, `fn_assistant_quota` made to raise for a client, and
`fn_schedule_template` renamed to `_rows` and revoked behind a filtered wrapper
(it was `immutable`, so no RLS ever applied and it handed out 120 rows of the
firm's build sequence).

**Verified twice.** On a real PostgreSQL with the ACTUAL 001-065 chain as
fixtures (not stubs — the 056 lesson): three clean runs, founder and supervisor
unchanged, all sixteen surfaces zero for a client, quota refused, no
`assistant_usage` row created. Then live: **147/147 refused or empty.**

**Also done by hand:** the defence-in-depth test — a client deliberately inserted
into `project_members`, sweep re-run, every count still 0, row removed. That is
the one that matters in three years.

**Known and deliberate:** open-book spend plus contract value still lets a client
derive margin by subtraction, while the brief says never show margin. Both cannot
hold. Stated in 065's header and §6 of CLIENT_SECURITY_TEST.md; the one-line fix
is named there. A commercial decision, not an engineering one.

**Tools now in the repo:** `client-security-sweep.js` (the exhaustive one — use
this), `client-security-test.js` (the older 49-check version),
`CLIENT_SECURITY_TEST.md` (the manual/SQL routes plus §1i by hand). All three
need `npm run dev`; `window.supabase` is stripped from production builds.

## Done (migrations 001–018 ALL APPLIED — confirmed 2026-07-25)
- [x] Day 1: Foundation — auth, roles/RLS, app shell, Dashboard
- [x] Day 2: Open Book — expenses, budgets, receipts, budget-vs-actual
- [x] Day 3: Tasks + rollover + Daily Site Log; Materials (inward/issue/stock)
- [x] Day 4: Document Vault; migrations 004–006 (filtered totals, project-scoped rollover, storage RLS, rate privacy)
- [x] Security: supervisor RLS test PASSED (money + confidential docs hidden)
- [x] UI: premium design system applied to Dashboard + Project Detail
- [x] Project Detail drill-down navigation

## DESIGN-SYSTEM ROLLOUT COMPLETE (2026-07-25)
The paused rollout is done. **Visual/interaction layer only — no query, RLS or money-math changes.**
All 13 remaining screens + the 4 layout shells now match Dashboard/Project Detail.

- **Inline error banners → sonner toasts.** Every `{error && <p role="alert">}` block removed across
  Money, Tasks, Materials, Docs (and the 4 layouts, where a project-load failure now toasts). All
  failures route through `errText()` so Supabase errors show their real message instead of a generic
  line — the bug that masked three separate issues during procurement testing.
- **"Loading…" text → skeletons.** `ListSkeleton` on Ledger, BudgetVsActual, TaskList, StockRegister,
  MaterialMaster, FolderView, and all 4 layout shells.
- **Bare empty text → `EmptyState`** with icon, friendly line and a primary action: Ledger ("Add your
  first expense"), TaskList ("Add a task"), MaterialMaster ("Add your first material"). Filtered-empty
  states stay as plain text — a filter returning nothing isn't an empty state, it's a non-match.
- **Surfaces →`.paper`** (warm border, soft layered shadow, 20px padding) replacing
  `rounded-xl border border-border`; money figures → `.figure` (Fraunces, tabular-nums).
- **Staggered reveal** on the Ledger and Task lists, matching the Dashboard entrance.
- Validation messages that were inline errors are now toasts too (e.g. "Pick a category", "Work area
  is required"), and IssueForm's insufficient-stock message became a two-line toast with the
  available quantity.
- Structural fix: list items that moved inside `Stagger`/`RevealItem` wrappers changed `<li>` → `<div>`
  to keep the markup valid.
- `tsc -b --force` clean.

## CONSOLIDATION AUDIT (2026-07-23)
Verified four invariants. Two gaps found → **migration 018 written, NOT applied**.

- [x] **Money reconciles from one server-side source.** ✅ Grepped all of `src/` for money
      arithmetic: the only client-side math is bar-width ratios (`format.ts` spendRatio/barGeometry,
      never rendered as currency) and the PO PDF's print-time subtotal/GST roll-up (documented, not
      stored). Every figure traces to `v_project_spend`, `v_portfolio_summary`, `v_budget_vs_actual`,
      `v_project_contract`, `v_po_value`, `v_po_match`, `v_stock`, or `fn_expense_total`.
- [x] **Supervisor RLS hides money at API level (A1–A5).** ✅ `expenses`, `budgets`, `vendors`,
      `po_invoices`, `invoice_lines`, `variation_orders` all carry a role check in their SELECT
      policy. `po_lines` and `material_inward` are readable by members but their rate columns are
      revoked at column level (006/012) and served via gated views — verified correct.
- [~] **Audit trigger on every financial/material table — 6 WERE MISSING.** Fixed in 018:
      `po_lines` (rate, line_total), `invoice_lines` (rate_invoiced), `grn_lines` (qty → stock),
      `petty_cash_accounts` (imprest), `vendors` (payee master), `materials`. Previously a rate on
      an approved PO could be edited with no trail.
- [~] **`material_inward.vendor_name` was unreadable by anyone.** 006 revoked select + granted
      explicit columns; 017 added `vendor_name`, which wasn't in that grant. Fixed in 018 (granted +
      added to both material_inward views).
- [x] ~~Design-system rollout outstanding on Money / Tasks / Materials / Docs~~ — **DONE 2026-07-25,
      see the rollout section above.** Every screen in the app now uses toasts, skeletons and empty
      states.
- **Run migration 018 before testing.**

## GROUP A
- [x] **Flexible vendor entry everywhere** — **migration 017 written, NOT yet applied**
      (appended to `APPLY_pending.sql`). Every vendor reference now keeps an optional `vendor_id`
      link PLUS a free-text `vendor_name`:
      - Columns added to `expenses`, `purchase_orders`, `material_inward` (po_invoices derives from
        the PO; `fn_post_invoice` updated to copy the PO's `vendor_name` onto the posted expense).
      - **`VendorField`** (`src/components/VendorField.tsx`) — reusable typeahead. Type to search
        registered vendors; pick one → id + registered name; type an unknown name → free text, id
        null; one-tap **"Save to vendor list"** registers it and back-links past records
        (`fn_register_vendor`). Replaces the old button-based `VendorPicker` (deleted). Wired into
        the Expense form, PR raise, PO approve, and Materials inward.
      - **Unregistered indicator** — a small amber dot next to free-text vendors in the ledger and
        on PO cards.
      - **Vendors screen → "Unregistered vendors"** section: distinct free-text names in use
        (`v_unregistered_vendors`, money-gated), each with **"Add to vendor list"** (registers +
        back-links via the same fn). Design system throughout (toasts, skeleton, empty states).
      - Spend-by-vendor display coalesces registered-name-else-free-text everywhere it shows.
      - **Run migration 017 before testing.**

- [x] **A5 Variation Orders (Module 26)** — **migration 016 written, NOT yet applied**
      (appended to `APPLY_pending.sql`). `variation_orders` table, money-gated RLS (founder/pm/accounts
      read; pm/founder raise; founder approve/reject; supervisors see NOTHING — whole table is money,
      so row-level RLS suffices, no column tricks). Audit trigger. `+/- cost_impact` (add or omit).
      - **`v_project_contract`** (owner-run, money-roles) computes original + approved variations =
        **revised contract value** — server-side, never in the browser.
      - **Variations screen** (`src/pages/money/Variations.tsx`) under Money tab: contract summary
        (original / approved VOs / revised / pending), raise form (title, description, +Add/−Omit
        toggle + amount), approve/reject (founder), per-VO status pill.
      - **VO PDF** (`src/lib/voPdf.ts`) on letterhead — VO number, description, cost impact,
        before/after contract value, client-acceptance + signatory lines. Download or File to Docs
        (Contracts folder, confidential).
      - **Project Detail header** now shows "Revised contract" with the original ± VOs breakdown when
        approved variations exist; plain "Contract" otherwise.
      - **Run migration 016 before testing.**

- [~] **A3 Procurement (Module 22) — PART 1 of 2.** **Migration 012 written, NOT applied**
      (appended to `APPLY_pending.sql`). Full backend now exists:
      - `purchase_orders` (carries the PR→PO lifecycle: starts 'requested', becomes 'approved'
        when rates are set), `po_lines` (qty + rate, `line_total` generated), `goods_receipts`
        + `grn_lines`, `po_invoices` + `invoice_lines`.
      - **GRN → stock**: `fn_grn_to_inward` trigger posts a `material_inward` row per GRN line
        (single source of truth for stock), carrying the PO rate, security-definer so a
        rate-blind receiver can still write it.
      - **3-way match view** `v_po_match`: ordered vs received vs invoiced per line, with
        `match_status` (ok / qty_variance / rate_variance / both / pending), tolerances qty 0.5 /
        rate 2%. `v_po_totals` for PO value.
      - **Invoice → Open Book**: `fn_post_invoice` (founder/accounts only) approves an invoice and
        writes ONE expense row for the net, so procured cost hits the ledger + budgets. Money math
        server-side throughout (generated columns + views + fn).
      - **Rate privacy**: `po_lines.rate`/`line_total` revoked from `authenticated`; served via
        `v_po_lines_rated` gated to founder/pm/accounts. Supervisors see quantities only. Same
        pattern as 006/010.
      - RLS across all 6 tables; audit triggers on PO / GRN / invoice.
      - **Built this turn (Part 1):** raise request (qty-only, supervisor-friendly) +
        Orders list + inline approve-with-rates. Reachable from **both** the Materials tab
        (supervisors: /materials/orders) and the Money tab (money-roles: /money/orders) — the same
        `Orders` screen adapts by role, since supervisors have no Money tab and accounts no
        Materials tab.
      - **Migration 013 (fix):** 012 left `v_po_totals` and `v_po_match` as security_invoker reading
        the revoked `line_total`/`rate`, so the PO value never showed (all users share the
        `authenticated` role). Split: `v_po_totals` = counts only (security_invoker); `v_po_value` =
        ordered value, owner-run + gated to founder/pm/accounts; `v_po_match` rebuilt owner-run +
        gated. Query reads counts from the first, value from the second only for money-roles.
        Also added vendor selection to the approve step (a supervisor-raised request has no vendor).
      - **PO PDF** (`src/lib/poPdf.ts`, jsPDF client-side per stack rule) — on an approved PO,
        money-roles get a "Download PO" control with a GST% selector. Renders company letterhead
        (`src/lib/company.ts` — **placeholders to fill with real GSTIN/address**), vendor block with
        GSTIN, deliver-to (project + site address), line table, subtotal / GST / grand total,
        authorised-signatory footer. Line amounts are the Postgres `line_total`; subtotal/GST/total
        are a print-time roll-up for the document only (not stored — the invoice is the authoritative
        cost record). Warns via toast while company.ts still has placeholders.
      - **PO auto-filed to Docs** (migration 014): approving a PO files **two** copies to the vault's
        new **Purchase Orders** folder, both linked via `documents.po_id` and both showing the PO's
        **live status** pill (joined from `purchase_orders.status`, so it tracks requested → approved
        → receiving → received):
          1. **Full priced PO** — has rates/amounts/totals, `is_confidential=true`, so only
             founder/pm/accounts see it (and storage RLS 006 blocks the object for supervisors).
          2. **Delivery copy** — title "DELIVERY ORDER", quantities only, no rates/amounts/totals,
             `is_confidential=false`, so the **supervisor can open it and chase the vendor for
             delivery**. This is the fix for "PO not visible to supervisor for follow-up" while
             keeping the money-hiding rule intact.
        `poPdf.ts` gained a `variant: 'full' | 'delivery'` switch. Archive failure never blocks the
        approval. Migration 014 also adds `'purchase_orders'` to the `doc_folder` enum.
      - **A3 PART 2 built (migration 015):**
        - **GRN receipt** (`ReceiveForm.tsx`) — on an approved/receiving PO, founder/pm/supervisor
          record what arrived per line (ordered vs already-received vs outstanding). Saves via
          `fn_receive_goods` (migration 015, security-definer so supervisors can receive AND flip the
          PO status, which po_update otherwise reserves to founder/pm). Inserting grn_lines fires the
          012 trigger → `material_inward`, so **stock updates automatically**. Over-receipt warns but
          doesn't block. Status advances receiving → received when every line is fully received.
        - **Invoice + 3-way match** (`InvoiceMatch.tsx`, money-roles) — enter the vendor invoice
          (qty + rate per line, GST), then `v_po_match` shows ordered/received/invoiced with a
          per-line status pill (Matched / Qty variance / Rate variance / both, tolerances 0.5 qty /
          2% rate). "Post to Open Book" (founder/accounts) calls `fn_post_invoice` → writes one
          expense row → ledger + budgets. Variance warns before posting but posting overrides
          (the approved flag).
        - Both surfaces live inside the expanded PO card on the Orders screen, shown by status + role.
        - **A3 is now complete end to end.** Migration 015 appended to APPLY_pending.sql.
- [x] **A2 Safety (Module 04)** — **migration 011 written, NOT yet applied** (append is in
      `APPLY_pending.sql`). Tables: `safety_checklists` (one per project per day),
      `safety_checklist_items`, `incidents`. RLS mirrors tasks (members read; founder/pm/supervisor
      write; accounts read-only; incident close by founder/pm or raiser). Audit triggers on the two
      header tables. `fn_safety_summary(project)` returns days-since-incident, open count, and this
      week's checklist days — dates in Asia/Kolkata, security_invoker so RLS applies.
      - **Daily checklist** (`src/pages/tasks/SafetyChecklist.tsx`) under the Tasks tab — reuses the
        header date picker (checklist is per-day). 6 standard items, Pass/Fail/NA big buttons, remark +
        optional photo each. Upsert on (project_id, check_date) then items on (checklist_id, item_key).
      - **Incidents** (`src/pages/tasks/Incidents.tsx`) — list newest-first + inline raise form
        (type, datetime, description, people, immediate action, multiple photos), open/close toggle.
      - **Safety card on Project Detail** — days incident-free, checklist-this-week %, open count.
      - Photos reuse the `site-photos` bucket, so migration 006's storage policies already cover them.
      - Design system throughout: toasts on every save/close, ListSkeleton, EmptyState, staggered reveal.
      - **Note:** the Tasks header date picker also shows on the Incidents sub-route, where it's inert
        (incidents carry their own datetime). Acceptable; flag if it reads oddly.
- [x] **A1 Vendor Management** — upgraded to the full design system. `Vendors.tsx`
      now has search (name/category/phone/GSTIN), a brass primary "Add vendor",
      sonner toasts on every add/edit/deactivate/restore (no more inline
      banners), `ListSkeleton` while loading, an `EmptyState` with a primary
      action, and a staggered reveal on the list. `VendorForm` toasts on save
      failure (keeps inline validation for the empty-name case); the
      `VendorPicker` inline-add on the expense form toasts "added and selected".
      Functionality (list/add/edit/deactivate + inline add) was already built in
      the Vendors session; this pass brought it up to the design standard.
      Deactivate stays a soft delete (FK-safe), founder/pm/accounts only.

## PHASE 0 (earlier session)
- [x] PWA: `public/manifest.webmanifest`, brass-monogram icons (192/512/maskable/apple-touch), meta tags
- [x] Service worker `public/sw.js` — hand-written, no Workbox. Network-first navigations with cached
      shell fallback; cache-first for hashed `/assets/*`. **All cross-origin requests pass straight
      through**, i.e. every Supabase call — caching REST would serve stale money figures and caching
      storage would keep signed URLs alive past expiry. Installable shell, NOT offline mode.
      Registered from `src/lib/registerSW.ts`, production only.
- [x] `public/_redirects` — SPA fallback (without it, refreshing `/project/<id>` 404s on Pages)
- [x] `public/_headers` — `no-store` on `/sw.js`, 1-year immutable on `/assets/*`
- [x] `.github/workflows/supabase-keepalive.yml` — daily REST ping (free tier pauses after 7 days idle)
- [x] `.github/workflows/supabase-backup.yml` — weekly `pg_dump` in `postgres:17-alpine`, gzipped,
      90-day artifact. Artifact not a committed `backups/` folder: dumps hold every expense and vendor
      phone number, and git history is permanent and in every clone.
- [x] `DEPLOY.md` — Cloudflare Pages setup, env vars, auth redirect URLs, GitHub secrets, restore steps.
      Includes the IPv6 gotcha: `SUPABASE_DB_URL` must be the **Session pooler** URI — the direct host
      is IPv6-only and GitHub runners are IPv4-only.
- [ ] Re-run supervisor incognito RLS test on Project Detail (money + contract value hidden)

- [x] **Production build verified on Windows** — builds in ~1.7s, `vite preview` serves it.
      The earlier "bundle has no app code" finding was specific to the Cowork Linux sandbox and does
      NOT reproduce on Windows. Tell: the sandbox bundle was 441KB with no chunk-size warning; the
      real build exceeds Vite's 500KB threshold and warns, which is the app code being present.
      No action needed. (If a chunk-size warning ever matters, the fix is route-level `lazy()`
      splitting — not urgent for ~15 internal users on a fast connection.)

- [x] Pushed to GitHub — `github.com/bhaibha/masonos`, private, `main`
- [x] `.gitattributes` added (LF normalisation; CRLF in `.yml` breaks Actions runners)
- [x] `.gitignore` hardened with `.env` / `.env.*` — `*.local` alone missed `.env.local.txt`

## Next (see ROADMAP.md)
- [x] Repo connected to Cloudflare — landed in the **Workers** flow, not Pages
- [x] First deploy failed on `_redirects` ("infinite loop"); fixed by deleting
      `public/_redirects` and adding `wrangler.jsonc` with
      `assets.not_found_handling: single-page-application` (the Workers-native
      SPA fallback). Re-push to redeploy.
- [x] **LIVE and login working** — masonos.muhamdwaseem.workers.dev
- [x] Env delivered via committed `.env` (public anon key + URL — safe to commit,
      ships in the bundle anyway; `.env.local` stays gitignored)
- [x] `src/lib/supabase.ts` normalises the URL — strips a trailing `/rest/v1`,
      `/auth/v1` etc. and any trailing slash. The Project URL had `/rest/v1/` on
      it, which doubled every request path → "Invalid path specified in request
      URL". Now bulletproof regardless of where the value is set.
- [x] **Migration 010 written** (`supabase/migrations/010_project_commercials_privacy.sql`)
      + coordinated frontend change — closes the last UI-only money gap.
      - SQL: `revoke select on projects from authenticated`, re-grant the safe
        columns (id/name/client_name/site_address/status/dates/created_at), and
        expose `contract_value` / `management_fee_pct` / `management_fee_amount`
        through owner-run `v_project_commercials`, whose WHERE clause is the
        access control (is_member AND founder/pm/accounts). Same shape as 006.
      - Frontend: `fetchProjects` / `fetchProject` now select ONLY safe columns
        (requesting the revoked ones would 400 for everyone since all app users
        share the `authenticated` role). New `fetchProjectCommercials()` reads
        the gated view, called only for money-roles; ProjectDetail passes the
        result to the header. Order-independent: the fetch falls back to a
        direct table read before 010 is applied, so nothing breaks in the gap
        between deploying code and running the migration.
      - Appended to `supabase/APPLY_pending.sql` (now 004–010).
      - Caveat recorded in the migration: a future project-edit screen must use
        `Prefer: return=minimal` on UPDATE, or PostgREST re-SELECTs the revoked
        columns and 400s.
- Deploy gotchas hit and recorded (see Known bugs): Workers not Pages flow;
  `_redirects` catch-all invalid on Workers (use wrangler `not_found_handling`);
  Cloudflare dashboard build vars override committed `.env`; service worker
  caches old bundle → hard-refresh after deploy.
- [x] **GitHub Actions live and green** — `supabase-keepalive.yml` (daily REST
      ping) and `supabase-backup.yml` (weekly `pg_dump` → `postgres:17-alpine`
      → gzipped 90-day artifact). 3 secrets added; both ran green by hand.
      `SUPABASE_DB_URL` = Session pooler URI (IPv4; Direct is IPv6-only).
- [ ] Set Supabase Site URL / redirect URLs to the Pages domain
- [ ] Re-run supervisor incognito RLS test on Project Detail
- [ ] Roll design system across remaining tabs (Money/Tasks/Materials/Docs)
- [ ] GROUP A → A1 Vendors screen

## Known bugs / notes
- **Migrations 007, 008, 009 are written but NOT applied** — 007 adds `remaining`/`pct_used` to
  `v_project_spend`, 008 adds the `management_fee_amount` generated column, 009 adds
  `v_portfolio_summary` for the all-projects roll-up. Run 007 before 009 (009 depends on it).
  Queries fall back gracefully, so those figures stay hidden until applied.
- A1 Vendors screen is in fact BUILT (`src/pages/money/Vendors.tsx` + inline add on the expense form) —
  ROADMAP line is stale.
- Projects added via SQL currently; admin screen parked
- "View ledger/tasks/stock/documents" buttons verified: `ProjectDetail` calls `select(id)` on mount and
  each layout keeps a still-valid selection, so the tabs open already scoped
- ~~`projects` commercial columns readable by supervisors~~ — **closed by migration 010, APPLIED.**
  No UI-only money gaps remain.
- **Migrations 004–010 are all APPLIED to production** (via APPLY_pending.sql). Delta lines,
  portfolio roll-up, scoped rollover, storage RLS, rate + commercial privacy all live.
- 006 made idempotent (drop-policy-if-exists before each create) so the batch re-runs cleanly.

---

## Session — Admin module (founder-only): projects + users

**Built**

- [x] **Migration 019** `019_admin_designations.sql` — the only SQL this module needs.
      - `profiles.designation text` — a **display-only** job title.
      - audit trigger on `profiles` (role changes decide who sees money, so the
        table belongs in the log alongside vendors/materials from 018).
      - `profiles_admin_delete` policy (founder-only DELETE).
      - **No policy rewrite anywhere.** `projects_write`, `members_write` and
        `profiles_admin` in 001_core.sql already gate INSERT/UPDATE/DELETE to
        `is_founder()`, so creating projects and assigning members needed
        no new RLS at all — only UI. This is why the module carries near-zero
        risk of widening money access.
- [x] **Job title → access role mapping lives in TypeScript**, not the database.
      `DESIGNATIONS` in `src/lib/types.ts` maps each title (Site Engineer,
      Planning Engineer, Billing Engineer, Project Lead, Quantity Surveyor,
      Safety Officer, Store Keeper…) to one of the four enum roles. Adding a
      title is a TS-only change that cannot affect a single policy. Never make
      `designation` load-bearing in SQL.
- [x] **`admin-create-user` Edge Function** (`supabase/functions/admin-create-user/`)
      — the service-role key lives here and only here (CLAUDE.md rule 1).
      Verifies the caller's JWT, reads their profile *through an anon client so
      RLS applies*, and refuses anyone who isn't `founder` **before** the
      service-role client is constructed. Creates the auth user, updates the
      profile row the `handle_new_user` trigger already inserted, and upserts
      project_members. Rolls back the auth user if the profile update fails, so
      a half-created login can't be left behind.
- [x] **`/admin` (founder-only)** — `RequireRole allow={ADMIN_ROLES}`:
      - **Projects tab**: create + edit projects, incl. contract value and
        management fee %. Reads existing commercials back through the gated
        `v_project_commercials` view.
      - **Team tab**: add a person (name, job title, access level, email,
        temporary password, phone, project assignments); edit anyone's title,
        role, phone and assignments; deactivate/reactivate. Every access level
        shows a plain-English note of exactly what it grants, so the founder
        can see that "Site Engineer" means money is hidden.
      - Project assignment is a chip toggle writing `project_members` —
        the table every `is_member()` check reads.
- [x] Dashboard: founder-only **Manage** link beside "By project", and the empty
      state now offers "New project" to founders instead of a dead end.

**Deliberate decisions**

- Access is still the 4-role enum. A fifth role would have meant auditing every
  policy across 18 migrations for a purely cosmetic gain.
- `createProject`/`updateProject` select only 010-granted columns on the way
  back. PostgREST's default `return=representation` re-SELECTs every column
  after a write, which would hit 010's revoke on `contract_value` and 400 —
  the caveat recorded in migration 010 has now been honoured.
- `fetchMyProfile` requests `designation` and silently retries without it, so
  sign-in keeps working in the window between deploying code and running 019.

**Pending**

- [ ] Deploy the Edge Function: `supabase functions deploy admin-create-user`
      (until then, "Add person" fails; editing existing people works fine).
- [ ] Re-run the supervisor incognito test after 019 — expected unchanged, since
      no read policy moved.
- [ ] ROADMAP Group A: A6 Site Instructions, A7 RFI, A8 Snags + DLP,
      A9 Compliance calendar, A10–A13.
- [ ] Orphaned storage objects from before the data clear (receipts / site-photos
      / PO PDFs) — clear via the Supabase dashboard if wanted.

**Run migration 019 before testing.**

---

## Session — Record removal & reversal, part 1: void/reverse (migration 020)

Scope agreed up front: this session does the **correctness-critical half** — the full backend
(every column, every view and RPC rewrite) plus the void UI for money and stock. Hard delete and
cancel/reject are migration 021, next session.

**Built**

- [x] **Migration 020** `020_void_and_reverse.sql` — the whole void backend in one atomic file.
      - `voided_at` / `voided_by` / `void_reason` on **expenses, petty_cash_entries,
        material_inward, material_issues, goods_receipts, po_invoices**.
      - A CHECK constraint per table makes the reason a **database** rule: all three columns are
        null, or all three are set with a non-blank reason. The form can't be the only guard.
      - Partial indexes on `(… ) where voided_at is null` — every hot query now carries that filter.
- [x] **Two back-links added, because the cascade had nothing to follow.** This was a real hole:
      - `material_inward.grn_line_id` — `fn_grn_to_inward` used to write inward rows tagged only
        with the remark 'Auto from GRN'. There was **no way to reverse a goods receipt's own stock**.
      - `expenses.pc_entry_id` — `fn_pc_to_expense` mirrored petty-cash spends into the ledger with
        no link back, so voiding a petty cash entry would have left a **ghost expense** still
        counting against the budget.
      Both trigger functions now set the link. Nothing to back-fill (transaction data was cleared
      before real entry began) — noted in the migration.
- [x] **`fn_void_record(p_table, p_id, p_reason)`** — SECURITY DEFINER, and the *only* path to a
      void. Checks the role (money = founder/accounts, stock = founder/pm), refuses a blank reason,
      cascades, and logs. **No UPDATE policy on `voided_at` was added on purpose**, so the client
      physically cannot flip the flag itself.
      Guards it enforces, each with a message the UI shows verbatim:
      - voiding a delivery that a GRN created → "void the goods receipt instead"
      - voiding an expense a petty-cash entry created → "void the petty cash entry instead"
      - voiding an expense a vendor invoice posted → "void the invoice instead"
      - voiding stock that's already been issued → blocked, names the materials
      - voiding a GRN when an invoice is already posted → blocked, "void the invoice first"
      Cascades: GRN void → its inward rows + PO status walked back to what the *remaining live*
      receipts justify; petty cash void → the mirrored expense; invoice void → the posted expense.
- [x] **`fn_stock_on_hand(project, material)`** — one definition of live stock, used by both the
      void guard and `fn_check_stock`, so the two can never disagree.
- [x] **Every server-side total rewritten to exclude voided rows** — this is the part that makes
      voiding *mean* something (CLAUDE.md rule 2: the browser never filters money):
      `v_project_spend` (→ `v_portfolio_summary` via cascade) · `v_budget_vs_actual` ·
      `v_petty_cash_balance` · `v_stock` · `v_po_match` · `v_material_inward` ·
      `v_material_inward_rates` · `fn_expense_total` · `fn_check_stock` · `fn_receive_goods` ·
      `fn_post_invoice`.
- [x] **UI** — shared `VoidDialog` (danger-coloured, mandatory reason, states the consequence,
      Escape to close), `VoidBadge`, `voidRowClass` (dimmed + struck through), `VoidNote`
      ("Voided by X on date — reason"). Wired into:
      - **Ledger** — void an expense; the total above it comes from `fn_expense_total`, so it drops
        the moment the void lands.
      - **Materials → Movements** (new screen) — every delivery and issue for the project, newest
        first, filterable. Reads the rate-free `v_material_inward`, so supervisors can review it
        even though they can't void.
      - **Orders → invoice/match panel** — goods receipts are now listed (they never were) and can
        be voided there, which is the only correct place since voiding the GRN is what reverses its
        stock. Invoices can be voided posted or unposted.

**Deliberate decisions**

- Voiding is RPC-only. Adding an UPDATE policy would have been less code and a much bigger hole.
- Voided rows stay in lists rather than disappearing — that's the point of a reversal over a delete.
- `v_petty_cash_balance` filters voided entries in the **JOIN**, not the WHERE: in the WHERE, an
  account whose only entries were voided would vanish from the list entirely.
- The GRN stock guard aggregates per material before comparing. Checking row-by-row would pass two
  lines of the same material individually while the combined reversal still went negative.

**Verification**

- Migration parsed against the real PostgreSQL grammar (`pglast`/libpg_query): outer SQL clean,
  `fn_void_record` plpgsql body clean. Three trigger functions report a parser JSONDecodeError —
  **the same three fail identically in the already-applied 002/003/012**, so it's a pglast quirk,
  not a defect.
- No `create or replace view` anywhere in 020 — every view is drop-then-create (the rule that had
  been broken three times).
- All eight recreated views explicitly re-granted; `DROP VIEW` discards privileges.
- `tsc --noEmit` clean.

- [x] **`CLEAR_transactions.sql` delete order fixed** — the two new FKs broke it. `material_inward`
      must now precede `grn_lines`, and `expenses` must precede `petty_cash_entries`. The old order
      would have failed halfway.

**Pending / next session (migration 021)**

- [ ] Hard delete (founder/PM, confirm, blocked-if-referenced) for draft PRs, tasks, unsubmitted
      safety entries, documents, unused vendors/materials.
- [ ] `cancelled`/`rejected` + reason on PO and VO, excluded from active lists and value/match.
      Cancelling a PO with a live GRN blocked — void the GRN first.
- [ ] **Petty cash has no screen** — the tables and the void path exist and work, but there's no UI
      to reach them from. Either build the screen or drop the module.
- [ ] Re-run the supervisor incognito test: supervisors must still see no money on Movements.

**Migration 020 APPLIED** — confirmed 2026-07-27; the verify SELECT returned `fn_void_record` and
`fn_stock_on_hand`, both of which sit near the end of the script, so every statement above them ran.

---

## Fix — records raised by a supervisor "missing" for the founder

**Not a data or RLS problem.** `is_member()` already returns true for founders on every project, so
a founder can read every PO, task and movement. The records were there the whole time; the founder
was looking at a different project, and the UI gave no clue.

Three causes, all fixed:

- [x] **The selected project was stored under one shared localStorage key.** Signing out of one
      account and into another on the same browser inherited the previous person's selection. Now
      namespaced per user id (`masonos.selectedProjectId.<uid>`), with a one-time carry-over from
      the old shared key so nobody's choice resets.
- [x] **ProjectPicker rendered NOTHING when the user had a single project** — which is exactly the
      supervisor's case. They had no way to see which project they were logging against. The active
      project is now always named; only the ability to *change* it depends on having more than one.
- [x] **Empty lists were ambiguous.** "Nothing was raised" and "you're on the wrong project" looked
      identical. Added `OtherProjectsHint` under the empty states on Orders, Tasks and Movements:
      "Showing <Project> only. You have N projects — switch with the picker above."

Also: the store now tracks `autoSelected`, set when a stored selection is no longer valid and it
falls back to the first project — available for a future "we switched you" notice.

`tsc --noEmit` clean.

---

## Session — Record removal, part 2: cancel/reject + supervisor self-void (migration 021)

**The hole this closes.** An approved VO immediately moves `revised_contract_value` through
`v_project_contract`, and there was **no way back**: `vo_status` was submitted/approved/rejected,
and 'rejected' is only reachable while still submitted. A VO approved by mistake permanently
inflated the contract figure — on the one number that defines the job. Purchase orders had the same
shape of hole: an approved PO couldn't be cancelled.

**Built**

- [x] **Migration 021** `021_cancel_and_supervisor_void.sql`
      - `cancelled` added to `vo_status` (po_status already had it from 012).
      - `cancelled_at` / `cancelled_by` / `cancel_reason` on `purchase_orders` and
        `variation_orders`, with a CHECK: **status = 'cancelled' ⇒ all three present and the reason
        non-blank**. Scoped to cancelled rows, so existing rows can't violate it.
      - **Why the CHECK matters and the RPC alone didn't:** `purchase_orders` has a client-writable
        UPDATE policy (`po_update`) and the app calls `setPoStatus()` directly. A client could have
        flipped status to 'cancelled' with no reason. The constraint makes that impossible —
        `cancelled_by` can only be stamped honestly by the SECURITY DEFINER function.
      - **`fn_cancel_document(p_table, p_id, p_reason)`** — role check (PO = founder/pm, VO =
        founder, mirroring who approves), mandatory reason, audit row. Refuses to cancel a PO that
        still has live goods receipts or vendor invoices, naming the count: *"void the receipt(s)
        first, then cancel the order."* Refuses a closed order.
      - **`fn_reject_variation(p_id, p_reason)`** — rejection was a bare status flip with no
        explanation; now the reason is recorded and shown on the card.
      - **Cancelled documents drop out of the numbers, server-side:** `v_project_contract` (which
        also now returns `cancelled_value`), `v_po_value`, `v_po_match`. `fn_receive_goods` and
        `fn_post_invoice` refuse to act on a cancelled order.
- [x] **Supervisor self-void** — `fn_void_record` now accepts a supervisor voiding a
      `material_inward` / `material_issues` row **they created**. Goods receipts stay founder/pm
      (voiding one reverses a whole delivery). Every 020 guard still applies: can't void consumed
      stock, can't void a GRN-created inward row.
      Scope chosen: **own entries, any date** — the literal reading of the instruction. The
      migration documents the one-line change to tighten it to same-day only.
- [x] **UI** — `VoidDialog` refactored into a shared `DestructiveDialog` shell so void, cancel and
      reject read identically and can't drift. New `CancelDialog`, `RejectVoDialog`,
      `CancelledBadge`, `CancelNote`. Wired into:
      - **Variations** — "Cancel variation" on approved VOs (founder), Reject-with-reason on
        submitted ones, and the reason shown on cancelled/rejected cards.
      - **Orders** — "Cancel order" on any non-closed PO (founder/pm); the PO document is hidden
        once cancelled; the reason shows on the collapsed card.
      - **Movements** — supervisors now see Void on their own entries. On someone else's they get
        *"Logged by someone else. Ask a PM or the founder to void it."* rather than a blank space,
        which previously read as "corrections are impossible".

**Verification**

- Parsed against the real PostgreSQL grammar (pglast/libpg_query): outer SQL clean, all five
  function bodies clean — including the two rewritten from 020.
- **Enum/transaction trap avoided:** `alter type … add value` commits the label, but Postgres
  refuses to USE it elsewhere in the same transaction, and the Supabase editor runs a script as one.
  Every comparison against 'cancelled' outside a function body is written `status::text = '…'`.
  Recorded in CLAUDE.md as a standing rule.
- No `create or replace view` — all four views drop-then-create, and all are re-granted.
- `tsc --noEmit` clean.

**Still pending**

- [ ] Hard delete (mechanism 1): draft PRs, tasks, unsubmitted safety entries, documents, unused
      vendors/materials — founder/PM, confirm dialog, blocked with an explanation if referenced.
- [ ] Petty cash still has no screen.
- [ ] Supervisor incognito re-test after 021.

**Run migration 021 before testing.**

---

## Session — Record removal, part 3: hard delete (migration 022)

Asked for "delete/cancel on everything in the founder section". Built as: **a removal action on
every record type, with the mechanism chosen by what the record affects.** Money and stock still
can't be hard-deleted — that's void — and the RPC now says so explicitly instead of the button
simply being absent.

**Starting state was worse than it looked.** RLS is default-deny, and there were DELETE policies on
only three things (documents, project_members, profiles). Tasks, site logs, safety entries,
incidents, materials, vendors: none could be removed at all.

**Built**

- [x] **Migration 022** `022_hard_delete.sql` — `fn_delete_record(p_table, p_id)`.
      Deletable, each reference-checked server-side:
      - `tasks` — refused if another task was rolled over from it (the rollover chain is history)
      - `site_logs`, `incidents`, `safety_checklists` (items cascade), `documents`
      - `purchase_orders` **only while status = 'requested'** — anything approved has a number a
        vendor may hold, so it's cancelled instead, and the error says so
      - `materials` — refused with a count if any delivery, issue or PO line uses it
      - `vendors` — refused with a count if any expense, delivery or PO references it
      - `budgets` (founder/accounts, matching `budgets_write`)
      Explicitly refused, with the right instruction rather than a generic error:
      expenses / petty cash / inward / issues / GRNs / invoices → *"void it instead"*;
      variation_orders → *"cancel it instead"*; projects → *"set it to Completed or On hold"*;
      profiles → *"deactivate them"*.
- [x] **No DELETE policies added.** RLS default-deny means the client cannot delete these tables
      directly; `fn_delete_record` is SECURITY DEFINER and is the only route. Same shape as
      `fn_void_record` and `fn_cancel_document`.
- [x] Audit triggers added on `incidents`, `safety_checklists` and `budgets` — they were newly
      deletable and a delete must leave a trail. Plus a `DELETE_HARD` audit row so deletions are
      greppable alongside `VOID` and `CANCEL`.
- [x] **UI** — shared `DeleteButton` + confirm (`src/components/DeleteAction.tsx`). No reason field,
      unlike void/cancel: nothing moved, so what matters is that it's deliberate. The RPC's refusal
      message is surfaced verbatim, because it tells the user what to do next. Wired into Tasks,
      Materials, Vendors, Incidents, Documents, and draft requests on Orders.

**Decisions taken (confirmed with the user)**

- **Projects: archive, don't delete.** Every table cascades on project_id — one click would destroy
  a whole job's history including its audit log.
- **Users: deactivate, don't delete.** Their name is on `created_by` / `raised_by` / `approved_by`.
- **Money/stock: still void only.** Deleting an expense destroys the audit trail on a figure someone
  will later have to explain, and GST invoices carry a statutory retention requirement in India.

**Verification**

- Parsed against the real PostgreSQL grammar (pglast/libpg_query): outer SQL and the function body
  both clean.
- Caught during review: the top-level role gate was founder/pm, which would have made the
  founder/accounts budgets branch unreachable. Split into a coarse gate plus per-branch rules, with
  the not-deletable branches left reachable by accounts so they get *"void it instead"* rather than
  a role refusal.
- `tsc --noEmit` clean.

**Still pending**

- [ ] Petty cash still has no screen.
- [ ] Supervisor incognito re-test after 021 + 022.
- [ ] Orphaned storage objects: deleting a document row removes the listing, not the file in the
      bucket. Worth a cleanup pass or a storage delete in the same call.

**Run migration 021 then 022 before testing** — `APPLY_pending.sql` contains both, in order.

---

## Session — Design-system sweep, second pass (2026-07-28)

Migrations confirmed at session start: **001–022 ALL APPLIED**, next = 023. This session touched
**no queries, RLS or money math** — visual/interaction layer only.

**Important: the 2026-07-25 rollout had already done most of this.** Audited first rather than
redoing it. What was actually still on old patterns was a smaller, specific set — mostly the forms,
plus components added after that rollout.

**Fixed**

- [x] **Inline error banners → toasts.** Two survivors: `VendorForm` (kept a banner *and* a toast —
      duplicate messaging, and its validation path only set the banner) and `DocumentList`
      ("Could not open this file"). VendorForm's catch also used `err instanceof Error`, which is
      false for Supabase errors, so the real message was being swallowed — now `errText`.
      `Login.tsx` deliberately keeps its inline banner: it sits outside the app shell and a sign-in
      failure should stay visible next to the field, not fade.
- [x] **"Loading…" → skeletons** on BudgetEditor, SiteLog, ReceiveForm. (Button busy labels and
      input placeholders left alone — those aren't loading states.)
- [x] **Empty states with a primary action** added to BudgetVsActual, StockRegister, FolderView —
      all three were bare centred text with an underlined link. Each now carries an icon, a real
      sentence and a button, plus `OtherProjectsHint`. Search-with-no-match stays plain text: a
      non-match isn't an empty state.
- [x] **Old card pattern `rounded-xl border border-border` → `.paper`**, now zero occurrences
      outside `Toaster` (intentional there). Covered Folders' folder tiles (which also gained
      hover-lift + focus ring to match Dashboard cards), MaterialMaster's add form, DocumentList's
      container, UploadForm's confidential box (flattened to `bg-secondary/50` — it had become a
      card inside a card).
- [x] **Forms onto `.paper`**: ExpenseForm, TaskForm, SiteLog, InwardForm, IssueForm, UploadForm,
      MaterialMaster's add form. They were bare `space-y-5` on the page background.
- [x] **Staggered fade-up** added to BudgetVsActual, StockRegister, MaterialMaster, Folders,
      DocumentList. Required converting `<li>` → `<div>`/`<RevealItem>` in those lists, since the
      wrapper isn't a `<ul>` any more.
- [x] **Touch targets fixed at the token, not per-button.** shadcn's defaults were h-8/h-7/h-9
      (32/28/36px) against CLAUDE.md's 48px minimum; 15 buttons rendered at 28px. Raised in
      `button.tsx`: default and sm → h-11, lg → h-12, icon/icon-lg → size-11, with padding nudged
      to match. Text sizes untouched, so nothing looks heavier — just tappable with gloves.

**Two things went wrong, both worth recording**

1. **A regex codemod mangled 13 files.** Matching `<Button ...>` with `[^>]*?>` stopped at the `>`
   inside `() =>`, producing `onClick={() = className="h-11"> setFoo()}`. Repaired, and the
   approach abandoned in favour of the one-line token change above — which is what should have been
   done first.
2. **`npx tsc --noEmit` NEVER CHECKED ANYTHING.** The root `tsconfig.json` has `"files": []` and
   only project references, so it compiles nothing and always exits 0. It reported "clean" on all
   13 mangled files. Every typecheck claimed in earlier sessions using that command was worthless.
   **The correct command is `npx tsc -b --force`**, which is what `package.json`'s build uses.
   Recorded as rule 10 in CLAUDE.md. Final state verified green under the real command.

**Not done / notes**

- oxlint and vite build can't run in the Linux sandbox (both ship Windows-only native bindings),
  so `npm run build` still needs running on the machine before deploy.
- Everything remains uncommitted — the live site is behind localhost.

---

## Session — A6 Site Instructions (Module 56), migration 023

Confirmed at start: **001–022 ALL APPLIED**, next = 023.

**Built**

- [x] **Migration 023** `023_site_instructions.sql` — `site_instructions` table, `si_status` enum
      (issued / acknowledged / complete / cancelled), `si_number_seq` → `SI-0001`.
      - Addressed-to uses the **flexible vendor pattern from 017**: optional `vendor_id` plus
        free-text `addressed_to`. A labour contractor usually isn't in the vendor master and
        forcing registration before issuing an instruction is friction nobody on a site accepts.
        A CHECK requires one of the two — an instruction with no recipient is meaningless.
      - Attachments are storage paths in the **site-photos** bucket, so every path starts
        `${projectId}/` and the existing storage RLS applies unchanged.
- [x] **The SI holds NO money, deliberately.** Cost is a boolean plus an optional FK to
      `variation_orders`. That's what lets `si_read` be plain `is_member(project_id)` with no role
      check — supervisors read every instruction on their project, because they're the ones acting
      on it, and there is no figure to hide. The rupee value stays on the VO, which is already
      money-gated. A supervisor sees "Carries a cost implication" and, because the VO fetch returns
      nothing for them, never the VO number or amount. **No column-level revoke needed.**
- [x] **Cancellation reuses 021's machinery** rather than inventing a fourth pattern:
      `fn_cancel_document` gains a `site_instructions` branch, so PO, VO and SI cancel through one
      function; a CHECK constraint makes the reason a database rule. Extra guard: an instruction
      already marked **complete cannot be cancelled** — the work was done, and cancelling would
      misrepresent the record.
      ROADMAP's note that A6 must ship with `cancelled` + reason from day one is satisfied.
- [x] **`fn_set_si_status`** for issued/acknowledged/complete — stamps `acknowledged_by/at` and
      `completed_at` in the same statement as the status, so the two can't drift the way two
      separate client updates would. Refuses to touch a cancelled instruction ("reissue instead").
- [x] **Not hard-deletable, by omission.** `site_instructions` has no DELETE policy and no branch
      in `fn_delete_record`, so RLS default-deny makes deletion impossible. Recorded in the
      migration so the absence reads as intent rather than oversight.
- [x] **`siPdf.ts`** — letterhead identical to the PO/VO templates (same margins, type scale, brass
      rule, signature block). Three-column meta strip (To / Work area / Required by), the
      instruction body, and a cost note that names the linked VO **without stating an amount**.
      A cancelled instruction prints a rotated **CANCELLED watermark at 14% opacity** — light enough
      that the document underneath stays legible, because a cancelled instruction is still a record
      of what was once instructed — plus the reason at full opacity above the signature block.
- [x] **Tasks → Instructions screen**: list with status pill, overdue flag against required-by,
      attachment thumbnails, acknowledge/complete actions, Download / File to Docs, and cancel via
      the shared dialog. Issue form with vendor typeahead, camera-first attachments (compressed),
      cost toggle that reveals a VO picker. Design system throughout — skeleton, empty state with
      primary action, `OtherProjectsHint`, staggered reveal, toasts on every action.
      Filed PDFs are **not** confidential, so supervisors can open them.

**Verification**

- Migration parsed against the real PostgreSQL grammar (pglast/libpg_query): outer SQL clean, both
  function bodies clean. No `create or replace view`.
- `si_status` is a brand-new type, so 021's "unsafe use of new value of enum type" trap does not
  apply — that only affects `ALTER TYPE … ADD VALUE`. Comparisons still use `::text` for consistency.
- **`npx tsc -b --force` clean** — the correct command per CLAUDE.md rule 10. It caught two real
  errors during this build (PostgREST's inferred type breaking on the embedded `vendors(name)` join,
  and `VendorValue`'s fields being `vendorId`/`vendorName` rather than `id`/`name`). The old
  `--noEmit` would have reported both as clean.

**Open question for you**

- **Who marks an instruction acknowledged?** Right now founder/PM do, because the spec said
  supervisors view only. In practice the site supervisor is the one who'd hear the contractor
  acknowledge it. If you want supervisors to be able to tick acknowledge (but nothing else), that's
  a small change to `fn_set_si_status` and `si_update`.

**Migration 023 APPLIED** — confirmed 2026-07-28.

**Follow-up, same day (no migration):**

- [x] **Open instructions now surface on the Tasks list.** An SI has no planned date and doesn't
      roll over, so it can't be merged into the day's tasks — but leaving it on its own tab meant a
      supervisor working through their day would never see it. `OpenInstructions` renders a strip
      above the day's work listing every instruction that is `issued` or `acknowledged`, on **every
      date**, because an open instruction is outstanding regardless of which day you're viewing. It
      disappears the moment the instruction is marked complete (or cancelled), and renders nothing
      at all when there are none. Overdue ones are counted in the header and flagged in red.
      Backed by `fetchOpenSis` — a lean query with no vendor join, issuer lookup or VO resolution,
      since this feeds a summary strip rather than the full screen. A failure there returns an empty
      list rather than throwing, so a problem with instructions can never take down the task list.
- [x] **`OtherProjectsHint` added to Variations and Incidents** — both were still showing a bare
      "nothing here" when the founder was simply on a different project than the PM. Third time this
      confusion has surfaced; these were the screens the earlier pass missed. Vendors is deliberately
      excluded (the vendor master is global, not project-scoped).

---

## Session — A4 Invoice Generator (Module 15), migration 024

Confirmed at start: **001–023 ALL APPLIED**, next = 024. A4 had been skipped — A5 and A6 were built
out of roadmap order — so this closes the gap.

**Built**

- [x] **Migration 024** `024_invoices.sql` — `invoices` + `invoice_items`, `invoice_type`
      (progress / management_fee / vendor_voucher), `invoice_status`, three number sequences
      (INV-P / INV-M / INV-V, a separate series per type as required).
- [x] **`fn_issue_invoice` derives every figure; nothing is retyped.**
      - *Progress bill* — cost-plus running account: reimbursable cost for the period (gross spend
        from `fn_expense_total`, which already excludes voided expenses), plus the management fee at
        the project's own percentage, **less everything already billed on earlier live progress
        invoices**. That deduction is why a cancelled bill matters: it stops counting immediately.
      - *Management fee* — fee % × certified net spend for the period. Refuses outright if the
        project has no fee percentage set, naming the screen to go fix it.
      - *Vendor voucher* — one line per posted, un-voided vendor invoice in the period, pulled from
        `po_invoices` + `purchase_orders`. If there are none it deletes the shell and errors rather
        than burning a number on an empty voucher.
- [x] **Amounts are a SNAPSHOT, not a live view.** This is the one place the app deliberately breaks
      its own "always compute live" rule: every other figure comes from a view because it should
      track current data, but a bill sent to a client must never change as later expenses land. So
      the RPC computes once, at issue time, and writes the numbers down. The browser still computes
      nothing — it prints what Postgres stored, and the header subtotal is summed from the stored
      line amounts so the two can never disagree.
- [x] **No write policy on `invoices` or `invoice_items`.** Read is founder/accounts; insert and
      update happen only inside SECURITY DEFINER RPCs. RLS default-deny means a client cannot forge
      an invoice or edit an issued one's figures.
- [x] **Cancellation joins the shared path** — `fn_cancel_document` gains an `invoices` branch, so
      PO, VO, SI and invoices now all cancel through one function with one CHECK-enforced reason.
- [x] **`amountInWords.ts`** — Indian lakh/crore grouping, paise only when non-zero, "Minus" prefix
      for negatives. **Unit-tested: 12 cases pass**, including ₹5,24,00,000 → "Five Crore Twenty
      Four Lakh" and paise handling. Western thousand/million grouping would be immediately wrong on
      an Indian invoice, so this was worth testing rather than eyeballing.
- [x] **`invoicePdf.ts`** — letterhead identical to PO/VO/SI, billed-to + project block, line items,
      GST breakup, total, amount in words, VOID watermark at 14% opacity when cancelled with the
      reason at full opacity. Filed to Docs → Invoices marked **confidential**, so supervisors never
      see it.
- [x] **Money → Invoices screen** — expandable cards showing the stored lines and totals, Download /
      File to Docs / Cancel, raise form with type, period, vendor picker (voucher only) and GST rate.
      Tab hidden for a PM so they don't hit an empty screen. Full design system.

**Flagged for you — this one is not a technical decision**

The progress bill is modelled as cost-plus: reimbursable cost billed **gross** with no further GST
(the tax was already borne on those purchases), and GST applied to the **management fee only**. That
avoids charging tax on tax and is a common structure, but it is a **tax position**. Have your CA
confirm it before the first real client bill. Changing it later means a new migration, not a code
edit, because issued invoices are immutable by design.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean, both function bodies clean.
- `amountInWords` unit-tested via compiled JS — 12/12.
- `npx tsc -b --force` clean (the correct command per rule 10).

**Not tested** — no invoice has been raised on real data yet. Untested: all three types, the PDF,
the words line, the VOID watermark, and the previously-billed deduction on a second progress bill.

**Migration 024 APPLIED** — confirmed 2026-07-28. A4 tested working end to end.

**Bug found and fixed while reviewing a delete request (no migration):**

- [x] **`canCancel` gave invoices the wrong roles.** It was written as "variation_orders → founder,
      everything else → founder/pm", so `invoices` inherited founder/**pm** — but
      `fn_cancel_document` requires founder/**accounts**. Net effect: an **accounts user could not
      see the Cancel button on an invoice they were entitled to cancel**, and a PM saw one the RPC
      would have rejected. Replaced the catch-all with an explicit per-table map that mirrors the
      four RPC branches one-to-one, so it can't drift again.

**Deliberately NOT added: a delete button on invoices.** An invoice carries a GST number from a
statutory series; deleting one leaves a gap in that series, which is itself a finding in an audit.
Cancel is the correct mechanism and already exists — the row stays, the number stays, the PDF prints
VOID, and a cancelled progress bill immediately stops counting as "previously billed" on the next
one. Recorded here so the decision isn't re-litigated later.


---

## Fix — progress-bill running-account structure (migration 025, APPLIED)

Caught by the user on a real second progress bill. Worth recording precisely, because the instinct
("it's double-charging GST") was right that something was wrong but wrong about what.

**What was NOT wrong.** No double taxation. Bill 2's GST minus bill 1's GST equalled exactly 18% of
the incremental fee, and the ₹8,23,900 payable was correct — verified by recomputing both ways.

**What WAS wrong.** 024 put "Less: previously billed" in with the LINE ITEMS, so a gross figure
(previous total, tax included) was deducted from the pre-tax `subtotal`. The printed invoice then
read:

    Subtotal      2,63,110
    GST @ 18%     5,60,790

18% of 2,63,110 is 47,360. Those two lines sit on top of each other and don't reconcile — and on a
GST invoice that is exactly what an assessing officer reads. Indefensible as printed.

**Fixed in 025.** `less_previously_billed` moved to a header column; `total` regenerated as
`subtotal + gst_amount - less_previously_billed`. The bill now states the cumulative position, taxes
it, then deducts:

    Reimbursable cost to date · Management fee to date
    Subtotal (cumulative taxable) · GST on the fee · Cumulative gross
    Less: previously billed (gross against gross) · Net payable

Same payable, every line defensible on its own.

**Second bug found while fixing it.** The user's bill 2 used an overlapping period (Jul 1 – Aug 30)
and worked by luck. Had they picked *August only*, the cost would have been one month's while the
deduction was the whole project's — a large negative bill. Progress bills now always compute
cumulatively to the chosen date, ignore any start date, store `period_from` as NULL to say so, and
a guard refuses to issue a negative bill.

Verified: migration parses clean, payable recomputed identical (₹8,23,900), GST is 18% of the fee
line on both bills, `tsc -b --force` clean. **Confirmed working by the user 2026-07-28.**

---

## Session — A7 RFI Management (Module 57), migration 026

Confirmed at start: **001–025 ALL APPLIED**, next = 026.

**Built**

- [x] **Migration 026** `026_rfis.sql` — `rfis` table, `rfi_status` (open/answered/closed/cancelled)
      and `rfi_category` (design/structural/MEP/finishes/other), `rfi_number_seq` → `RFI-0001`.
- [x] **Shape deliberately mirrors A6.** Same addressed-to pattern (linked vendor or free text — an
      architect is rarely in the vendor master, and blocking the question on registering one means
      the question doesn't get asked), same site-photos attachments, same cancellation contract.
      They're the same kind of object travelling opposite ways: an SI tells a contractor what to do,
      an RFI asks a consultant what to do.
- [x] **No money, so supervisors read it.** `rfi_read` is plain `is_member()` with no role check —
      supervisors are usually the ones who hit the clash and need to know whether an answer has
      landed before proceeding. If an answer turns out to carry cost, that goes on a VO and then an
      SI; this table never holds an amount.
- [x] **Three CHECK constraints doing real work**, not just documentation:
      - cancel requires `cancelled_at` + `cancelled_by` + a non-blank reason (the 021 contract);
      - an RFI must have someone to ask (linked vendor OR free text);
      - **`answered`/`closed` require the response text AND date to actually be present** — the
        status can never claim something the record doesn't contain.
- [x] **`fn_answer_rfi`** writes response text, date, who logged it and the status move in ONE
      statement, so those can't drift apart. **`fn_set_rfi_status`** handles close/reopen and
      **refuses to close an unanswered RFI** — that would quietly lose the question, which is what
      cancel is for. Cancelling a *closed* RFI is refused too (it was answered and acted on).
- [x] **`rfiPdf.ts`** — letterhead matching SI/PO/VO/invoice. Two-part document: question, then
      response. **An unanswered RFI prints ruled empty lines** rather than a blank gap, so the sheet
      can be handed or emailed to the consultant to write into. CANCELLED watermark at 14% opacity
      with the reason at full opacity, same as A6.
- [x] **Tasks → RFIs screen** — a count strip at the top ("N awaiting an answer · M past the
      required-by date"), because the clock is the entire point of the module. Inline
      record-response form, close/reopen, Download / File to Docs (→ Drawings, not confidential),
      cancel via the shared dialog. Full design system: skeleton, empty state with primary action,
      `OtherProjectsHint`, staggered reveal, toasts throughout.
- [x] `canCancel` map extended with `rfis: ['founder','pm']`, matching the new RPC branch. That map
      is now the single place the five cancellable document types are declared.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean, all three function bodies
  clean (`fn_answer_rfi`, `fn_set_rfi_status`, `fn_cancel_document`).
- `npx tsc -b --force` clean.

**Not tested** — no RFI has been raised on real data. Untested: raising, recording a response, the
close guard on an unanswered RFI, the PDF in both answered and unanswered states, the CANCELLED
watermark, and the supervisor view.

**Migration 026 APPLIED** — confirmed 2026-07-28. Not yet exercised on real data.

---

## Session — A8 Snags + Defect Liability Period (Module 19), migration 027

Confirmed at start: **001–026 ALL APPLIED**, next = 027.

**Built**

- [x] **Migration 027** `027_snags_dlp.sql` — `snags` table, `snag_severity` (low/medium/high),
      `snag_status` (open/in_progress/resolved/verified), `snag_number_seq` → `SNG-0001`.
      `projects.dlp_start_date` / `dlp_end_date`, **plus the `grant select` on both** — 010 revoked
      column-level SELECT on `projects`, so a new column is invisible to everyone until granted.
      That grant is the single line this module would have silently failed without.
- [x] **Evidence is enforced by the database, not the form.** `fn_resolve_snag` refuses a resolution
      with neither a photo nor a note, and `snags_resolution_ck` backs it up — a snag closed with no
      evidence is worth nothing, and a form check alone can be bypassed by any client.
- [x] **Separation of fix and sign-off.** `fn_verify_snag` is founder/PM only: whoever fixed a defect
      shouldn't be the one certifying it. That separation is the whole reason a snag list exists, so
      it lives in the RPC rather than in `canVerifySnag`, which is only the UI's echo of it.
- [x] **Reopening clears the old resolution.** `fn_set_snag_status(id,'open')` wipes the note, photos,
      resolved_at/by. Evidence for a fix that didn't hold no longer stands, and leaving it would let
      a snag show a fix photo while sitting open.
- [x] **`raised_during_dlp` is frozen at insert** by the `fn_snag_dlp_flag` trigger, comparing the
      raised date against the project's window at that moment. Deliberately *not* computed on read:
      if the DLP dates are edited later, history must not silently rewrite itself — whether a defect
      fell inside the liability period is a contractual fact about the day it was raised.
- [x] **`fn_project_snag_summary`** returns every count plus the DLP position (`dlp_active`,
      `dlp_days_left`) computed in Postgres. Nothing is tallied in the browser, including the
      countdown.
- [x] **Supervisors raise and resolve.** `snag_read`/`snag_insert` are plain `is_member()` — no
      figures on this table, and supervisors are the ones walking the site finding defects. Verify is
      the only gated action.
- [x] **Tasks → Snags screen** — Outstanding / In DLP / All filters, summary strip with open counts
      by severity and the DLP line, inline resolve form (camera-first, multiple photos, compressed
      client-side), start / resolve / verify / reopen, defect and fix photos shown side by side via
      signed URLs. Full design system: skeleton, empty state with primary action,
      `OtherProjectsHint`, staggered reveal, toasts throughout.
- [x] **Snag card on Project Detail** — open + in-progress, awaiting sign-off, severity chips, and
      the DLP countdown, going danger-coloured inside 30 days (`DLP_WARN_DAYS`). That warning is the
      one that costs money if it's missed: after the end date, defects stop being ours to fix under
      the contract.
- [x] **DLP dates on Manage → Projects**, written through `setProjectDlp` with an end-before-start
      guard. Read back through `fn_project_snag_summary`, which already returns the window — no new
      query, and no widening of `PROJECT_COLUMNS` (which would 400 for every screen if 027 hadn't
      been run yet).
- [x] **Hard delete, not cancel.** A snag has no downstream effect, so it belongs in mechanism 1;
      `fn_delete_record` gains a `snags` branch that **refuses to delete a verified snag** — that row
      is the record that a defect was fixed and signed off. Reopen it instead.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean, all four non-trigger
  functions clean. `fn_snag_dlp_flag` fails the parser only because **pglast cannot parse any
  `returns trigger` function** — proven against a trivial three-line case and against `fn_audit`
  from 001, which has run in production since day one. Recorded in CLAUDE.md.
- `npx tsc -b --force` clean.

**Migration 027 APPLIED** — confirmed 2026-08-01.

**Tested 2026-08-01** on the live app, founder + supervisor: DLP dates save and read back (the
column grant landed), raising a snag with photos, the evidence-free resolve refusal, verify, the
reopen-clears-resolution behaviour, and the verified-snag delete refusal. **A8 is done.**

Still worth watching on real use: whether the 30-day DLP warning is early enough for a 12-month
liability period, and whether supervisors want an "assigned to me" filter once more than a handful
of snags are open at once.

---

## Session — A9 Compliance / Statutory Calendar (Module 31), migration 028

Confirmed at start: **001–027 ALL APPLIED**, next = 028.

**Built**

- [x] **Migration 028** `028_compliance_calendar.sql` — `compliance_items`, three enums
      (`compliance_category`, `compliance_recurrence`, `compliance_status`),
      `v_compliance_calendar`, `fn_file_compliance`, `fn_unfile_compliance`,
      `fn_compliance_alert`, `fn_compliance_sweep`, a nightly pg_cron job, and the `compliance`
      storage bucket with its own policies.
- [x] **The cron job is bookkeeping, not truth.** `fn_compliance_sweep` writes
      `status = 'overdue'` nightly, but nothing in the UI reads that column — the screen reads
      `display_status` from `v_compliance_calendar`, which derives overdue / due-soon from
      `due_date` in Asia/Kolkata **at query time**. pg_cron isn't guaranteed to be enabled, and a
      deadline module whose correctness depends on a background job having run is exactly the
      module you can't trust. Every pg_cron statement is wrapped in an exception handler for the
      same reason: the migration cannot fail because an extension is unavailable.
- [x] **`project_id` is nullable and that's the feature.** A GST return is filed by the company, a
      building permit belongs to one site. RLS has two arms — company-wide rows are visible to any
      founder/pm/accounts user, project rows additionally require `is_member()`.
- [x] **Recurrence is generated server-side, inside the filing function**, so the two can never
      diverge. Next due date is computed from the **due** date, not the filing date — a return filed
      three days late must not push next month's deadline three days later. A UNIQUE
      `(series_id, due_date)` index plus `on conflict do nothing` makes a double click or a retry
      incapable of creating a duplicate; that guard is in the database, not in the form.
- [x] **A filed item must carry evidence of when.** `compliance_filed_ck` requires `filed_date` and
      `filed_by` whenever status is `filed`, so a client cannot claim a filing the row can't
      support. Reopening (founder/accounts only) clears the proof along with the status — a document
      proving a filing that's no longer claimed is worse than none.
- [x] **New `compliance` storage bucket.** Migration 006's policies key access off a leading
      `<project_id>/` path segment, which a company-wide item can't have. Company objects live under
      the literal `company/` prefix; project ones keep the project-id prefix and are membership-
      checked. PDFs upload byte-for-byte — a re-encoded acknowledgement isn't proof of anything.
- [x] **Money → Compliance screen** — month-grouped list (reads as a calendar, not a queue), a
      coloured rail per row, Outstanding / Filed / All, filters by category and by
      company/this-project. Inline mark-as-filed with date, proof upload and notes; edit; reopen;
      delete. Full design system: skeleton, empty state with primary action, staggered reveal,
      toasts throughout.
- [x] **Dashboard strip** — "Compliance — N overdue · N due this week", linking straight to the
      screen, and **rendering nothing when the calendar is clear**. A banner that's always there
      stops being read.
- [x] **Delete follows the existing rule.** An unfiled item has no downstream effect, so it's
      mechanism 1 via `fn_delete_record`; a **filed** one is refused, because it holds the proof of
      a statutory filing. `canDelete` extended so accounts (not just founder/pm) can delete these.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean; `fn_file_compliance`,
  `fn_unfile_compliance`, `fn_compliance_sweep` and `fn_delete_record` all clean.
  `fn_compliance_series` fails the parser only because it is a `returns trigger` function — the
  known pglast limitation recorded in CLAUDE.md.
- `npx tsc -b --force` clean (exit 0). One real error caught and fixed on the way: PostgREST widens
  an unknown view to `GenericStringError`, so `fetchCompliance` asserts through `unknown` once, the
  same pattern the other query files use.

**Migration 028 APPLIED** — confirmed 2026-08-01.

**Tested 2026-08-01** on the live app: adding a deadline, the filing flow with proof upload,
next-occurrence generation, reopen, and the dashboard strip. **A9 is done.**

Open question for real use: nothing yet reads `compliance_items.responsible` other than the card —
no "assigned to me" view and no per-person nudge. If deadlines start slipping, that's the gap to
close, not more colour on the calendar.

---

## Supervisor RLS pass — re-run 2026-08-01, CLEAN

The previous pass was 2026-07-25 and predated procurement, variations, instructions, RFIs, snags,
compliance and the admin module. Re-run in an incognito window on the live app against a supervisor
assigned to some but not all projects. **Nothing leaked.**

What was checked, and why each one mattered:

- **Every /money route entered by direct URL**, not by looking for a missing tab — a hidden tab
  proves nothing. Ledger, add expense, budget, vendors, orders, variations, invoices, compliance,
  plus /admin and /admin/team: all bounced.
- **Dashboard and Project Detail** — portfolio and per-project cards read "restricted"; no contract
  value, revised contract, management fee or spend; no compliance strip; recent activity carried no
  expense amounts.
- **Materials → Orders**, the sharpest edge in the app: supervisors legitimately raise purchase
  requests and receive deliveries there, so the screen is reachable by design. It showed status,
  item counts and need-by dates with **no order value, no rate, no line total**, while raise-request
  and goods-receipt both still worked. That is migration 012's column revoke on `po_lines` plus
  013's role-gated `v_po_value` doing exactly their job.
- **Stock, movements, material master** — quantities and challans, no rates (006's column grants).
- **Documents** — confidential files absent from the listing entirely, and a confidential URL copied
  out of the founder session refused (006's `fn_doc_is_confidential`, which has to be SECURITY
  DEFINER or it would invert).
- **Site instructions** — cost implication renders as a bare "Yes" with no amount, which is the
  whole reason 023 stored it as a boolean with the money on the linked VO.
- **Snags** — raise and resolve available, Verify absent.
- **Scope** — only assigned projects listed, and an unassigned project's detail URL refused.

Roles & Permissions is now ticked in ROADMAP with this coverage recorded. Re-run this pass after any
future module that shows a figure.

---

## Session — A10 Design / Drawing Management (Module 32), migration 029

Confirmed at start: **001–028 ALL APPLIED**, next = 029.

**Built**

- [x] **Migration 029** `029_drawing_register.sql` — `drawings` + `drawing_revisions`,
      `drawing_discipline` / `drawing_status`, `v_drawing_register`, `fn_issue_revision`,
      `fn_withdraw_revision`, `fn_drawing_file_is_current`, the `drawings` storage bucket, and two
      new branches on `fn_delete_record`.
- [x] **Two tables, because a revision is not a drawing.** `drawings` holds identity (number unique
      per project — two villas both having an SD-101 is normal), `drawing_revisions` holds what is
      actually issued. Folding them together would make "the current sheet" a client-side max() over
      rows, which is right until the day it isn't.
- [x] **The module is one index.** `create unique index drawing_rev_one_ifc_uk on
      drawing_revisions (drawing_id) where status = 'ifc'` makes two live revisions of a drawing
      impossible rather than merely unlikely. `fn_issue_revision` does the swap in one transaction
      and **demotes the old row before promoting the new one** — the other order violates the index
      mid-flight. A CHECK separately refuses an IFC revision with no file or no issued date:
      "issued for construction" with nothing to build from is a lie the row would otherwise tell.
- [x] **Supervisors are fenced twice, because the risk is physical.** `drawing_rev_read` hides WIP
      and superseded rows outright, so the wrong sheet doesn't exist for them; and the `drawings`
      bucket's read policy calls `fn_drawing_file_is_current()`, so a stale sheet can't be opened
      even with a copied URL. A uuid path is effectively unguessable, but "they can't guess it" is
      not an access rule. `fn_drawing_file_is_current` is SECURITY DEFINER for the same reason
      `fn_doc_is_confidential` is — run as the caller, RLS would hide the WIP row, the EXISTS would
      return false, and the policy would draw the opposite conclusion.
- [x] **A separate bucket rather than extending `documents`.** 006's vault policies are
      load-bearing across every existing file; teaching them about revision status would put every
      document behind a more complicated predicate. New bucket, blast radius zero.
- [x] **`v_drawing_register`** — one row per drawing carrying its IFC sheet, security_invoker so a
      supervisor's row policy applies inside it, and a final WHERE that hides never-issued drawings
      from them: a bare drawing number with nothing behind it is noise on a phone at site.
- [x] **Docs → Drawings screen** — current sheet given top billing in its own panel ("Build from
      this sheet"), history behind a toggle, superseded rows dimmed and struck through, discipline
      filter, WIP/superseded counts for founder/PM only, and a warning strip counting drawings with
      nothing issued. Upload-and-issue in one action, or save as WIP. Revision numbers auto-suggest
      (R0 → R1, A → B). Full design system: skeleton, empty state with primary action,
      `OtherProjectsHint`, staggered reveal, toasts throughout.
- [x] **Delete follows the rule.** A WIP revision that was never issued can go; an issued or
      superseded one is refused because it is the record of what site was told to build. A drawing
      with any revisions is refused too.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean; `fn_issue_revision`,
  `fn_withdraw_revision` and `fn_delete_record` all clean. `fn_drawing_rev_project` fails the parser
  only because it is a `returns trigger` function — the known pglast limitation.
- `npx tsc -b --force` clean (exit 0).

**Not tested** — no drawing has been entered. Untested: adding a drawing, the duplicate-number
refusal, uploading and issuing, the supersede swap, withdraw, the delete refusals, and — most
importantly — **the supervisor view: they must see only the IFC revision, and a superseded sheet's
URL must not open for them.**

**Migration 029 APPLIED** — confirmed 2026-08-01 by the `drawing_rev_one_ifc_uk` verify query
returning the index. That query is the last statement in the file, so the whole script ran,
including the storage bucket in §8 and `fn_delete_record` in §9. Not yet exercised on real data.

**Two fixes during first use (same session):**

1. **The form leaked the data model.** "Add drawing" created only the identity, so the first sheet
   needed a second, non-obvious step — a user added a drawing, saw History (0), and reasonably
   concluded the upload had failed. Worse, they typed the revision into the drawing-number field.
   The New Drawing form now takes the sheet in the same submit: number, title, discipline, then
   revision (pre-filled R0), file, date and "issue now", chained create → upload → issue. Two tables
   underneath is right; making the user feel them was not.
2. **Migration 030 — delete was too strict.** 029 refused to delete a drawing with any revisions,
   which made a mistyped drawing number permanent the moment a sheet was attached. A founder can now
   delete a drawing (revisions cascade) or any single revision; a PM stays limited to revision-free
   drawings and WIP revisions. The delete still writes to audit_log with the actor, which is what
   makes relaxing it safe — the record moves to the log rather than vanishing. The Delete button is
   now always rendered and the RPC explains any refusal, instead of the button silently not existing.

3. **Route collision — the register was mounted at `/docs/drawings`.** The document vault has a
   folder whose value is literally `drawings`, and its cards link to `/docs/${folder}`. A static
   route segment outranks `:folder` in React Router, so clicking the Drawings folder (5 files)
   rendered the empty register instead of the folder — the files were never gone, just unreachable.
   Register moved to **`/docs/register`**. Lesson worth keeping: adding a static child route under a
   path that also has a `:param` sibling silently steals every value that matches it.

4. **Restructured into three levels, at the user's request.** The single flat list didn't match how
   they navigate: Docs → **Drawings** now shows a folder per discipline (Architectural, Structural,
   MEP, Interior, Landscape, Other) → tap one for the drawings filed under it → tap a drawing for
   its own page listing every revision, which is where issuing, withdrawing, re-issuing and delete
   live. `Drawings.tsx` replaced by `DrawingFolders.tsx` / `DrawingList.tsx` / `DrawingDetail.tsx`
   at `/docs/register`, `/docs/register/:discipline`, `/docs/register/:discipline/:drawingId`.
   Added `fetchDrawing(id)` for the detail page.
5. **Upload tab removed from Docs.** Uploading now happens inside the folder you're filing into —
   a button on the folder screen, and the empty-state action, both linking to
   `/docs/upload?folder=<folder>` which prefills the folder. The capability stayed; only the
   redundant top-level tab went, since a top-level Upload made you pick the folder again after
   you'd already navigated to it.

---

## Session — document sub-folders (migration 031)

Founder can now create one level of sub-folder inside any of the eight vault folders
("Permits → BBMP", "Contracts → Subcontractors").

- [x] **A table, not a text column.** `doc_subfolders` (project, parent folder, name) with a
      case-insensitive unique index — "BBMP" and "bbmp" in one folder is a filing mistake, not two
      folders. A `subfolder text` column on documents would mean a folder only exists while a file
      sits in it: create it, upload nothing, refresh, gone. The founder creates these ahead of the
      files, so they need somewhere to live.
- [x] **`documents.subfolder_id` is nullable and ON DELETE SET NULL.** Null means the file sits at
      the folder root, which is where every existing row stays — no backfill. Deleting a sub-folder
      returns its files to the parent folder rather than taking them with it; a cascade here would
      destroy documents to remove a container.
- [x] **Founder-only writes** (`subfolder_insert`/`update` check `is_founder()`); everyone who can
      read the vault sees the structure, and anyone who can upload can file into one. Sub-folders
      carry no access rules of their own — confidentiality still lives on the document row where
      `docs_read` enforces it.
- [x] **Folder screen** shows sub-folder cards with file counts at the folder root, drills in via
      `?sub=<id>` (a query param, not a route segment — static-vs-param ranking has already bitten
      this file once), and each document gains a small "move to sub-folder" picker so existing files
      can be filed after the fact.
- [x] Upload carries `?folder=&sub=` through and prefills both; changing the folder clears the
      sub-folder, since it belonged to the old one.

`npx tsc -b --force` clean. Migration parses clean.

**Migrations 030 + 031 APPLIED** — confirmed 2026-08-01, and sub-folders exercised on the live app
the same day.

---

## Session — A11 Bill Certification / RA Bills (Module 33), migration 032

Confirmed at start: **001–031 ALL APPLIED**, next = 032.

**Built**

- [x] **Migration 032** `032_ra_bills.sql` — `ra_bills` + `ra_bill_lines`, `ra_status`,
      `v_ra_bill_totals`, `v_ra_payables`, `fn_certify_ra_bill`, `fn_reject_ra_bill`,
      `fn_set_ra_status`, plus `ra_bills` branches on `fn_cancel_document` and `fn_delete_record`.
- [x] **Lines carry quantity TO DATE, not this period.** That is how an RA bill is actually written
      on site, and it is what makes the running account self-correcting: if bill 2 under-measured a
      wall, bill 3 states the true cumulative quantity and the difference falls out by itself. The
      alternative — per-period quantities — needs every past bill to be right forever.
- [x] **The arithmetic, all in Postgres:** gross = Σ(qty × rate); less-previously-certified = Σ gross
      of earlier *certified* bills for the same contractor on this project; value this bill = the
      difference; retention = round(value × pct, 2) **on this bill's value only**, so the same work
      is never held back twice; net = value − retention. Migration 025's lesson applied up front:
      a deduction at the wrong level still yields the right payable but an unreconcilable statement.
- [x] **Certified figures are FROZEN in columns.** `v_ra_bill_totals` previews the arithmetic while a
      bill is in review, then `coalesce(stored, live)` makes the snapshot win. Without that, editing
      a measurement months later would silently restate a bill that has already been paid.
- [x] **Constraints, not form validation:** `certified` requires all four figures plus who and when;
      `rejected` requires a reason; `cancelled` keeps the 021 contract. A client cannot fake any of
      the three.
- [x] **Certification is founder/PM**, and the refusal says why: accounts prepare and record a bill,
      but the signature that authorises payment isn't theirs. `fn_certify_ra_bill` also refuses a
      bill with no lines, and refuses one where work-to-date is *less* than what has already been
      certified — a running account cannot go backwards.
- [x] **Certificate PDF** on the letterhead, laid out as the account reads on paper (work to date →
      less previously certified → value this bill → less retention → net certified), net in words,
      claimed-vs-certified noted underneath. VOID watermark for **rejected as well as cancelled** —
      both mean "do not pay against this sheet", and a rejected bill still circulates.
- [x] **`v_ra_payables`** — certified value, retention held and net payable per contractor, shown as
      a strip above the list.
- [x] Cancel is the only way to undo a certified bill, and it self-heals: the next bill's
      "less previously certified" drops automatically, because that figure is summed from certified
      rows rather than stored as a manual number.

**Deliberately not done**

- **Certifying does not post to Open Book.** Vendor invoices already post there through procurement;
  a contractor appearing in both paths would be double-counted. Posting can be added once there's a
  rule for which path owns which spend.
- **Retention release and bank guarantees are A12.** This module holds retention and reports it.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean; `fn_certify_ra_bill`,
  `fn_reject_ra_bill`, `fn_set_ra_status`, `fn_cancel_document` and `fn_delete_record` all clean.
  `fn_ra_line_project` fails only as a `returns trigger` function — the known pglast limitation.
- `npx tsc -b --force` clean. One real error caught on the way: `CancelDialog` takes
  `summary`/`consequence`, not `name`.

**Not tested** — no bill has been recorded. Untested: recording a bill, adding measurements,
certifying, the previously-certified deduction across two consecutive bills, the retention figure,
rejection with reason, cancel-after-certify and its effect on the next bill, the PDF in certified and
rejected states, and the supervisor check (no /money access at all).

**Migration 032 APPLIED** — confirmed 2026-08-01 by the views query returning both
`v_ra_bill_totals` and `v_ra_payables`. That is the last statement in the file, so the whole script
ran. Not yet exercised on real data.

---

## Session — A12 Retention & Bank Guarantees (Module 34), migration 033

Confirmed at start: **001–032 ALL APPLIED**, next = 033.

**Built**

- [x] **Migration 033** `033_retention_and_bg.sql` — `retention_releases`, `bank_guarantees`, four
      enums, `v_retention_ledger`, `v_bg_register`, `fn_release_retention`, `fn_set_bg_status`,
      `fn_bg_alert`, `fn_bg_sweep` + the `mason-bg-sweep` cron job, and two more branches on
      `fn_delete_record`.
- [x] **Retention held has no input field anywhere.** It is summed from `retention_amount` on
      CERTIFIED `ra_bills`, per contractor, inside the view. The instant that number becomes
      editable it starts disagreeing with what was actually certified — and the disagreement is
      invisible, because both figures look authoritative. Balance = held − released, computed on
      read, so cancelling a bill corrects the balance at once rather than leaving a stale total.
- [x] **The schedule and the release are one table.** "Half on completion, half after DLP" is two
      `planned` rows; releasing one flips it to `released` with the actual amount, date and person.
      A separate schedule table would have to be reconciled against the releases, and reconciliation
      is where errors live.
- [x] **`fn_release_retention` refuses to over-release** — it re-derives what is held from certified
      bills and what has already gone out, and raises if the sum would exceed it. Founder/accounts
      only, because releasing moves money out of the business; PM can plan but not pay.
- [x] **BG register** with number unique per project, issue/expiry/**claim-period** dates (the claim
      date matters: it, not expiry, is the last day a guarantee can actually be invoked), scanned
      copy in the existing `compliance` bucket rather than a fourth bucket with the same three
      policies rewritten.
- [x] **Expiry derived at query time**, exactly as 028 does: `v_bg_register.display_status` computes
      expiring/expired from `expiry_date` in Asia/Kolkata, and the nightly `mason-bg-sweep` job is
      bookkeeping only. A guarantee that lapses silently because a cron job didn't run is precisely
      the failure this module exists to prevent, so the screen cannot depend on it.
- [x] **Dashboard strip** for guarantees, alongside compliance — and like that one, it renders
      nothing when there is nothing to chase.
- [x] Delete refuses a released tranche (money left the business against it) and a
      released/returned guarantee (a fact about a real instrument).

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean; `fn_release_retention`,
  `fn_set_bg_status`, `fn_bg_sweep` and `fn_delete_record` all clean. No trigger functions in this
  one, so nothing hit the pglast limitation.
- `npx tsc -b --force` clean.

**Not tested** — nothing entered. Untested: the ledger appearing after a bill is certified, planning
two tranches, releasing one, the over-release refusal, adding a guarantee with a scan, the 30-day
amber and past-due red states, the dashboard strip, and the delete refusals.

**Migration 033 APPLIED** — confirmed 2026-08-01 by `cron.job` returning both `mason-bg-sweep`
(`40 22 * * *`, active) and `mason-compliance-sweep`. That is the last statement in the file, so the
whole script ran. Not yet exercised on real data.

---

## Session — A13 Insurance Management (Module 30), migration 034 — GROUP A COMPLETE

Confirmed at start: **001–033 ALL APPLIED**, next = 034.

**Built**

- [x] **Migration 034** `034_insurance.sql` — `insurance_policies`, `insurance_type` /
      `insurance_status`, `v_insurance_register`, `fn_set_policy_status`, `fn_insurance_alert`,
      `fn_insurance_sweep` + the `mason-insurance-sweep` cron job, and an insurance branch on
      `fn_delete_record`.
- [x] **Company-wide or per project**, `project_id` nullable with the same two-arm RLS as
      compliance: a CAR policy covers one site, professional indemnity covers the practice.
- [x] **Renewals chain rather than overwrite.** Renewing creates a NEW policy row pointing at the old
      one through `renewed_from`, then marks the old one `renewed`. Editing dates in place would
      erase what was covered last year, which is precisely what a late claim needs. The form
      prefills from the old policy, and the status flip happens **after** the replacement saves —
      otherwise a failure would leave a policy marked renewed with nothing renewing it. Delete
      refuses any policy a later one renews.
- [x] **Third instance of the expiry-register shape** (028 compliance → 033 guarantees → 034
      insurance): a view deriving `display_status` from a date in Asia/Kolkata at query time, a
      nightly sweep that only persists the status, an invoker-rights alert function returning
      counts, and a dashboard strip. Recorded in CLAUDE.md as a pattern to reuse rather than
      reinvent.
- [x] **Dashboard strips refactored.** Three near-identical components collapsed into one
      `AlertStrip` — icon, label, parts, urgent flag, destination — with the compliance, guarantee
      and insurance strips as thin callers. All three still render nothing when their count is zero.
- [x] Unique index on (insurer, policy number): the same number can exist at two insurers, but not
      twice at one.

**Verification**

- Migration parsed clean: outer SQL, `fn_set_policy_status`, `fn_insurance_sweep`,
  `fn_delete_record`. No trigger functions.
- `npx tsc -b --force` clean.

**Not tested** — nothing entered. Untested: adding a policy company-wide and per project, the
document upload, the 30-day amber and lapsed red states, renewing (including the chain and the
delete refusal), and the dashboard strip.

**Migration 034 APPLIED** — confirmed 2026-08-01 by `cron.job` returning all three sweeps
(`mason-compliance-sweep`, `mason-bg-sweep`, `mason-insurance-sweep`, all active). That is the last
statement in the file, so the whole script ran. Not yet exercised on real data.

**Every Group A module is now built and every migration applied (001–034).** Nine of the thirteen
have never been exercised on real data — that testing backlog, not Group B, is the largest
outstanding risk in the project.

---

## Session — multi-file upload + project handover archive (no migration)

**Multi-file upload in the vault.** The upload form took one file at a time. It now takes several,
appends on a second pick rather than replacing, and lets you remove one without starting over. With
one file the Title field behaves as before; with several it becomes an optional **prefix** and each
document is titled from its own filename. Each file uploads and is recorded **independently**, so a
failure on the third of five keeps the other four and names the one that failed — a single
transaction would have thrown away work that had already landed.

**Project handover archive** (`src/lib/projectArchive.ts`, founder-only card on Project Detail).
One zip containing `data/*.csv` for every record type on the project, `files/` grouped by what they
belong to (documents, drawings, site photos, snags, receipts, challans, compliance proofs,
guarantees, insurance), and an `index.html` that reads offline.

- **Browser-built, not an Edge Function.** A function would have to hold the whole archive in memory
  inside a 150-second budget; the browser has neither limit, is already authenticated, and the bytes
  end up on disk either way.
- **RLS is the security, not the code.** Every query runs as the signed-in user, so an archive can
  never contain more than that person can already see. The card is founder-only because an archive
  contains every figure on the project.
- Rate-bearing views (`v_material_inward_rates`, `v_po_lines_rated`) are used where the base tables
  have column revokes, or the CSVs would silently omit rates.
- A missing storage object is counted and reported, never fatal — one unreadable file shouldn't cost
  you the other four hundred. CSVs carry a UTF-8 BOM so Excel doesn't mangle ₹ and accented names.
- DEFLATE level 3 deliberately: the payload is mostly already-compressed JPEG and PDF, so a higher
  level costs seconds and saves almost nothing.

**New dependency: `jszip` ^3.10.1** (pure JS, MIT — same class as jspdf). It is installed in
node_modules and listed in package.json; `npm install` run 2026-08-01 to sync the lockfile.
The 10 npm-audit findings that surfaced are all transitive dev-tooling (hono/MCP SDK,
brace-expansion, fast-uri, ip-address, postcss) plus a react-router **RSC-mode** CSRF advisory that
doesn't apply — this is a client-side SPA with no RSC. `npm audit fix --force` would *downgrade*
react-router-dom from 7.18.1 to 7.11.0 across a major boundary, so it stays as it is.

`npx tsc -b --force` clean.

---

## Session — Tasks → History: tasks, site logs and safety (no migration)

A **History** tab on Tasks with one date range (last 7 / 30 / 90 shortcuts or explicit from/to)
driving three sections, because the question people actually ask is "what happened in July", not
"what tasks happened in July":

- **Tasks** — grouped by day; task, trade, work area, status, target vs done quantity, reason if
  not done, and where a rolled-over row came from. Status and trade filters.
- **Site logs** — one row per day: weather, masons / helpers / other and the labour total, work
  summary, issues, photo count, who logged it.
- **Safety** — daily checks **pivoted one row per day with a column per check item** (PPE,
  scaffolding, edge protection, electrical, housekeeping, excavation), pass/fail coloured with the
  remark underneath, failures counted on the date cell; plus a separate incidents-and-near-misses
  table. A row per item would have made a month 180 unreadable rows.

- **Instructions, RFIs and Snags** — one shared table, because all three are the same object in
  different costumes: a numbered document with a date, a party, a status and something that closes
  it. `DocHistoryRow` carries that shape and each fetcher maps its own columns onto it; only the
  headings differ (SI no. / Issued to / Required by / Completed vs Snag no. / Assigned to / Closed).
  A required-by date that has passed with nothing closing it prints red.
- Snag severity and "in DLP", and an SI's cost-implication flag, ride in the generic `extra` column.
  The SI stays a **boolean** — the rupee value lives on the linked VO, which supervisors cannot
  read, so printing "Cost implication" rather than an amount keeps the money-hiding rule intact on a
  screen every role can reach.

**Export to Excel** on each section writes a CSV of exactly what's on screen, filters included.
Safety exports two files — checks and incidents — since they don't share a shape.

- Every range query is **capped** (tasks 2000, site logs 1000, checks/incidents 500). A year of a
  busy site is a few hundred; an unbounded query that quietly starts taking six seconds is worse
  than one that tells you to narrow the range.
- New `src/lib/queries/history.ts` holds the three range reads. Names are resolved in a second pass
  rather than an embedded join — the join defeats PostgREST's type inference and costs the same one
  query either way.
- The layout's single-day picker is **hidden on this tab** — leaving it above a range view would
  suggest the two are connected.
- New shared `src/lib/csv.ts`: UTF-8 BOM (without it Excel turns ₹ into mojibake) and CRLF line
  endings, with RFC 4180 quoting so a note containing a comma doesn't shift every column after it.
  The archive builder has its own inline copy of the same logic — worth consolidating if a third
  export appears.
- Horizontal scroll on a phone is deliberate: this screen exists to be read like a sheet, and the
  CSV is one tap away when the small screen isn't enough.

`npx tsc -b --force` clean.

---

## Session — Send button on RFIs, instructions and POs (no migration)

**Nothing in this app sends anything on its own, and that stays true.** A **Send** button on an RFI,
site instruction or PO now hands the generated PDF to the browser's own share sheet
(`navigator.share` with files) so the user picks WhatsApp — or whatever else — and taps send. Where
file sharing isn't supported (most desktops), it downloads the PDF and opens WhatsApp Web with the
message already written, prefilled to the vendor's number when one is on file.

- **No API, no provider, no secret, no cost.** WhatsApp Business API is on the cut list and email
  would mean a provider plus a stored credential; the share sheet is the browser's.
- `shareDocument()` returns **what actually happened** — shared / downloaded-and-opened / cancelled —
  so the toast never claims "sent" when the user backed out of the share sheet. An `AbortError` is
  a closed sheet, not a failure, and gets no error toast.
- `canShare({ files })` is the capability test, not `share` alone: Safari exposes `share()` without
  file support and throws when handed one.
- Phone numbers come from the **linked vendor only** — free-text recipients have a name, not a
  number, and the toast says so rather than silently opening an empty chat. `waNumber()` prepends
  91 to a bare 10-digit Indian number and leaves anything longer alone.
- The PO always shares the **full copy including rates**: the vendor is the one party who is meant
  to see them. The rate-free delivery copy stays for site.
- The SI message carries the cost-implication **flag**, never an amount — the figure lives on the
  linked VO, and a WhatsApp message is the last place it should leak.

Vendor `phone` is now joined into the RFI and SI queries (`vendors(name, phone)`) and exposed as
`addressed_phone`. `npx tsc -b --force` clean.

---

## Session — RFI response attachments, migration 035

Recording an RFI response now takes files. An answer is usually a marked-up sketch or a revised
detail, not a paragraph — until now only the *question* could carry attachments, so the actual
answer arrived on WhatsApp and lived nowhere.

- **`rfis.response_attachments` is a separate column** from `attachments`. Merging them would leave
  the record unable to answer "what did we send, and what came back" — which is the entire reason to
  keep an RFI log rather than a chat thread.
- **Files go to the `documents` bucket, not site-photos.** A consultant replies with a PDF or DWG,
  and the site-photos path re-encodes everything as JPEG, which would silently destroy the detail.
  The documents bucket stores non-images byte-for-byte and its RLS is is_member() plus the
  confidential check, so any project member can open a reply exactly as they can open the RFI.
- **The RPC appends rather than replaces**, so correcting the wording of an answer later doesn't
  drop the sketch that came with it. The text answer stays mandatory — "see attached" is a summary
  someone can read in a list; a bare file is not.
- **`fn_answer_rfi` was dropped before being recreated.** Adding a defaulted parameter creates an
  *overload*, not a replacement, and the three-argument version would have survived to make later
  calls ambiguous. The verify block counts rows in `pg_proc` so a missed drop is visible. Recorded
  in CLAUDE.md.

`npx tsc -b --force` clean.

---

## Session — web push for the daily task list, migration 036

Automatic morning notification: "3 due today · 2 still open" with the project names underneath,
tapping it opens Tasks. No provider, no per-message cost — the app is already an installable PWA, so
the phone can receive a push directly.

**Pieces**

- **Migration 036** — `push_subscriptions` (per DEVICE, unique on endpoint, because the browser
  issues one endpoint per install and someone with a phone and a tablet wants both),
  `fn_daily_task_digest()` which returns one row per person with counts already computed, and
  `fn_schedule_daily_push(url, secret, cron)` so the shared secret is typed once into a statement
  you can clear rather than committed in a migration file.
- **Edge Function `daily-task-push`** — verifies a shared-secret header, reads the digest with the
  service role, sends one push per device via VAPID.
- **`public/sw.js`** — `push` and `notificationclick` handlers; CACHE_VERSION bumped to v2. The
  click focuses an already-open window instead of opening a second copy of the app.
- **`src/lib/push.ts` + `PushCard`** on the Dashboard — per-device toggle.

**Decisions**

- **A push is a nudge, not a receipt.** Phone off, no coverage, permission revoked — it simply
  doesn't arrive, and nothing in the app depends on one having done so. The list stays the record.
- **The Edge Function computes nothing.** Wording comes from counts `fn_daily_task_digest` returns,
  so the notification and the screen cannot disagree.
- **Two gates on the service-role key**: a shared-secret header, and the function takes no input at
  all — no user id, no project, nothing an attacker could steer. A leaked secret buys a duplicate
  notification, nothing more.
- **404/410 disables a subscription; anything else only counts a failure.** A push service having a
  bad minute must not silently unsubscribe the team.
- **iOS is called out in the UI**, not discovered: Apple exposes the Push API only to PWAs added to
  the Home Screen, so the card says so instead of offering a button that would fail.
- `fn_daily_task_digest` is **not granted to `authenticated`** — nobody needs to read everyone
  else's workload.

`npx tsc -b --force` clean.

**Migrations 035 + 036 APPLIED** (2026-08-01), Edge Function deployed with its secrets, and
`mason-daily-task-push` scheduled. **Whether a notification has actually landed on a phone is not
yet confirmed** — that is the only thing that proves this module works, and it is the outstanding
check.

**Setup, for the record** (a rebuilt database needs all five): `npx web-push generate-vapid-keys` →
public half into `VITE_VAPID_PUBLIC_KEY` (also in the Cloudflare Worker's variables) → run 036 →
deploy `daily-task-push` with `PUSH_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `APP_URL` → `select fn_schedule_daily_push(url, secret, '30 1 * * *')`.

**One bug found on first use:** `fn_schedule_daily_push` gated on `my_role() = 'founder'`, but the
SQL editor connects as `postgres` with no JWT, so `my_role()` is NULL and the founder was locked
out of their own setup step. Fixed to the same shape the sweep functions already used — gate a
signed-in caller, let an owner-level connection through. Recorded in CLAUDE.md.

Also added: the card **hides itself** when `VITE_VAPID_PUBLIC_KEY` is absent, rather than offering a
Turn-on button that throws.

**CONFIRMED WORKING 2026-08-01** — `{"people":3,"sent":1,"disabled":0,"failed":0}` from a manual
trigger, with the notification delivered. Migrations 035–037 applied, function deployed, cron
scheduled `30 1 * * *`.

**Four things broke on the way, all worth keeping:**

1. **`serviceWorker.ready` never resolves in dev.** registerSW.ts skips registration on the dev
   server (a service worker would shadow Vite's HMR), so the Turn-on button hung on "Working…"
   forever with no error. Now fails fast with "notifications need the built app", and the button
   uses try/finally so an exception can never strand it. Test push against `npm run build && npm run
   preview`, not the dev server.
2. **The Supabase function gateway needs `Authorization: Bearer <anon key>`** — without it you get
   401 UNAUTHORIZED_NO_AUTH_HEADER before your own code runs. `fn_schedule_daily_push` gained an
   anon-key parameter for this (signature change, so the old three-arg version is dropped first —
   the 035 lesson, applied deliberately this time).
3. **A missing PUSH_SECRET and a wrong one both returned a bare 403**, which sent us hunting for a
   mismatch that didn't exist. A missing secret now returns 500 with the reason; a wrong one still
   gets the terse 403, because that one might be an attacker.
4. **The digest ignored founders** (migration 037) — see the is_member() lesson in CLAUDE.md.

**Not a bug, worth knowing:** the digest only counts **active** projects. AADHYA being `completed`
is why the first successful call still reported "nothing due" — correct behaviour, confusing symptom.

**Outstanding:** only one device is subscribed. The other two people with tasks due need to open the
app and turn it on themselves — subscriptions are per device and cannot be enabled on someone's
behalf. And `VITE_VAPID_PUBLIC_KEY` must be added to the **Cloudflare Worker's** variables before the
live site can offer the card at all.

---

## Two gates before Group B — both CLEAN, 2026-08-06

**Gate 1 — supervisor RLS, full pass.** Every module this time, including the six surfaces added
since the 2026-08-01 pass: /money/bills, /money/retention, /money/insurance, the drawing register,
Tasks → History with its CSV exports, and the handover archive card. All clean. The two that mattered
most and held: **Materials → Orders**, which supervisors legitimately reach, showed no value, no rate
and no PO document block while raise-request and goods-receipt kept working; and the **drawing
register**, where a supervisor sees only the current IFC revision and a superseded sheet's signed URL
refuses to open.

**Gate 2 — money reconciliation.** Spend agrees across Ledger, Dashboard and Project Detail; the
portfolio total equals the sum of its projects; **voiding an expense moves all four figures together**
and leaves the row visible marked VOID; the three-way match posts a vendor invoice to the ledger
exactly once; a second progress bill's arithmetic reconciles on the page; and retention held equals
`sum(retention_amount)` over certified RA bills, dropping the moment a certified bill is cancelled.

That last one is the proof the derived-balance decision was right: nobody typed the retention figure,
so nothing could drift.

**What these gates did NOT cover** was then cleared in a dedicated testing pass, below.

---

## Session — B6 Company P&L & Project Profitability (Module 29), migration 038

Confirmed at start: **001–037 ALL APPLIED**, next = 038. First Group B module.

**Built**

- [x] **Migration 038** — `v_project_pnl`, `v_pnl_by_category`, `fn_company_pnl`. Views only: no new
      tables, so no new RLS policies or audit triggers. Every figure derives from tables that
      already have both.
- [x] **I did not implement the margin formula as briefed, and this is the important note.** The
      brief said *revenue − cost − retention held = margin*. That double-counts: retention is a
      slice of a certified RA bill we haven't PAID, but the work is done and the full certified
      value is already inside cost. Deducting it again would flatter any project holding retention,
      then quietly worsen the figure as tranches are released — backwards from the truth. So margin
      is **revenue − cost**, and retention rides alongside as a labelled cash memo. If the CA wants
      a cash-position view, that is a second report, not this one.
- [x] **Cost = expenses (voids excluded) + certified RA bills.** Those two are disjoint by
      construction, because 032 deliberately doesn't post certified bills to Open Book. If a
      contractor is ever paid through both paths this figure double-counts them — noted in the
      migration header, because the fix is to stop doing that, not to net it out in a view.
- [x] **Revenue counts approved variations only.** Pending VOs appear on their own line so nobody
      plans around money the client hasn't agreed to.
- [x] **Projection** = actual + unspent budget + open commitments (approved POs with nothing
      invoiced). **Null when there's no budget** — an honest blank beats a confident wrong number,
      and the card says why.
- [x] **Category breakdown ranked by overspend**, not alphabetically. Contractor bills appear as
      their own line rather than being folded into a budget category they'd silently consume.
- [x] **Owner-run views, WHERE clause as access control** — the 010 pattern, forced by
      `contract_value` being revoked from `authenticated`. Supervisors match no arm and get zero
      rows. The company roll-up is a separate SECURITY DEFINER function gated to `is_founder()`,
      returning zero rows for anyone else so the screen renders nothing rather than erroring.
- [x] CSV export of every project's P&L for the CA. Tally XML stays deferred, as planned.

**Verification**

- Migration parses clean against the real PostgreSQL grammar.
- `npx tsc -b --force` clean.

**Not tested** — nothing exercised. Untested: the figures themselves against a project with real
cost, the founder-only company card, the PM seeing only assigned projects, the category ranking, the
projection, and the CSV.

**Migration 038 APPLIED** — confirmed 2026-08-06.

**Margin now also appears on the Dashboard**, under each project card's spend figures, for
money-roles only. Same source (`v_project_pnl`), so the dashboard and the P&L screen cannot
disagree.

**Two honest-blank cases added in both places**, because the arithmetic is right and the meaning
isn't: a project with revenue and **zero recorded cost** computes to a 100% margin, which means work
hasn't started rather than that it is wildly profitable — it now reads "Not started" / "No cost
recorded yet". A project with **no contract value** says profitability can't be worked out, rather
than showing a 100% loss.

**Migration 039** (applied same day) removes a gate rather than adding one: 038 had `fn_company_pnl`
demanding `is_founder()`, which was redundant — it sums `v_project_pnl`, and that view already
scopes rows to the caller. The extra check gave a PM or accounts a blank where a number belongs.
Now founder and accounts total every project, a PM totals their own, a supervisor gets nothing.
The P&L screen still shows its "Company position" card to the founder alone, which is a
presentation choice made in the UI.

Also in 039: **"in profit" requires cost to exist**. IHA has revenue and no spend, so counting it as
profitable would have read "2 in profit" on a dashboard where one project is losing ₹25 lakh.

**Colour rule, one place:** `marginTone` / `MARGIN_TEXT` / `MARGIN_LABEL` in `lib/format.ts` —
green profit, red loss, blue break-even (new `--neutral` token), with the **label taking the same
colour as the figure**. Three screens rendering the same verdict from three separate ternaries is
how they eventually disagree.

**Verified against the raw tables 2026-08-06** (queried directly as `postgres`, bypassing the view):
AADHYA revenue ₹1,87,78,000 against cost ₹2,12,95,520 = a loss of ₹25,17,520 (−13.4%); IHA revenue
₹5,24,10,000 with no cost recorded. Company: revenue ₹7,11,88,000, cost ₹2,12,95,520, margin
₹4,98,92,480 at 70.1% blended, one project in profit and one losing money.

---

## Testing residue cleared — GROUP A COMPLETE, 2026-08-06

Every remaining untested path exercised on real data. **A1–A13 are now all `[x]`.**

- **A2 Safety** — checklist with a Fail, remark and photo surviving a reload; incident reported and
  closed; the Project Detail safety card responding.
- **A7 RFIs** — raise, letterhead PDF with its ruled empty response block, Send, response recorded
  **with an attachment**, the attachment surviving a text-only edit (the 035 append behaviour), and
  the refusal to close an unanswered RFI.
- **A13 Insurance** — company-wide and project policies, the amber expiring state, the renewal
  chain, and the refusal to delete a policy a later one renews.
- **A10 Drawings, founder side** — add with first sheet, issue, then a second revision **superseding
  the first automatically**; WIP saved without issuing; delete refused on an issued revision and
  allowed on a WIP one.
- **A12 Retention + BG** — a tranche planned and released with the balance dropping, the
  over-release refusal, a guarantee added with a scan showing amber inside 30 days, and marking it
  returned.
- **A4 INV-M / INV-V** — management fee derived from contract value × fee % rather than typed, the
  vendor payment voucher, and cancellation with its VOID watermark.
- **A5 / A6 loose ends** — cancelling an approved VO corrected the revised contract value on Project
  Detail immediately; cancelling an SI produced the CANCELLED watermark, and a completed one was
  refused.

That also closes **Record removal (020–022)**: all three mechanisms — void, hard delete with its
refusals, and cancel — have now been exercised.

**Still open, and deliberately so:** M21 Petty Cash has a full backend and no UI (build or drop),
M02 Tasks awaits EVM in Group B, and creating a user through the `admin-create-user` Edge Function
has still never been run end to end.

---

## Session — "Send today's list" on Tasks (no migration)

A WhatsApp fallback beside the push, because the push only reaches people who installed the app and
granted permission — and on a site not everyone will. A message someone sends by hand always arrives.

- Button on the Tasks list (founder/PM/supervisor) → pick a person from the project team → WhatsApp
  opens with the day's tasks written out: numbered, with trade, work area and target quantity, and a
  status tag only when it isn't the default so a fresh list stays clean.
- `fetchProjectTeam` reads `project_members` joined to profiles; a member with no phone on file says
  so and falls back to the chat picker rather than opening an empty conversation.
- `shareText()` added to `src/lib/share.ts`. It **prefers WhatsApp's deep link over the OS share
  sheet when a number is known** — the share sheet can't target a contact, so the deep link is
  strictly better in that case. With no number it uses the share sheet where available.
- Still nothing automatic: WhatsApp opens with the text, the person taps send.

`npx tsc -b --force` clean.

---

## Session — M29 part 2: company overheads + true net position, migration 040

Confirmed at start: **001–039 ALL APPLIED**, next = 040.

038 gave every project a gross margin. That is not profit — it ignores the rent, the CA, the
software, the salaries of people who never set foot on a site. This session adds those costs and the
arithmetic that turns margin into an actual net figure.

- [x] **Migration 040** — `overhead_category` (12 headings as an enum, not a lookup table: they
      change about once a year, and a table invites someone to "just add one" mid-month and quietly
      split a year's reporting in two), `company_expenses`, RLS, audit trigger, storage policies,
      and four functions: `fn_void_company_expense`, `fn_duplicate_overheads`,
      `fn_overhead_summary`, `fn_company_net`.
- [x] `src/lib/queries/overheads.ts` — CRUD, the three RPCs, and `periodRange()` (India's FY is
      April–March; reading "this FY" as the calendar year would misstate every annual figure by nine
      months in Q1–Q3).
- [x] **Overheads screen** (`/money/overheads`, founder + accounts) — month picker, category filter,
      running total for the month, entry form with optional compressed proof, void with a mandatory
      reason, and **Copy last month**.
- [x] **P&L rebuilt around three layers** — period selector (month / quarter / FY / all), the **net
      position as the hero figure** in green or red, overheads by category with share bars, then the
      per-project cards that were already there.
- [x] **CSV for the CA** — now multi-section: project margins, overheads by category, and the net
      position. `toCsvSections()` added to `src/lib/csv.ts` so the BOM sits once at the top of the
      file instead of once per block (a stray mid-file BOM shows up as junk in the first cell of that
      section — the sort of thing a CA notices and nobody can explain).

### Decisions worth keeping

**A dedicated table, not a pseudo-project.** Overheads could have been an "Office" project with
expenses hanging off it. That would have poisoned every existing view — portfolio spend, budget vs
actual, `v_project_pnl`, the dashboard cards — each needing to learn to exclude one magic row, and
each one edit away from silently including it again. A separate table keeps `expenses` meaning
exactly what it has always meant: money spent ON A SITE.

**Manual only.** No recurrence, no auto-posting, no scheduled job. Rent that posts itself is rent
nobody checks. `fn_duplicate_overheads` copies a month forward when asked and **refuses if the
target month already has rows** — the failure mode of a copy button is copying twice, and two months
of office rent in one month is the kind of error that survives to the annual accounts.

**Its own void function, not a `fn_void_record` branch.** That dispatcher exists to route
project-scoped side effects — reversing stock, unwinding a mirrored expense, refusing a void that
would push inventory negative. A company overhead has no project, no stock and no cascade, so a
branch there would be routing with nowhere to route. Same contract: mandatory reason, security
definer, no client-side UPDATE path.

**Explicit storage policies for `receipts/company/…`.** 006's existing policies already resolve
correctly, because `is_member()` returns true for a founder regardless of project — but that is an
accident of how `is_member()` is written, not a stated rule. 040 says it out loud so a future edit
to `is_member()` cannot silently open the firm's bank charges to a supervisor.

**The period governs overheads only.** Project margins stay lifetime-to-date — a contract is judged
over its whole life, not by the calendar — while overheads are inherently monthly. So the net reads:
project margins TO DATE, less overheads for the CHOSEN PERIOD, and the card **names both spans on
screen**. Picking "this FY" makes the comparison meaningful; picking "last month" answers a narrower
question, and a screen that mixed the two silently would be the easiest way in this app to mislead
yourself.

### Access

founder + accounts: everything. **pm:** project margins only — `fn_company_net` returns
`sees_overheads = false` and a **null** net, `fn_overhead_summary` returns no rows, the Overheads tab
is not rendered, and the CSV omits both overhead sections. **supervisor:** nothing, as with every
money module. All of it at RLS on `company_expenses` and inside the functions, not in the UI — the
tab-hiding and the "restricted for your role" panel only spare a PM a screen that would tell them
they can't see it.

`npx tsc -b --force` clean.

**Run migration 040 before testing.**

---

## Session — overhead headings become a founder-managed list, migration 041

Two questions from the founder: can headings be added manually, and are overheads counted inside
projects or separately.

**Answer to the second, for the record:** completely separately. Nothing in 040/041 touches
`expenses`, `v_project_pnl`, budget vs actual, portfolio spend or the dashboard cards — no project
carries a share of the rent. The two meet in exactly one place, `fn_company_net`:
Σ project gross margins (lifetime) − company overheads (period) = net position. Apportioning
overheads across projects would be a different feature, and only worth building if the CA asks.

**The first became migration 041.** 040 had argued for an enum because a lookup table invites
someone to "just add one" mid-month and split a year's reporting in two. That argument was about
WHO can add one, not about whether the list may change — and it is the founder's firm.

- [x] **Migration 041** — `overhead_categories` (name, slug on the 12 seeds only, active,
      sort_order), `company_expenses.category` → `category_id`, `fn_delete_overhead_category`,
      `fn_overhead_summary` re-created grouped by heading id, `fn_duplicate_overheads` carrying the
      new column. `fn_company_net` untouched: it sums amounts and never looked at the heading.
- [x] Founder-only **Manage headings** panel on the Overheads screen — rename, retire, restore,
      delete — plus a **+ Add a new heading** link inline in the entry form.
- [x] Accounts picks from the list and cannot change it; the panel and the link are hidden, and
      RLS refuses the write regardless.

### The three guards that make a free list safe

**One editor.** Founder writes, accounts reads. The real risk was never that the list changes — it
is that TWO people change it and "Internet" and "Office utilities" become two series nobody can
compare.

**Normalised uniqueness.** A unique index on `lower(btrim(name))`, because case and a trailing space
are the two ways a duplicate heading actually gets created. The form translates the constraint
violation into "a heading with that name already exists — pick it from the list."

**Retire, not delete.** Entries reference the heading by id, so a rename corrects history rather
than forking it, and retiring hides a heading from new entries while every past month reports
exactly as before. `fn_delete_overhead_category` permits a true delete only where nothing has ever
pointed at the heading — the typo you made a minute ago — and otherwise refuses with the count.
Voided entries count as history too: a voided row still has to be able to say what it was for.

Its own delete RPC rather than a `fn_delete_record` branch, for the same reason
`fn_void_company_expense` is its own function: every branch in that dispatcher resolves a project
and calls `is_member()`, and a heading has no project.

The enum→table step is guarded on the old column still existing and runs as dynamic SQL, so a second
run is a no-op rather than a plan-time failure on a column that is gone.

`npx tsc -b --force` clean.

**Run migration 041 before testing.**

---

## Session — B1 Schedule + Earned Value (Module 02), migration 042

Confirmed at start: **001–041 ALL APPLIED**, next = 042.

- [x] **Migration 042** — `schedule_activities`, `activity_dependencies`, `activity_id` on
      tasks/expenses/ra_bills, and six functions: `fn_activity_dep_check` (trigger),
      `fn_set_activity_progress`, `fn_activity_float`, `fn_activity_evm`, `fn_project_evm`,
      `fn_delete_activity`.
- [x] `src/lib/queries/schedule.ts`, `src/pages/tasks/Schedule.tsx`, a Schedule tab in TasksLayout,
      index bands and the plain-English verdict in `src/lib/format.ts`.
- [x] Optional **Schedule activity** picker on the expense form and the RA bill form — without a way
      to tag cost to an activity, AC is permanently zero and the whole module reports nothing.

### The design problem, and how it is solved

**One table, two audiences.** The programme is for everyone on the project — a schedule nobody on
site can read is a schedule nobody follows. Its money is not. Rather than two tables kept in step,
`budget_amount` is REVOKED from `authenticated` (the 010 pattern) and granted back nowhere; every
figure derived from it — PV, EV, AC, CPI, EAC — lives behind owner-run functions that gate on
`my_role() in ('founder','pm','accounts')` in their WHERE clause. A supervisor selecting the table
gets dates, sequence and % complete, and `fn_activity_evm` returns them zero rows, so there is no
cost figure on their screen at all — not even a blank one to wonder about.

**The corollary that nearly bit.** A column grant is table-wide for the role. Any UPDATE policy
permissive enough to let a supervisor set `pct_complete` would also let them set `budget_amount`. So
the UPDATE policy is founder/PM only and `fn_set_activity_progress` is the supervisor's way in — it
writes exactly three columns and cannot be argued into writing a fourth.

**Cycles are refused, not survived.** The dependency trigger walks forward from the successor and
refuses any link that leads back to the predecessor. A cycle makes the critical path meaningless and
the forward pass non-terminating, and there is no sensible way to render one — far better to refuse
the edit while the person still remembers what they meant.

**Every ratio is nullable.** PV = 0 (not started), AC = 0 (nothing spent) and EV = 0 with money
spent are all real states with no defined index. They return NULL, the UI prints "n/a", and nothing
computes with a null downstream. Being "infinitely ahead" of a plan that expected nothing is not a
finding, and a screen showing ∞ would be worse than one admitting it doesn't know.

**Roll-up from the sums, never from the indices.** `fn_project_evm` sums BAC, PV, EV and AC and then
divides. Averaging the per-activity SPIs would weight a ₹5,000 activity the same as a ₹50 lakh one
and produce a number that looks reasonable and is wrong. Project % complete is EV/BAC for the same
reason.

**Straight-line PV, and said out loud.** Planned value spreads evenly across each activity's dates.
Nothing here models a resource curve, and the footnote on the screen says so — false precision in an
S-curve nobody entered would be worse than an honest straight line.

### Two Postgres traps hit on the way

**RETURNS TABLE names are in scope in a SQL function body.** `fn_activity_evm` returns columns
called `pv`, `ev`, `ac`, `bac`, `code`, `name`, all of which are also CTE column names — a bare
mention is ambiguous between the output parameter and the column. Every reference in both EVM
functions is table-qualified for that reason.

**Recursion belongs in a flat WITH RECURSIVE list.** The CPM passes were first written as
`with recursive` blocks nested inside ordinary CTEs. Legal, but fragile; they are now side by side
in one flat list, which is plainer and provably valid.

### Access

founder / PM / accounts: full EVM. **supervisor:** the programme, the critical path, float and their
own progress updates — and no AC, CPI, CV or EAC anywhere, enforced by the column grant and the
function gates rather than by hiding a card. **The supervisor RLS test must be re-run** against
/tasks/schedule before this is ticked.

`npx tsc -b --force` clean.

**Run migration 042 before testing.**

---

## Session addendum — the programme is generated, not typed (still migration 042)

042 had not been run yet, so this went into the same migration rather than a 043.

The first cut expected someone to type thirty-odd activities before a project started. Nobody does
that, which means nobody would have had a programme at all. Now: **start date, handover date,
floors, plot area → the entire work-breakdown structure.**

- [x] `fn_schedule_template(floors)` — the firm's method as a function, not a table. A table would
      invite someone to edit it mid-project and change what "generate" means between two projects
      that ought to be comparable. Departing from the method is done by editing the GENERATED
      schedule, which is ordinary rows the moment it exists.
      22 fixed activities plus a four-activity cycle per floor: mobilisation, substructure, columns
      / slab shuttering + rebar / slab concreting / blockwork per floor, roof, services, finishes,
      external works, handover. Activities marked `par` run alongside the one before them (external
      plaster beside internal, plumbing beside electrical) and therefore carry float rather than
      sitting on the critical path.
- [x] `fn_generate_schedule(project, start, end, floors, plot_area, replace)` — durations scaled,
      chain laid out, dependencies drawn, `projects.floors` / `plot_area_sqft` recorded.
- [x] `projects.floors` and `plot_area_sqft` added **with their column grant** — 010 revoked SELECT
      on projects, so a new column is invisible until it is named. Two statements, never one.
- [x] Entry points: the Admin project-creation form (all four fields or none — three of four would
      silently skip generation and a founder who filled in three would reasonably expect a
      programme), and a generator that IS the empty state on the Schedule tab, for the four projects
      already running.

### Decisions

**Scale to fit, and say when it's tight.** Durations come from the size factors, then one scale
factor lands the chain on the requested handover date. `compression` = target ÷ natural comes back
with the result; below 0.7 the toast says the build normally runs about N months and you have
allowed M, and that every duration was compressed. It still generates — the founder sets the dates,
not the database — but a programme that silently squashed 18 months into 10 and presented itself as
a plan would be the most damaging thing this module could produce.

**Square roots, not ratios.** Four times the plot is about twice the time; more of the work happens
in parallel across a bigger face. 2400 sqft (a 30×80 site) is the reference. Groundworks and
structure scale with the footprint, finishes and services with total built-up area.

**Natural length is measured by dry-running the real layout.** Summing the non-parallel durations
was out by about a week, because a parallel branch outlasting the activity beside it pushes the
cursor on and a plain sum cannot see that. The generator walks its own algorithm once at scale 1 to
measure, then again for real. Whole-day rounding still leaves a few days either way, so the handover
activity is stretched to end exactly on the target date.

**Budgets stay at zero.** An auto-split by typical residential percentages would produce SPI and CPI
figures that look authoritative and are guesses. Earned value stays silent until someone sets the
BACs, which is the honest state.

**Regenerating is guarded twice.** Refused outright if activities exist; refused even with `replace`
if any live expense or certified bill is tagged to them — the money would survive with a null
activity and drop out of earned value with nothing to show why.

Verified offline against six size/duration combinations: a 2400 sqft G+1 comes out at ~12 months
natural, 6000 sqft G+2 at ~23 months, and the compression figure flags the absurd cases.

`npx tsc -b --force` clean.

**Run migration 042 before testing.**

---

## Session addendum 2 — micro schedule, not macro (still migration 042)

042 is still unapplied, so this went into the same file again.

The first generator produced ~30 macro lines. A line reading "Superstructure — 90 days" cannot be
marked 40% complete honestly, cannot say which trade is holding the job up, and cannot carry a
budget anyone believes. So `fn_schedule_template` now breaks the build down to the level a site
engineer actually works at.

**76 fixed activities plus 22 per floor — about 120 for a G+1, 142 for a G+2.**

A slab is no longer one row. It is: staging and props · shuttering and decking · beam reinforcement ·
slab main reinforcement · distribution steel and cover blocks · electrical conduits in slab ·
plumbing sleeves and cutouts · pre-pour checks and level marking · concreting · curing ·
deshuttering and prop removal. Columns get marking, reinforcement, shuttering, concreting,
deshuttering-and-curing. Masonry gets external walls, internal partitions, frame fixing, lintels and
sunshades, chasing, curing.

Substructure runs excavation → anti-termite → PCC → footing steel → footing shuttering → pour →
curing → starter bars → pedestal → backfill → plinth beam steel → shuttering → pour → plinth filling
→ ground floor bed. Services split electrical conduiting, wiring pulling, DB and earthing, water
lines, drainage stacks, pressure testing, HVAC piping, duct framing, low voltage, solar. Finishes run
through plastering, curing, wet-area waterproofing and its ponding test, wall tiling, flooring,
staircase, kitchen counter, false ceiling, putty and primer, shutters, glazing, wardrobes, final
paint, then fixtures and fittings. Handover includes the electrical load test, the plumbing flow
test, HVAC commissioning, deep cleaning, snag list, rectification, client inspection, as-builts.

### What that forced

**A `phase` column, purely for reading.** 120 flat cards is a wall nobody scrolls. Activities carry
a phase label — Mobilisation, Substructure, "Superstructure — Ground floor" (one per floor, so each
collapses on its own), Roof and terrace, Services rough-in, Finishes, External works, Testing and
handover — and the screen groups by it. **It is NOT a parent row.** Every activity is a leaf, so
nothing double-counts in earned value; summary rows would have been the obvious move and the wrong
one. Column-granted like everything else on that table (the 027 lesson: a new column is invisible
until it is named).

**Sections open at the work in hand.** The phase containing today is expanded on load, the rest are
shut. Headers count finished activities — "14 of 22 done" — rather than averaging percentages across
activities of wildly different size, which would be a number that looks meaningful and isn't.

**The Gantt scrolls in both axes** and its rows are 18px, so 140 activities don't bury the rest of
the page. Capped at 60vh.

**Manually added activities can join a phase**, via a picker of the phases already on the project.
Otherwise every hand-added row lands alone under "Other activities" at the bottom, which is where a
generated programme starts diverging from the real one.

### Durations, re-checked

2400 sqft G+1 → 120 activities, natural length ~15 months. 6000 sqft G+2 → 142 activities, ~29
months. 1500 sqft single floor → 98 activities, ~9 months. Those are the *natural* lengths; the
generator still scales everything to land on the founder's handover date and reports the compression
it applied.

`npx tsc -b --force` clean.

**Run migration 042 before testing.**

---

## Fix during 042 testing — `create table if not exists` skipped a later column

The founder ran an earlier cut of 042, then re-ran the file after the micro-schedule rewrite added
`schedule_activities.phase`. `create table if not exists` is a no-op on an existing table, so the
column was never created, and the script aborted at the column grant that names it:

    ERROR: 42703: column "phase" of relation "schedule_activities" does not exist

Everything above the grant had already run; nothing below it — the audit triggers, the progress RPC,
the CPM pass, both EVM functions, the template and the generator — existed at all.

**Fix:** an explicit `alter table public.schedule_activities add column if not exists phase text;`
immediately after the create block, and re-run the whole file.

**The lesson, now in CLAUDE.md:** a create block stops being the source of truth the moment the
table exists anywhere. Any column added to a table after its `create` first shipped needs its own
`add column if not exists`, even though the create statement above it already lists the column.
Same family as the 027 trap where a new column on a column-granted table needs a second statement.

---

## Session addendum 3 — the programme exports to Excel (no migration)

Asked for "automatically update in an Excel sheet, or export — you suggest". Export, and here is why
the other one was not built:

**A live-linked workbook would need database credentials inside the file.** Power Query against
PostgREST means the anon key and a long-lived token sit in a .xlsx that then gets emailed to a
client, a consultant, the CA. Worse, the money columns on this module are role-gated — a supervisor
gets no cost figures — and **a shared spreadsheet has no role**. The moment the programme lives in a
file that refreshes itself, the whole 042 access model is bypassed by anyone holding the file. The
export instead is built from the rows already on screen, so it inherits whatever the person opening
it was entitled to see, and it is regenerated fresh on every tap rather than going stale.

- [x] **`src/lib/xlsx.ts`** — a small .xlsx writer with **no new dependency**. An xlsx is a zip of
      XML and jszip has been in the project since the handover archive, so this costs nothing
      against roughly a megabyte for SheetJS or ExcelJS. Typed cells, column widths, a frozen bold
      header, autofilter, one sheet per concern.
- [x] **Export to Excel** on the Schedule screen — three sheets: *Schedule* (phase, code, activity,
      planned and actual dates, duration, % complete, float, critical flag, and for founder/PM/
      accounts the full EVM columns), *Earned value* (the project roll-up plus the plain-English
      read), *Sequence* (every finish-to-start link with its lag).

### Why xlsx rather than another CSV

A CSV has no types. A 120-row programme opens with dates as text — so they sort alphabetically,
01-Apr before 02-Jan — percentages as bare numbers and rupee figures Excel may or may not decide are
numeric. For a sheet somebody is going to filter and sort, that is the difference between a working
document and a wall of strings. So: dates as Excel serials with a `dd-mmm-yyyy` format, money as
`#,##,##0.00` (Indian grouping — 12,34,567.00, not 1,234,567.00), percent as `0.0"%"`, integers as
`#,##0`.

An undefined index writes the literal **"n/a"**, never 0. A zero in a CPI column is a finding; a
blank denominator is not, and the sheet must not blur the two.

### Verified, not assumed

Generated a workbook through the real code path with tsx, then opened it with openpyxl under
`warnings.simplefilter('error')`: both sheets present, dates round-trip as real datetimes carrying
the date format, rupees carrying Indian grouping, freeze pane at A2, autofilter A1:I1, column widths
applied, `&` and `<` in an activity name surviving escaping, and no warnings at all. Added
`<cellStyles>` and `createFolders: false` to clear the two things a strict reader did complain
about.

`npx tsc -b --force` clean.

---

## Addendum 4 — the Gantt goes into the workbook too (no migration)

"The graph is not exported" — correct, the first cut wrote rows only.

The chart is now its own **Gantt** sheet, drawn out of **filled cells**, one column per week.

**Not a picture of the on-screen chart, deliberately.** A PNG in a spreadsheet is a screenshot: it
does not print at the right size, cannot be re-sorted, and is stale the moment a date moves. Filled
cells are native Excel — the bar prints, survives a column being widened, and a planner can drag it.

**A week per column, not a day.** A 15-month programme is 65 week columns or 456 day columns. Excel
copes with either; a person does not. Weeks start on the project's first day rather than on a
Monday, so the grid lines up with the programme instead of with a calendar nobody set.

Each bar reads the same as the screen: the completed portion solid brass, the remainder in the pale
tint, and both in danger red when the activity is on the critical path. The header cell for the week
containing today is filled green — a spreadsheet has no vertical lines, so the marker goes in the
header. A legend sits two rows below the bars, because otherwise the colours are decoration.

Code, activity, start and finish are frozen on the left alongside the header row, which is what
makes 65 columns of bars readable at all.

### Writer changes

`XlsxCell` can now be `{ v, fill }` as well as a plain value, with five named fills mapped to style
indices; `XlsxColumn` gained `headerFill`; `XlsxSheet` gained `freezeCols`. A filled cell with no
value still emits — that IS the Gantt.

### Verified

Generated through the real code path and read back with openpyxl under
`warnings.simplefilter('error')`: freeze pane at E2 (four label columns plus the header row), header
fills correct including the green today marker, bar fills landing in the right cells with the right
colours (`FFA67C52` brass done, `FFE4DFD8` remaining, `FF9B3D3D` / `FFEFD9D9` critical), and dates
still typed. Re-checked the Schedule sheet to confirm no regression — it still freezes at A2 with its
autofilter intact.

`npx tsc -b --force` clean.

---

## Addendum 5 — re-tagging cost to an activity, without voiding (still 042)

Found while answering "how do I edit earned value". The answer is that you don't — every EVM figure
is derived, so you change one of its four inputs. But one input had no edit path at all: **an
expense or bill tagged to the wrong activity could only be fixed by voiding and re-entering.**

That is the wrong remedy. A wrong tag is a FILING error, not a money error — no total on the ledger,
the P&L or the dashboard moves when it changes. Only earned value moves, and only to become correct.
Voiding would stamp VOID on a payment that was fine and leave the audit log implying otherwise.

- [x] `fn_retag_expense(expense, activity)` and `fn_retag_ra_bill(bill, activity)` — founder / PM /
      accounts, member of the project, security definer.
- [x] An **Activity** picker on every live ledger row and on every bill that isn't cancelled.
- [x] `v_ra_bill_totals` re-created with `activity_id` — the bill list reads the view, never the
      table, so the column had to reach the screen through it. Reproduced whole from 032 with one
      line added and nothing else changed (`create or replace view` cannot add a column, so
      drop-then-create; nothing in SQL depends on it).

### Why an RPC and not just an UPDATE policy

`exp_update` (002) already allows a founder — or the row's own author — to write ANY column on
`expenses`, including `amount`. There is simply no UI that does. Adding a re-tag control that used a
direct update would have made that screen a back door to editing a figure. The RPC writes exactly
`activity_id` and cannot be argued into writing a second column.

### The guard that matters

**Same project.** Tagging a Whitefield expense to an Indiranagar activity would quietly move cost
between two projects' earned value while both P&Ls stayed correct — a discrepancy that takes a day
to find and points at nothing. The function refuses it by name.

Also refused: re-tagging a voided expense (it counts for nothing, so its tag is meaningless) and a
cancelled bill. Re-tagging a CERTIFIED bill is allowed on purpose — 032 freezes the bill's *value*,
and the activity tag is not a value; a certified bill measured against the wrong line is exactly
what needs correcting.

`npx tsc -b --force` clean.

**Run migration 042 before testing** (still the only pending one — it now also drops and recreates
`v_ra_bill_totals`).

---

## Migration 042 APPLIED — 2026-08-11

Confirmed working by the founder after the `phase` column fix. **001–042 all applied.** Nothing
pending.

B1 stays **[~]**, not [x]. Generation works; the parts that protect the money and the parts that
refuse bad input have not been exercised. What remains before it can be ticked:

1. **Supervisor incognito pass on /tasks/schedule.** The programme, phases, critical path, float and
   the progress box must all be there, and there must be NO budget, PV, EV, AC, SV, CV, SPI, CPI or
   EAC anywhere — no EVM card, no per-activity SPI/CPI, no Cost button, and no cost columns in their
   Excel export. Confirm a supervisor can still move % complete (it goes through
   `fn_set_activity_progress`, which writes three columns and cannot reach the budget).
2. **The refusals.** Generate twice on the same project (must refuse, naming the activity count);
   tag an expense to an activity, then Rebuild (must refuse, naming the expense); draw A→B then B→A
   (must refuse as a loop).
3. **One EVM reading checked by hand.** Set a budget on an activity, mark it part complete, tag one
   expense to it, and confirm PV/EV/AC and the two indices against a manual calculation. The
   arithmetic is the thing worth doubting, not the plumbing.
4. **The Excel file opened in real Excel**, not just a reader — the Gantt fills, the frozen panes and
   the Indian number format.
5. **Re-tagging**: move an expense between two activities and watch AC move on both without any
   ledger or P&L figure changing.

---

## Session — B2 QA/QC (Module 17), migration 043

Confirmed at start: **001–042 ALL APPLIED**, next = 043.

- [x] **Migration 043** — five tables (`itp_templates`, `itp_template_items`, `itp_items`,
      `inspections`, `ncrs`), five enums, RLS, audit triggers on all three live tables, and eight
      functions plus a re-emitted `fn_set_activity_progress`.
- [x] `src/lib/queries/qa.ts`, `src/pages/tasks/Qa.tsx` (three tabs: inspection plan, NCRs,
      templates), `src/lib/ncrPdf.ts`, a QA tab in TasksLayout and a Quality card on Project Detail.

### The five decisions

**No fifth role.** The brief asked for "founder/PM or a QA role". `profiles.role` is the four-value
enum EVERY policy since 001 checks, and CLAUDE.md is explicit that `designation` must never become
load-bearing. A fifth value means re-auditing every policy in the database for one module. A quality
engineer gets the `pm` access role with the "Quality Engineer" job title — precisely what the
designation→role mapping exists for. Recorded in CLAUDE.md so it isn't relitigated.

**A hold point with an override is a checklist.** `fn_set_activity_progress` refuses to RAISE
progress on an activity whose predecessor carries an unsigned hold, and names the point in the
refusal so the way out is obvious. There is no bypass. What it blocks is RECORDING, not the work —
the app cannot stop a pour, but it can refuse to accept a claim of progress past an unsigned hold.
Reducing progress stays allowed, or the block would prevent correcting a mistake.

**One act, one transaction, one code path.** `fn_record_inspection` writes the inspection, moves the
ITP status AND raises the NCR. `inspections` has no INSERT policy at all, so that function is the
only way an inspection can come into existence — a second path would eventually produce a failed
inspection whose NCR was never raised, which is exactly how a defect gets forgotten.

**Supervisors request, they do not sign off.** Not distrust: an inspection record IS the approval,
the row somebody points at in two years when a slab cracks. `fn_request_inspection` makes the
request a real timestamped act against their name, visible to the PM. Same reasoning as 042's
progress RPC — a policy loose enough to let them set `status` would let them set it to `passed`.

**Templates copy, they do not link.** `fn_apply_itp_template` inserts rows and records the template
id as provenance only. Editing a template next year must never restate an inspection signed off last
year. It refuses a second application of the same template, because the duplicate would look
identical to the original until somebody signed off the wrong one. `fn_save_itp_template` runs the
other way, turning a project's worked-out plan into the firm standard.

### Smaller calls

Conditional pass raises an NCR **and** passes the point — that is what conditional means on site:
the next stage may proceed and something still has to be put right. Treating it as a fail would stop
the job; as a clean pass would lose the defect. A failed inspection writes NO signatory, because
nothing was signed off. A hold that fails auto-raises its NCR as **major**, since it stopped the
job by definition. The pass rate counts INSPECTIONS rather than current ITP status, so a point that
failed, was corrected and passed shows as one pass and one fail — counting status would hide every
defect ever fixed. `holds_blocking` counts only holds whose activity actually has a successor: a
hold on the last activity in a chain stops nothing, and reporting it as blocking would cry wolf.

`npx tsc -b --force` clean.

**Run migration 043 before testing.**

### Addendum — NCRs file to the document vault (no migration)

Asked where an NCR ends up in Docs. It didn't — the first cut only downloaded the PDF, unlike the
SI/PO/VO which file themselves. Fixed: every NCR card now has **PDF** (download) and **File to Docs**,
landing in **Docs → QC Certificates**, the folder that already existed for exactly this.

Filed **not confidential**, deliberately and for the same reason as the Site Instruction: an NCR
carries no rupee figure by design, and the people who most need to read one are the supervisor and
the trades doing the correction.

Filing is a **snapshot**, as with every other document in this app — the PDF reads as the NCR stood
when it was filed. File it again after the correction and you get a second, later copy; both stay,
which is the record. The live status is always on the QA screen.

---

## Addendum — five seeded IS-referenced ITP templates, migration 044

Asked to "fetch the inspection plan from IS standard", and for **separate templates per discipline**.

| Template | Points | Holds |
|---|---|---|
| IS — Structural / RCC | 15 | 4 |
| IS — Masonry and plaster | 9 | 3 |
| IS — Waterproofing | 7 | 4 |
| IS — Finishes | 9 | 2 |
| IS — MEP services | 12 | 6 |
| **Total** | **52** | **19** |

Separate rather than one plan, as asked: a job where a consultant owns the MEP applies the other
four and leaves that one alone. Apply several and their points sit side by side in one plan, ordered
by the sort_order bands (10xx structural, 20xx masonry, 30xx waterproofing, 40xx finishes, 50xx MEP).

### What is and is not in these templates

**Nothing is transcribed from any standard.** IS codes are copyrighted and sold by BIS. Each point
carries the standard's NUMBER and TITLE — facts, and the normal way an ITP states its basis — plus
an acceptance criterion written from scratch, phrased "as specified" or "per drawing" wherever the
actual limit lives in the code or the project specification. That is not a workaround; it is how a
working ITP reads, because the binding number is on the drawing, not in the plan. **The site
engineer still needs the firm's copies of the codes** — these points say what to check and where the
requirement comes from, not what value to accept.

**Every number and title was verified** against BIS listings and public sources on 2026-08-11:
IS 456:2000, IS 269:2015, IS 1786:2008, IS 2502:1963, IS 383:2016, IS 2386, IS 10262, IS 1199 Part
1:2018, IS 516 Part 1:2021, IS 13920:2016, IS 6313 Part 2:2022, IS 2185 Parts 1 and 3, IS 2212:1991,
IS 1905:1987, IS 1661, IS 3067:1988, IS 1346:1991, IS 2645:2003, IS 15622:2017, IS 2571:1970,
IS 2395 Part 2:1994, IS 732:2019, IS 3043, IS 2065:1983, IS 5329:1983.

**Five points carry NO standard reference** — door and window frames, shutters and hardware, false
ceilings, and the two HVAC points. Nothing was verified for them in that pass, so the field is blank
rather than guessed. A wrong IS number printed on an NCR shown to a client is worse than none.

### The hold points

Nineteen of the 52, and only where the next stage buries the evidence: reinforcement and formwork
before a pour, deshuttering, both ponding tests, the concealed-water pressure test, earthing, wall
junctions and plaster preparation, tiling setting-out, paint preparation. Everything else is a
witness or a review. A plan where everything is a hold stops being a plan and becomes an obstacle,
and site teams route around obstacles.

### Two mechanical notes

`itp_templates.created_by` is now nullable — a seeded template has no author, and `auth.uid()` is
NULL in the SQL editor so the seed would otherwise fail the NOT NULL.

Re-runnable: the template insert is `on conflict do nothing` on the normalised-name index, and the
points seed only when the template has none. A second run neither duplicates them nor overwrites a
founder's edits.

**Run migration 043 first, then 044** — 044 seeds tables that 043 creates.

### Fix — templates could not be opened

Reported: "I am not able to open the templates." Correct — `TemplatesTab` rendered each template as
a static line with its name and point count, and `fetchTemplateItems` sat in `qa.ts` with no caller.
There was no way in.

Templates are now expandable cards. Tapping one loads its points and shows, for each: the type badge
(hold / witness / review), the stage, the point, the acceptance criterion, the standard reference and
the required-by stage. Points load lazily on first open — five seeded plans hold 52 points between
them, and fetching all of them to draw five collapsed rows is work nobody asked for.

**Read-only by design.** A template is changed by applying it to a project, editing the points there
and saving it back as a new standard. Editing in place would restate plans already applied to live
jobs — the same reason `fn_apply_itp_template` copies rather than links.

A point with no verified standard now prints "No standard reference — add your own" rather than
leaving a silent gap, so the five deliberate blanks read as a decision instead of an oversight.

The empty state also now names the likely cause: if the seeded IS plans are missing, migration 044
has not been run.

---

## Session — checklist depth in QA/QC, migration 045

Additive, so it lands safely whether or not 043/044 have been run — but it needs 043's tables, so
the order is **043 → 044 → 045**.

- [x] **Migration 045** — `itp_template_checks`, `itp_checks`, `inspection_checks`, the
      `check_result` enum, `fn_inspection_checks`, `fn_apply_itp_template` and
      `fn_save_itp_template` re-emitted carrying checklists, and `fn_record_inspection` re-emitted
      with a new arity (the 043 arity is dropped first — the 035 overload trap).
- [x] **127 seeded questions across 20 of 044's points**: reinforcement, formwork, excavation,
      deshuttering, cube sampling, wall junctions, plaster preparation, masonry first course, both
      ponding tests, substrate and penetrations, tiling setting-out and bedding, paint preparation,
      the concealed-water pressure test, earthing, conduiting, insulation testing, drainage flow.
- [x] Mobile-first runner, the checklist editor on each point, the answers on each history entry,
      and the checks visible inside each template.

### The decisions

**The result is derived, not declared.** All answers pass or n/a → pass; any fail → fail, or
conditional if the inspector says so. An inspector who fails a check and then selects "pass" is
overruled by `fn_record_inspection`. The sub-answers are the evidence somebody points at in two
years; the headline is a summary of them, and **a summary that can contradict its own evidence is
worse than no summary.** The screen shows the same derivation live, so the banner never disagrees
with the outcome.

**Unanswered questions are refused.** A checklist with blanks records an interruption, not an
inspection.

**One NCR per failed check**, naming the exact question — "Failed check on 'Reinforcement before
concreting': Cover blocks of the correct thickness are fixed at the required spacing". Three
failures are three defects, each with its own correction, re-inspection and closing date. A single
lumped NCR would close the moment the easiest of them was fixed.

**The question text is snapshotted** on the answer alongside the FK to the live check. Edit or
delete the question next month and every completed inspection still reads correctly. Same family as
032's certified-bill snapshot. The FK is ON DELETE SET NULL for the same reason — removing a
question from the plan must not delete the answer somebody gave to it on site.

**N/A is not a soft pass.** A question that did not apply to this pour is a different fact from one
that was checked and found good, and the pass rate must not conflate them.

**`inspection_checks` has no write policy at all** — `fn_record_inspection` is the only writer, the
same rule 043 applied to `inspections`. An answer cannot exist without its inspection, and a failed
answer cannot exist without its NCR.

### Mobile-first, specifically

One question per full-width row, three 48px targets (Pass / Fail / N/A), the whole thing in a single
scrolling column. Tapping **Fail** opens that question's remark box automatically — the moment
somebody fails a check is the moment they have something to say about it, and that remark becomes
the NCR text. Photos attach per question, not just per inspection, so the picture sits with the
defect it shows. A progress bar counts answered questions and turns red the moment one fails.

`npx tsc -b --force` clean.

**Run migrations 043, 044 and 045 in that order before testing.**

---

## Session — the firm's own checklists, in their own format (migration 046)

The founder sent the twenty **"CHECKLIST FOR ON-SITE INSPECTION"** sheets Your Masons already uses,
with the note that the checklist should be a fill-in form where the person checking just ticks the
box next to the point. It is now exactly that.

### Getting the content out of the PDFs

`pdftotext -layout` looked right and was wrong: on a wrapped row the SL.NO sits on the middle line of
its own description block, so a line-based parser attached each fragment to the row above. A
word-coordinate pass was no better — words on one visual row differ by fractions of a point and
naive rounding split them.

The sheets have ruled table borders, so **`pdfplumber.extract_tables()`** reads them as tables and
the wrapping problem disappears. **500 questions and 59 section headings** across the 20 sheets,
verified against the source counts.

- [x] **Migration 046** — three discipline templates carrying all twenty sheets as ITP points:
      *Your Masons — Earthworks & substructure* (4), *— RCC* (12), *— Masonry & plaster* (4).
      `section` added to template checks, live checks and stored answers; `inspections.location`;
      `fn_apply_itp_template`, `fn_save_itp_template`, `fn_record_inspection` and
      `fn_inspection_checks` re-emitted to carry both.

### Decisions

**Nothing was reworded.** All 500 questions are transcribed as written — their spellings, their IS
references, their "as per drawing" phrasing, their order, their headings. An app that quietly tidies
the wording leaves the paper copy and the phone copy saying different things, and on site the paper
wins. Recorded in CLAUDE.md.

**YES / NO / N/A on screen, pass / fail / na in the database.** Their sheet reads YES / NO / N/A and
every question is phrased so YES is the compliant answer, which makes the mapping exact. Only the
labels changed. Re-cutting an enum that already has answers stored against it, to chase a caption,
would be the wrong trade.

**Sections are printed where the form prints them** — a band across the row when the heading changes:
PRE EXECUTION CHECKS, CHECKS DURING EXECUTION, POST EXECUTION CHECKS, and the BEAM / SLAB
sub-headings on the reinforcement sheets. Without them a 32-row list is a wall.

**LOCATION joins date on the header.** Project and date the app already knows; location is the field
that distinguishes two inspections of the same activity — "Block A, first floor" against "Block B,
ground floor" — and it now also becomes the NCR's area, which is where somebody looks first.

**One sheet = one ITP point.** That is what the paper form is: one activity, one list, one signature.
Reinforcement, formwork, excavation and masonry marking are hold points because the next operation
buries the evidence; concreting and the finishing trades are witness.

`npx tsc -b --force` clean.

**Run migrations 043, 044, 045 and 046 in that order before testing.**

---

## Migration 045 aborted in production — repaired by 047 (2026-08-12)

043, 044 and 046 applied. **045 failed at its last function:**

    ERROR: 42P13: cannot change return type of existing function
    HINT:  Use DROP FUNCTION fn_inspection_checks(uuid) first.

My bug. `fn_inspection_checks` was written `create or replace`, and 046 widens its return type by
one column (`section`). `create or replace` cannot change a return type at all.

### What the abort left behind

**Two arities of `fn_record_inspection`** — 046's verify block reported it, which is precisely why
that check goes into every migration that re-emits a function (the 035 lesson). With two overloads a
PostgREST call by name is ambiguous and fails at run time, so **the app could not record an
inspection at all** until one was dropped. The verify block earned its place here.

**045's 127 seeded questions never ran** — the seed block sits after the statement that failed.

### The repair

- [x] **047** — drops the 043 `(uuid,text,date,text,text[])` and 045
      `(uuid,text,date,text,text[],jsonb)` signatures, leaving 046's 7-argument one; redefines
      `fn_inspection_checks` drop-then-create at its 046 shape; re-seeds the 127 questions, skipping
      any point that already has some. Idempotent.
- [x] **045's file corrected in the repo** — `drop function if exists` before the create — so a
      rebuild from scratch never hits this.

### The lesson, now in CLAUDE.md

`create or replace function` cannot widen a return type. Any function a later migration might extend
must be drop-then-create from the start. And in a multi-statement script an abort leaves everything
before it applied and everything after it unrun — which is why the arity check belongs at the bottom
of every migration that touches a function signature.

**Run migration 047.**

### 047 applied — QA/QC schema is clean (2026-08-12)

Verified from the founder's run:

* `fn_record_inspection` → **1 arity**, `fn_inspection_checks` → **1**. The ambiguity that stopped
  inspections being recorded is gone.
* **127** questions across the five IS plans — Structural/RCC 34, Masonry 17, Waterproofing 25,
  Finishes 18, MEP 33 — which is exactly the seed 045 never reached.
* **500** across the firm's own twenty sheets — Earthworks & substructure 73, RCC 314,
  Masonry & plaster 113.
* **8 templates, 72 inspection points, 627 questions** in total.

**001–047 all applied.** B2 stays `[~]`: the schema is right, nothing has been exercised in the app
yet.

---

## Session — the ITP is replaced by inspection comments, migration 048

The founder looked at 043–047 against how Your Masons actually works and asked for something else.
The right response is to delete cleanly, not to keep the machinery "in case":

**a site walk produces OBSERVATIONS, not thirty-question forms.**

Somebody — the PM, the founder, or the client walking their own house — sees something wrong, writes
it down, photographs it, says how urgent it is, and it becomes work for a named person. That is the
whole loop. Everything else was ceremony.

### What went

`itp_templates`, `itp_template_items`, `itp_items`, `itp_checks`, `inspections`, `inspection_checks`,
four enums and nine functions — dropped outright, and with them all 8 templates, 72 points and 627
questions.

**Two real losses, named so nobody is surprised later.** The HOLD-POINT BLOCK is gone:
`fn_set_activity_progress` is re-emitted without it, because there are no hold points left to check,
so nothing now stops progress being recorded past an uninspected stage. And the 500 transcribed
questions from the firm's own sheets go with the tables — they are still in migration 046 in the
repo and can be brought back by re-running it.

### What replaced it

**Inspection comments.** Where, what is wrong, priority, photos, optionally who raised it (free text,
because a client walking their own house is not a user of this app and never will be).

**A comment has no status of its own.** The task it creates carries that, and closing the task is
the closure. Two competing status fields on one observation is how a list stops being believed.

**One act, one transaction.** `fn_raise_inspection_comment` writes the comment AND the task together,
and there is no direct-insert policy on `inspection_comments`, so a comment cannot exist without the
task that tells somebody. An observation that never reached anybody is the exact failure this
feature exists to fix.

**Priority is four levels, not five** — a scale people can hold in their head is a scale they use.
On the form it is four tap targets rather than a dropdown, because it is the field most likely to be
set one-handed while standing in the room. Only urgent and high get a badge on the task list; normal
is the default and silent, since a badge on every row is a badge on none. Urgent tasks sort first
and carry a red edge.

**NCRs stay**, untouched. A comment is an observation that becomes a task; an NCR is the formal
non-conformance with its number, corrective action and close-out — the thing you show a client or a
consultant.

**QA plan docs** is the third tab: upload a PDF straight into **Docs → QC Certificates**. No new
table — these are ordinary documents in the folder that already existed for exactly this, so a plan
uploaded here is the same file the Docs module lists. Filed not confidential: a QA plan carries no
rupee figure and the people who must work to it are the site team.

The Tasks tab is renamed **Quality**.

`npx tsc -b --force` clean.

**Run migration 048 before testing.**

### Fix — a filed NCR appeared in the QA plan list too (migration 049)

Reported: NCRs should be stored in QC Certificates and nowhere else. They were — but the QA plan
docs tab lists everything in that folder, so a filed NCR showed up in both places.

**`documents.doc_kind`**, set to `qa_plan` on upload from the QA tab and `ncr` when an NCR is filed.
The QA plan list filters on it; the NCR still lives in QC Certificates, where it belongs and where
the Docs module lists it.

**Not a title match.** Hiding anything starting "NCR-" works until somebody renames a file, or writes
a QA plan called "NCR response procedure" — then a document vanishes from a list with no way to work
out why. What a row IS should be stored, not inferred from how it happens to be spelled. The one
title match in 049 is a one-off backfill for NCRs filed before the column existed, over rows nobody
has had a chance to rename.

Open text rather than an enum: PO, SI, VO and the handover archive all file documents too and will
want labelling eventually, and an enum would mean a migration each time. NULL means "uploaded by
hand", which is what every existing row is — so they keep showing in the QA list, which is right.

`fn_qa_summary`'s QA-documents count now counts plans only.

`npx tsc -b --force` clean.

**Run migration 048, then 049.**

## Migrations 048 + 049 APPLIED — 2026-08-12

Confirmed by the founder: both ran clean and the Quality screen works.

`001–049 ALL APPLIED.` Next migration = 050. `APPLY_pending.sql` is empty again.

The structured ITP is gone from the database — 8 templates, 72 points and 627 questions deleted
along with `itp_templates`, `itp_template_items`, `itp_items`, `itp_checks`,
`itp_template_checks`, `inspections`, `inspection_checks` and nine functions. `fn_set_activity_progress`
no longer blocks on hold points, so the Schedule screen's progress control is back to
042 behaviour. What replaced it: `inspection_comments` + `fn_raise_inspection_comment`,
`tasks.priority` / `tasks.assigned_to`, `documents.doc_kind`, and a rebuilt `fn_qa_summary`.

**Still unexercised in the app** (the migrations running is not the same as the flow working):
raising a comment and watching it appear in Tasks with its priority; filing an NCR to Docs and
confirming it stays out of the QA plan list; and the supervisor pass — no delete on a comment, no
NCR close, no QA plan upload.

## Session — B3 Rate comparison / comparative statement (migration 050)

Confirmed at the start of the session: **001–049 all applied** (the founder ran 048 + 049 and the
Quality screen works). This session's migration is **050**, and it is the only pending one.

A3 already covered PR → PO → GRN → 3-way match. What it never had was the step in between: getting
two or three vendors to price the same list, laying the quotes side by side, choosing, and being
able to SHOW a client why that choice was made. That is all this is.

### Why the privacy is at the row and not the column

012 revoked `po_lines.rate` column by column, because a PO has a half site genuinely needs —
quantities, delivery dates, the material list — and a half it must not see. A rate comparison has no
such half. Every row of it exists to state what somebody would charge; strip the rates and there is
nothing left. So all four tables are gated in the RLS policy itself
(`is_member(project) and my_role() in ('founder','pm','accounts')`) and a supervisor gets **zero
rows**, not blanked cells.

The reward is that none of the column-grant traps apply here: no 027 invisible-new-column, no 042
"the create block is not the source of truth once the table exists". And because nothing is revoked,
the three views are `security_invoker = true` — RLS on the base tables IS the access control, so
there is no owner-run WHERE clause that a later edit could drop and silently leak the table.

### Everything on the screen is computed in Postgres

- `v_rc_matrix` — one row per (item, vendor). Line total, and `is_lowest` from a window function
  partitioned by item. `min()` ignores nulls, so a vendor who did not quote cannot accidentally
  become the cheapest.
- `v_rc_vendor_totals` — items quoted, items missing, subtotal, GST at each vendor's own rate,
  grand total, awarded value, and `is_lowest_total`.
- `v_rc_summary` — the card figures, including how many lines went to somebody other than the
  cheapest.

`is_lowest_total` counts **only vendors who priced every item**. A total built from eight of ten
lines is cheaper for a reason that has nothing to do with being cheap, and calling it the lowest
would be the single most misleading thing this module could do. `fn_rc_award` refuses a
whole-comparison award to such a vendor and points at the per-line award instead.

A missing quote is a **deleted row**, not a stored zero. "Did not quote" and "quoted nothing" are
different facts and only the first one should keep a vendor out of the lowest-rate comparison.

### The award is always per item

`rc_items.awarded_quote_id` is the only representation of a decision. "Award everything to Vendor B"
is a convenience that writes one row per line — not a second column recording the same fact. Two
representations eventually disagree, and the split award (steel from one vendor, cement from
another) is the normal case here anyway, so the per-line shape had to exist regardless.

### The reason is enforced in the database

`fn_rc_award` and `fn_rc_award_item` refuse an award above the lowest quote unless a reason comes
with it, and the message names the vendor, their rate and the lowest. The field is CLEARED when the
chosen quote *is* the cheapest, because a reason on the lowest rate is noise and the column means
"why not the lowest".

This is the sentence an Open Book client reads. A form-only check is a check that disappears the
first time anything talks to the API directly — same argument as the mandatory void reason in 020,
which is a CHECK constraint for exactly this reason.

### Three guard triggers, because an RLS policy cannot restrict columns

The UPDATE policy that lets somebody fix a typo in the title would also let a PostgREST PATCH stamp
`awarded_quote_id` with no reason and no audit row, or set `status` to 'decided' with nothing
awarded. That is the hole 021 found on `purchase_orders`, where the RPC alone was not enough.

The discriminator is `current_user`: PostgREST runs as `authenticated`, every RPC here is
SECURITY DEFINER and runs as the table owner. So a BEFORE UPDATE trigger refuses `status` /
`decided_*`, the four award columns, and `rc_vendors.po_id` from the client and allows them from the
functions. It RAISES rather than silently restoring the old value — a PATCH only sends changed
columns, so it fires only when somebody meant it.

### Convert to PO reuses A3 untouched

`fn_rc_to_po` raises one `purchase_orders` row per winning vendor at status `approved` with rated
`po_lines`. Receiving, the GRN trigger, the 3-way match, the PO PDF and cancellation all work on
them exactly as they do on any other PO — nothing was special-cased.

`rc_vendors.po_id` is what makes it idempotent: its presence is the refusal, so there is no separate
"already converted" flag to fall out of step with reality.

Free-text lines are **refused by name** rather than having a material invented for them.
`po_lines.material_id` is NOT NULL because a PO feeds stock through the GRN trigger and stock is
kept per material. The refusal draws a distinction worth keeping: materials are things you stock,
free text is for things you only ever price — a labour rate, a hire charge.

### It freezes once ordered

Every write policy refuses on a comparison whose status is `ordered`. It is the evidence of how that
order was decided; if the quotes could still be edited it would restate itself and stop being
evidence. Same rule as the certified-bill snapshot (032) and the snapshotted question wording (045).

No cancel mechanism, by decision. Before conversion a comparison affects nothing — no money posted,
no stock, no number in a vendor's hands — so it is a hard delete via `fn_delete_comparison`, refused
once a PO exists. After conversion the thing to cancel is the PO, which already has
`fn_cancel_document`. A third state would give two places to look for one fact.

### Screen

`/money/compare` — deliberately NOT mirrored under `/materials` the way Orders is, for the same
reason the privacy is row-level.

Two readings of the same server-computed numbers: **Lines** (one card per item, every vendor's rate
on its own row with a 48px input, awarded with one tap) and **Statement** (the real items × vendors
grid, horizontally scrolled with a sticky first column, cheapest cell tinted, grand-total footer).
The grid is not a second calculation — both read `v_rc_matrix`.

**Comparative-statement PDF** on the letterhead, LANDSCAPE because the document widens with the
vendor count and a portrait page would either clip the fourth column or shrink the type past
reading size on something somebody signs. It prints the losing quotes as prominently as the winner
— that is the point of it — bolds the cheapest cell, ticks the awarded one, and prints every "why
not the lowest" reason verbatim. Files to Docs → Purchase Orders, marked confidential (it carries
every vendor's rates), `doc_kind = 'comparative_statement'`.

`npx tsc -b --force` clean. Migration parses clean under pglast.

**Run migration 050 before testing.**

## Migration 050 APPLIED — 2026-08-12

`001–050 ALL APPLIED.` Next migration = 051. `APPLY_pending.sql` is empty again.

## Session — B4 Bar Bending Schedule per IS 2502 (migration 051)

Confirmed at the start: **001–050 all applied**. This session's migration is **051**.

This module tells a bar bender how long to cut a piece of steel. Get it wrong and either the bar is
short — a structural defect nobody sees again once the concrete is poured — or it is long, which is
money in the scrap bin. So the whole thing is arranged around being CHECKABLE rather than merely
correct.

### The constants are a table, not code

`bbs_constants` holds one labelled row per IS figure, each with its reference, units and a note:

| code | label | value | unit |
|---|---|---|---|
| bend_45 | Bend deduction — 45° | 1 | × bar dia |
| bend_90 | Bend deduction — 90° | 2 | × bar dia |
| bend_135 | Bend deduction — 135° | 3 | × bar dia |
| hook_standard | Standard hook allowance (180°) | 9 | × bar dia |
| stirrup_hook_factor | Stirrup hook — multiple of dia | 10 | × bar dia |
| stirrup_hook_min_mm | Stirrup hook — minimum | 75 | mm |
| crank_factor | Extra length per crank | 0.42 | × crank rise |
| unit_weight_divisor | Unit weight divisor | 162 | — |

A structural engineer can audit the entire engine by reading that table. Founder-only write,
audited, and `on conflict do nothing` on re-run so a deliberate change is never silently reset.

The shapes are data too: `bbs_shapes` carries leg multipliers (a rectangular stirrup is
mult_a = mult_b = 2) plus the count of 45°/90°/135° bends and of each hook type, so one row is the
whole formula for a shape.

### One implementation, answer and working together

`fn_bbs_cutting_length` returns `{cutting_length_mm, straight_mm, hooks_mm, deductions_mm, working,
warning}` in one jsonb. The arithmetic shown under each bar on screen is therefore a by-product of
the calculation rather than a second one — an explanation that can disagree with its own number is
not expressible. The live preview while typing is a server round trip on a 250 ms debounce for the
same reason: a TypeScript copy of a safety-critical formula is the copy nobody re-checks after a
constant changes.

An impossible input (a stirrup whose deductions exceed its perimeter) returns a NEGATIVE length
with a warning. It is never clamped and the row is never dropped — a schedule that quietly loses a
bad line is worse than one that shows a problem in red.

### Verified against a real PostgreSQL, not just parsed

`pip install pgserver` gives a full PostgreSQL inside the sandbox with no root. With `auth.uid()`,
`my_role()`, `is_member()`, `is_founder()` and `fn_audit()` stubbed, the migration was executed for
real. `fn_bbs_selftest()` returned **8 of 8 passing at 0.00 mm**, and a worked beam (4 no. B1, 3-Y16
+ 2-Y12 + 26 stirrups each) matched an independent Python hand-calculation exactly at 186.415 kg.

That run found two bugs a read-through and a pglast parse had both missed:

1. **`fn_audit` assumes an `id` column.** It does `coalesce(new.id::text, old.id::text)`, and
   `bbs_constants` / `bbs_shapes` are keyed by `code`. The trigger raised
   `record "new" has no field "id"` and ABORTED the write — so a founder editing a constant would
   have seen the edit apparently succeed with the value unchanged. Fixed with `fn_audit_by_code()`.
2. **The migration was not re-runnable.** The views depend on the two functions, so on a second run
   `drop function` was refused and the following `create function` failed with "already exists",
   leaving the OLD function in place. Fixed by moving the view drops above the function drops. The
   script now runs clean three times under `ON_ERROR_STOP=1`.

Both lessons are in CLAUDE.md.

### Access

Founder/PM author; every project member reads, including supervisors — the bar bender is the
audience and a BBS carries no rates. The brief's "site engineer creates" is met by adding a
`Structural Engineer` job title mapped to the `pm` access role: a TS-only change that can never
widen data access, which is exactly what the designation→role mapping exists for (the 043
decision, unchanged).

### Screen

`/tasks/bbs` — member cards with expandable bar marks and a per-bar "show working", a
steel-by-diameter table, an IS rules tab carrying the constants and the self-test button, and a
landscape printable BBS on the letterhead whose footer states which constants it was cut to. A
schedule that does not say its hook allowance cannot be checked a year later.

`npx tsc -b --force` clean.

**Run migration 051 before testing.**

## Addendum — callout expansion (migration 052)

Asked for: upload a structural drawing and have it read out the schedule automatically.

**What was built instead, and why.** Extracting reinforcement from a drawing image needs a vision
model. It would be confidently wrong some of the time, it is a paid API (which the stack rules
exclude), and — the real objection — a plausible-looking bar schedule that nobody checks is the
single worst artefact this module could produce, because the error stops being visible the moment
the concrete is poured. The founder chose callout expansion over AI vision after that was put to
them; drawings here are a mixture of CAD PDFs and scans, and whether they carry schedule tables is
still to be checked.

**Callout expansion.** Record the member once — 300 × 450, 5000 long, 25 cover — then type what the
section says:

```
4-Y16 BOTTOM
2-Y12 TOP
2-Y16 CRANK
Y8 @150 STIRRUP
```

and get four bar marks with dimensions, counts, cutting lengths and weights. The machine does only
the counting and the geometry: stirrup count from the spacing, stirrup size from the section minus
cover, crank rise from depth minus cover minus the bar itself. Nothing is inferred that the
engineer did not write down.

Verified end to end on a real Postgres — that beam produces 299.490 kg across Ø8 / Ø12 / Ø16, every
figure from the 051 engine.

**Anchorage defaults to ZERO.** Development length depends on steel grade, concrete grade, bond
condition and the designer's detail, and it is on the drawing. A "sensible" default would be the
app quietly designing the joint.

**It refuses rather than guesses.** One unreadable line fails the whole expansion, naming the line:
a partial apply would leave the schedule short of steel with nothing on screen to say which bar is
missing. Ø7 is refused as not a rolled size, not rounded to 8. Confirmed in testing — a failed
apply left the four existing bars untouched.

**Re-running is safe.** The callout text is stored on the member; re-applying replaces only rows
flagged `from_callout`, so an extra bar added by hand at a support survives a correction to an
unrelated line.

**The parser self-test caught a real bug immediately.** `(\d+)\s*CRANK` — which reads correctly and
looks right — matches the DIAMETER in "2-Y16 CRANK", giving 16 cranks and a bar 1810 mm too long.
`fn_bbs_callout_selftest()` failed case 3 on the first run. The crank count now needs an
unambiguous form (`CRANK x2`, `CRANK(2)`) and defaults to 2.

`fn_bbs_callout_selftest()` 5/5, `fn_bbs_selftest()` still 8/8, 051+052 run clean three times under
`ON_ERROR_STOP=1`. `npx tsc -b --force` clean.

**Still open:** whether the drawings carry beam/column schedule TABLES. If they do, importing that
table from a CAD PDF is the next reliable step and is deterministic — no vision model needed.

**Run migration 051, then 052.**

## Addendum — the firm's own BBS sheet layout (migration 053)

The founder supplied their existing BBS sheet and asked for output in that format, plus the beam
number. Also asked, directly: does this read the drawing? **No — it does not, and by design.**
Nothing in the module opens a PDF or an image; the engineer types the callouts and the machine does
the counting and the geometry.

### Three things the sheet told us

**1. Their unit weights are not d²/162.** The sheet's header reads φ8 0.395, φ10 0.616, φ12 0.888,
φ16 1.579, φ20 2.466. d²/162 gives 0.3951 / 0.6173 / 0.8889 / 1.5802 / 2.4691 — matching none of
them. d²/162.2 gives 0.3946 / 0.6165 / 0.8878 / 1.5783 / 2.4661 — matching four of five at three
decimals. 162.2 is also the exact figure (π/4 × d² × 7850 = d²/162.28). The constant was moved,
guarded on the seeded 162 so a deliberate change is never overwritten, audited, reversible in one
tap.

**φ16 still differs** — their 1.579 against a computed 1.578. Their five figures do not all come
from one divisor; they look like conventional table values rounded by hand. That gap is named in
the migration header rather than papered over: 0.06%, and a per-diameter override table is a small
migration if the last gram matters.

**2. The printed factor must be the factor used.** Their sheet computes 103.6 m × 0.395 = 40.92 kg.
The app was printing 0.395 and multiplying by 0.3951 — so a checker adding a column up by hand
would have got a different number and would have been right to distrust the app.
`unit_weight_decimals` (3) now rounds the factor to what appears in the heading. With that,
the app reproduces the supplied sheet: φ8 40.922 (sheet 40.92), φ12 288.586 (sheet 288.59),
pieces 9 / 28 / 18 exactly, last bar mark 08, omitted 04 — all confirmed on a real Postgres by
rebuilding their seven rows.

**3. Pieces per 12 m length.** ceil(total length ÷ stock length), server-side, with `stock_length_m`
a constant because some suppliers deliver 11 m or 9 m. Explicitly NOT a cutting optimisation — two
4 m bars and a 5 m bar do not come out of one 12 m length without offcuts — and both the screen and
the PDF footer say so. A figure that pretended to nest would under-order.

**Last / omitted bar mark** (`fn_bbs_mark_audit`) fills the two boxes at the head of the sheet. A
gap in the sequence is usually a bar somebody deleted and forgot to re-issue. It only applies where
marks are plain numbers as on their sheet; where they are member-prefixed (B1-1) it returns null
rather than inventing a sequence out of trailing digits.

### The PDF

Rebuilt to their layout: S/No · **Member** · Bar Mark · No of bars · No of members · Shape · Length ·
Total Length, then one column per diameter carrying that bar's weight, then TOTAL (kg),
TOTAL (tonnes) and No of pieces required. The Member column is the addition they asked for — their
sheet has none, and a bar mark alone does not say which beam it belongs to.

The Shape column draws the schematic the way their sheet does — a rectangle for a stirrup, a circle
for a tie, turned-down legs with their dimensions for a U-bar, a dog-leg for a crank. Not to scale,
because a 4950 mm bar and its 150 mm hooks cannot both be readable at scale.

Rule 046 applied throughout: take the client's own form, do not improve it.

`npx tsc -b --force` clean. 051+052+053 run clean three times under `ON_ERROR_STOP=1`;
`fn_bbs_selftest()` 8/8 and `fn_bbs_callout_selftest()` 5/5 afterwards.

**Run migration 051, then 052, then 053.**

## Migrations 051 + 052 + 053 APPLIED — 2026-08-14

Confirmed by the founder: all three ran and the Bar schedule screen works.

`001–053 ALL APPLIED.` Next migration = 054. `APPLY_pending.sql` is empty again.

**Still unexercised in the app** (migrations running is not the flow working): entering a real beam
and column off a drawing, the callout panel end to end, the negative-length warning on screen, the
founder editing a constant and the self-test catching it, the sheet-format PDF against the paper
original, and the supervisor pass (schedule readable, no Add member, no callout panel, no constant
edit).

**Open for a future session:** automatic extraction from drawings. Scoped in chat — six stages, of
which only schedule generation exists. Recommended order is notes-block extraction (cover and Ld
tables) then schedule-table import, both deterministic from CAD PDFs, with vision only as a last
resort for scans and only behind a draft-and-confirm review gate. Blocked on one question: are the
firm's structural drawings text-selectable, and do they carry a notes block and a beam/column
schedule table.

## Session — B5 Contract Labour (Module 24), migration 054

Confirmed at the start: **001–053 all applied**. This session's migration is **054**.

### The decision that mattered most

Attendance × rate is an ACCRUAL — what the labour on site is worth. `v_project_pnl` computes cost
from expenses and certified RA bills — what was actually paid. Adding the accrual on top would have
counted **every rupee of labour twice**, and on most jobs labour is the largest single line. Every
project's margin would have been wrong.

So attendance does not feed the P&L. Instead:

- `fn_labour_reconcile` shows both figures and their difference — "attendance says ₹38,950 for
  August, ₹38,950 is booked".
- `fn_post_labour_expense` is a deliberate act by founder/accounts that turns a period into ordinary
  expenses. Once posted, the P&L picks it up the normal way and there is still exactly ONE source of
  cost.
- Overlapping periods are refused by `labour_postings`, not by remembering not to. Voiding an
  attendance day that has already been posted is refused too, or the two would stop agreeing.

Posting writes one expense **per schedule activity** in the period, so the `activity_id` tagging
earned value depends on survives.

### Money split at the table

`labour_attendance` is headcount and work area — every project member reads it, supervisors log it.
`labour_rates` is founder/PM/accounts only, and `v_labour_cost` / `v_labour_project_cost` are
owner-run with the role check in the WHERE clause. A supervisor gets **zero rows**, not blanked
columns. Confirmed in testing: with `my_role()` returning 'supervisor', `v_labour_cost` returned 0
rows and `fn_labour_rate` returned 0 rows, while `v_labour_attendance` still returned all 4 and the
muster roll still worked.

### Registers, named honestly

A muster roll built from gang counts is **not** the named statutory Form XVI. The three functions
are labelled EQUIVALENT and GANG LEVEL on screen and on paper. `labour_workers` (Form XIII) exists
for contractors who supply a roster. Gang counts are the primary shape because that is what a
supervisor can enter one-handed at a gate — the 048 lesson, learned by deleting a 627-question ITP.

### The site-log overlap

`site_logs` has carried `labour_mason` / `labour_helper` / `labour_other` since 001. Attendance
records the same fact in more detail. Two records of one fact will disagree, and the trusted one
will be whichever was typed last. `fn_labour_headcount_check` returns both and the variance, and the
attendance screen shows a banner when they differ. The site log was NOT changed here — doing that
silently inside a labour migration would be the wrong place for a UI decision.

### Verified on a real PostgreSQL

Three clean runs under `ON_ERROR_STOP=1`. A worked project — 14 masons at ₹850 (project+contractor
rate), 6 helpers at ₹550 with 4 h OT, 22 masons, 5 tilers at ₹900 — produced ₹38,950, matching an
independent hand calculation to the rupee. OT computed as 4 × (550 ÷ 8) × 2 = ₹550.

Rate resolution confirmed: with four rates in force for Mason, the project+contractor rate (₹850)
won on that project, and the contractor rate (₹750) won elsewhere.

All four guards confirmed firing:

| Guard | Result |
|---|---|
| Same gang twice on one day/area | refused by `labour_att_uk` |
| Post a period with a missing rate | refused, named the count |
| Post an overlapping period | refused, cited double counting |
| Void a day already posted | refused |

### Screens

`/tasks/labour` — supervisor quick entry: contractor, trade, how many present, overtime, work area.
No figures anywhere. Over-licence headcount flagged, never blocked; the app cannot send people home.

`/money/labour` — wage register (Form XVII equivalent), overtime register, rates with their four
scopes, the contractor register with licence expiry warnings, and the reconcile-and-post block.

`npx tsc -b --force` clean.

**Run migration 054 before testing.**

### Fix — the attendance screen was a dead end with no contractors

Reported: could not add a labour log. The screen was working; the flow was not. Attendance is logged
AGAINST a contractor, there were none on file, and the empty state told the founder to go to
Money → Labour — a different screen, in a different section, with no way back to what they were
doing. Accurate and useless.

Now a founder/PM/accounts user adds the contractor **where they are**: a "+ Add a new contractor"
option in the picker, and a short form asking for a name (licence number and licensed strength
optional, because they should never block recording who was on site). The new contractor is selected
automatically and the gang form continues. Same inline-create pattern the expense form already uses
for vendors.

A supervisor still cannot create one — `labour_contractors` is founder/PM/accounts at RLS — so they
get the honest version: "ask the office to add the contractor". The button is hidden rather than
shown-and-refused.

Also: the reference-table load errors are no longer swallowed. `fetchContractors` and
`fetchLabourTrades` used to `.catch(() => [])`, which made "migration 054 has not been run" look
identical to "no contractors yet". The reason is now kept and shown, naming 054 — the standing
lesson that 0 items usually means a migration that never ran.

### Addendum — labour report in History (migration 055)

Asked for: a labour report in the History section.

History → **Labour**, sitting between Site logs and Safety, sharing the same date range and export
button as everything else there. Two tables:

1. **Summary by contractor and trade** — days worked, mandays, overtime hours, peak workers in a
   day. Mandays is the figure that gets checked against a contractor's invoice.
2. **Muster roll** — the day-by-day gang detail, labelled a Form XVI *equivalent* at gang level, with
   voided entries excluded.

Export produces two files, matching the Safety section's pattern: the muster roll and the summary.

**It carries no money, deliberately.** History is readable by supervisors, and the standing property
of that screen — confirmed in the supervisor pass on 2026-08-06 — is that its CSVs hold no money
column. Wages already have a home at Money → Labour behind `fn_wage_register`, gated to money roles.
Putting them here as well would break that property AND create a second place to look for one figure.

**Why a migration for a report.** Summing mandays in the browser would have been three lines, but
rule 2 says every quantity total is computed in Postgres. A manday total is exactly that kind of
figure — it is what the wage register is read in and what somebody compares against an invoice — so
`fn_labour_effort` computes it once, server-side, with the voided-entry exclusion in the same place
as every other total in the app.

The two labour calls in History `.catch(() => [])` on purpose: labour arrived at 054/055, and the
rest of History must keep working if they have not been run. Until 055 is applied the section shows
the muster roll without the summary table rather than taking the screen down.

Verified on a real PostgreSQL: three clean runs under `ON_ERROR_STOP=1`, and a voided entry
confirmed dropping out of the roll-up (Helper's 6 mandays and 4 OT hours disappeared, Mason and
Tiler unchanged).

`npx tsc -b --force` clean.

**Run migration 055 before testing.**

### Addendum — several trades per gang in one entry

Asked for: a contractor often supplies more than one trade, so allow multiple trades when logging.

The database shape was already right and did not change. `labour_attendance` is one row per
(contractor, trade) because **wage rates are per trade** — a row that lumped masons and helpers
together could not be priced. So this is a form change only: pick the contractor once, enter counts
against as many trades as turned up, and it writes one row each. A convenience over the existing
shape, never a second representation of it (the 050 rule).

- Picking a contractor **seeds one line per trade their record says they supply**, so the common
  case is typing three numbers rather than pick-trade-type-tap-repeat. Only while nothing has been
  entered yet — re-seeding over typed counts would throw work away, and a supervisor may deliberately
  be logging a trade the contractor's record does not list.
- Overtime is per trade: masons may work late when helpers do not.
- Work area and remarks apply to the whole gang, because a contractor's trades are normally in the
  same place. Anything genuinely elsewhere gets its own entry.
- A running "24 workers across 3 trades" line, which turns red when the total exceeds the
  contractor's licensed strength.
- The same trade twice in one entry is caught in the form before it reaches the unique index.

**The insert is a single statement with an array, so it is all-or-nothing.** If one trade collides
with something already logged for that day and area, nothing is written — and the toast says so
explicitly, because a supervisor who does not know whether half of it saved will either re-enter and
double the day or skip it and lose it.

`npx tsc -b --force` clean. No migration — 055 is still the only pending one.

## Migrations 054 + 055 APPLIED — 2026-08-14

Confirmed by the founder: both ran and the labour module works end to end —
attendance entry, the multi-trade form, and History → Labour.

`001–055 ALL APPLIED.` Next migration = 056. `APPLY_pending.sql` is empty again.

**Still unexercised:** setting a wage rate and watching the wage register pick it up; posting a
period to the ledger and seeing it reach the P&L; the overlap refusal on a second post; the
site-log variance banner; and the supervisor pass (attendance visible and loggable, /money/labour
blocked, zero rows if the URL is typed, no money column in the History labour CSVs).

## Session — B7 MIS Reports & KPI Dashboard (Module 37), migration 056

Confirmed at the start: **001–055 all applied**. This session's migration is **056**, and it is
read-only — one view, four functions, no tables and no triggers.

### The access model was already there

The brief asked for founder/accounts = everything, PM = assigned projects, supervisors = nothing.
`v_project_pnl` has carried exactly that since 038:
`where is_member(p.id) and my_role() in ('founder','pm','accounts')`. And `is_member()` returns true
for a founder, true for accounts, and true for a PM's assigned projects.

So every MIS view is `security_invoker = true` sitting on top of it, and the rule lives in ONE
place. Restating it would create a second copy to drift — and a reporting screen that drifts does
not leak one row, it leaks the whole company at once. Confirmed in testing: supervisor gets 0 rows
from all five sources; a PM gets `overheads = null, sees_overheads = false` with margin intact.

### Three things the brief asked for that could not be built honestly

**"Cash position."** There is no bank balance, no receipts against issued invoices and no payment
run anywhere in Mason OS. A cash figure could only be guessed. The card says **Net position**, and
prints in words that it is project margin lifetime-to-date less overheads for the chosen period, and
that it is not cash. Two spans in one figure, both named — the 040 rule.

**"Margin trend."** That normally means margin earned per month. This app does not recognise revenue
monthly, so the series would be invented. The chart shows margin TO DATE at each month end, and the
caption says so.

**"Audit trigger."** Nothing here writes. There is no table to attach a trigger to, and the audit
trail for every number on the screen already exists on `expenses`, `ra_bills` and `budgets`.

Saying no to three items and explaining why is the honest response; building a plausible cash figure
would have been the damaging one.

### One verdict, computed once

`v_mis_projects.health` (critical / watch / ok) is computed in Postgres from margin, budget and the
EVM indices. The screen, the CSV and the board PDF all print the same verdict, so nobody can be
looking at a green project on a laptop and a red one on paper. Thresholds are the conventional index
bands already in `format.ts`, documented as a convention rather than a truth — a CPI of 0.89 is not
meaningfully worse than 0.91.

Likewise the PDF's total row comes from `fn_mis_company`, not from adding the table it just drew.
The fastest way for a dashboard to lose its reader is a headline that does not match the rows below.

### Charts, hand-built

recharts plus its d3 dependencies is ~400–500 KB on a PWA that loads on a site phone, and it arrives
styled like a consumer product. The app already hand-draws its Gantt and spend rails, so
`components/MiniChart.tsx` does the same in three components and gets the brand for free. Bar charts
anchor at zero ALWAYS; the percentage line does not, and prints its range so the slope cannot be
misread.

### Verified on a real PostgreSQL

Three clean runs under `ON_ERROR_STOP=1`. Three seeded projects gave:

| | Server | Hand check |
|---|---|---|
| Revenue | ₹25,000,000 | ₹25,000,000 |
| Cost | ₹19,200,000 | ₹19,200,000 |
| Blended margin | 23.2% | 23.2% |
| Net position | ₹5,525,000 | ₹5,525,000 |

Category percentages summed to exactly 100.0. The exception panel returned 9 rows across seven
sources, critical first. The trend returned four months with a correct cumulative curve.

`npx tsc -b --force` clean.

**Run migration 056 before testing.**

### 056 failed twice on first paste — both times a bad test fixture

`column pnl.project_name does not exist`, then `column e.expense_date does not exist`. Two different
tables, one root cause: the sandbox stubs were hand-written and did not match production.

- `v_project_pnl` selects `p.name` UNALIASED — the column is `name`. Now `pnl.name as project_name`.
- `company_expenses.spend_date`, not `expense_date` (`expense_date` is the `expenses` column). The
  overheads sum now also matches `fn_company_net`'s definition exactly — `amount + gst_amount`,
  voided excluded — rather than being a third definition of the same figure.
- The `company_expenses` alias is now `ce`. `e` meant `expenses` in three other places in the file,
  and two tables behind one letter is how the wrong column gets typed.

**The process fix, which matters more than the two lines.** The fixtures are now GENERATED from the
migrations: the harness parses `v_project_pnl`'s real 18-column select list out of 038 and
`company_expenses`' real column list out of 040, and builds the stubs from those. A checking script
also resolves every `alias.column` in 056 against the repo's real create-table statements. Re-run
after the fix: three clean runs under `ON_ERROR_STOP=1`, and this time the joins were actually
exercised —

| | Server | Hand check |
|---|---|---|
| Revenue | ₹20,000,000 | ₹20,000,000 |
| Cost | ₹12,700,000 | ₹12,700,000 |
| Blended margin | 36.5% | 36.5% |
| Overheads (Aug) | ₹271,400 | ₹271,400 |
| Net position | ₹7,028,600 | ₹7,028,600 |

Category percentages 62.2 + 23.6 + 14.2 = 100.0. PM: `overheads = null, sees_overheads = false`,
margin still visible. Supervisor: zero rows from all five sources.

**Also fixed on the screen:** `Promise.all` rejects on the first failure, so one bad query blanked
the whole MIS and reported "No projects visible" — a different and much more alarming claim than
"one panel could not load". It is `Promise.allSettled` now, each panel standing on its own, with the
failing ones named in the toast.

## Session — C1 Mason Learn (Module 11), migration 057

Confirmed at the start: **001–055 applied**. 056 was still written-but-unconfirmed, and C1 shares no
objects with it, so this was built as 057 independently.

### The brief's requirement 4 could not be built as written

"Link method statements/IS refs to QA-QC ITP items" — the ITP was DELETED in migration 048, when the
structured inspection plan was replaced by inspection comments. `itp_templates`, `itp_items`,
`inspections`, `inspection_checks` and nine functions are gone. There is nothing left to point a
foreign key at.

Put to the founder, who chose **matching on a reference instead of hard links**:

- an article carries `ref_no` (its own, MS-014) and `is_refs` (the standards it cites)
- `ncrs.standard_ref` already exists and already holds exactly that kind of string
- `fn_learn_by_ref('IS 456')` returns every article citing it

`fn_learn_normalise_ref` strips case, spaces and a trailing year, so all four of "IS 456", "is456",
"IS 456:2000" and "IS  456" resolve to the same article — verified. Nothing to maintain, nothing to
re-attach when a schedule is regenerated, and it reaches every module that records a reference
rather than the one module that got the join table.

### Ships empty

The founder also chose no seeded content. 044 seeded five IS-referenced ITP templates and 045 seeded
627 checklist questions; 048 deleted all of it. Five category labels are seeded because the module
needs shelves to put the first article on. Content nobody in the firm wrote is content nobody in the
firm trusts.

### Search

Weighted tsvectors — title and reference number at weight A, summary/tags/activity at B, body at C —
with GIN indexes and `websearch_to_tsquery`, so quoted phrases and `-exclusion` work without anyone
being told. Articles and their steps are searched through one function, with a step hit scored at
half so a header match still wins; `ts_headline` returns the highlighted extract, rendered by
splitting on the `<b>` marker into real elements rather than via `dangerouslySetInnerHTML`.

An empty query returns the most recently updated rather than nothing — a search box that punishes
you for not knowing what to type is a dead end.

### Two bugs the real-Postgres run caught

1. **`array_to_string` is STABLE, not immutable**, so the tsvector was refused as a generated column
   with "generation expression is not immutable". Confirmed by isolating each subexpression:
   `to_tsvector(regconfig, text)` and `setweight` are accepted, both array-to-text paths refused.
   Fixed with a BEFORE INSERT OR UPDATE trigger — the pre-PG12 shape, which fires on every write and
   so cannot drift any more than a generated column could.
2. **`ts_rank_cd(...) * 0.5` is double precision** while the function declares `rank real`. That
   creates cleanly and fails the first time anybody searches. Cast added to both union arms.

The second is the more instructive one: a migration that runs clean has not been tested.

### Verified

Three clean runs under `ON_ERROR_STOP=1`, then the behaviour exercised rather than assumed:

| Check | Result |
|---|---|
| Word appearing only inside a step | found, attributed `step`, snippet highlighted |
| Title hit vs step hit on the same word | 1.4 vs 0.4 — header wins |
| Quoted phrase `"cover blocks"` | matches the step |
| Negation `concrete -slab` | excludes correctly |
| `fn_learn_by_ref` across four spellings | all resolve to the same two articles |
| Publish a step-less method statement | REFUSED |
| Method statement with no activity | REFUSED (check constraint) |
| Duplicate ref differing only in case/space | REFUSED (unique index) |
| Version bump | 1 → 2 on publish, unchanged on re-publish |

`npx tsc -b --force` clean.

**Run migration 056, then 057.**

### Addendum — AI drafting for Mason Learn (migration 058 + `learn-draft` Edge Function)

Asked for: "it should fetch all the details using AI." Two decisions were put to the founder, who
chose **structure-only drafting** and **Gemini** as the provider.

#### What it does, and the line it does not cross

Give it a title or activity and Gemini proposes the STEP SEQUENCE for a method statement, where a
safety note and a QA checkpoint belong on each step, plus likely IS standards by NUMBER and likely
tags. The engineer writes every value.

It never returns a number, a tolerance, a cover figure, a curing period, a mix ratio — or a word of
clause text from any standard. Three layers enforce that, because the prompt alone is not a control:

1. **The response schema has no field for a value.** Structural, not advisory.
2. **The prompt forbids it explicitly** and instructs `___` where a number belongs.
3. **A scrub pass on the way out** replaces anything still matching a quantity pattern
   ("25 mm", "7 days", "M25", "1:1.5:3", "150 c/c") with `___`, and filters IS refs down to bare
   standard numbers, dropping anything else.

Two reasons for that line, and the second matters more. IS codes are copyrighted and sold by BIS, so
reproducing clause text is theft. And a hallucinated cover value, sitting in the firm's own library
under the firm's name, reaches a bar bender. A model is good at the order of work and confidently
wrong about the numbers — so it drafts the shape.

#### It needed no new safety machinery

The library already had all of it: everything lands as `draft`, drafts are invisible to supervisors
at RLS, and `fn_learn_set_status` refuses to publish a method statement with no steps. Publishing
stays the deliberate human act that says somebody checked it.

The only addition is provenance — `ai_drafted_at` and `ai_model` — because a skeleton READS like a
document, and six weeks later nobody can tell by looking whether a draft was written by the Planning
Engineer or generated in four seconds. The editor keeps the reminder on screen until it is published.

A suggestion also never overwrites typed work: summary/scope/PPE/tags are filled only where still
empty, and replacing written steps asks first.

#### The stack rule changed, deliberately

CLAUDE.md said "no paid APIs". It now records ONE exception — Gemini, reached only through the
`learn-draft` Edge Function, only for this purpose — so the rule and the code stop contradicting
each other. Anything else wanting an AI call is a new decision, not a precedent.

The key lives in the Edge Function, never the bundle (CLAUDE.md rule 1), and the caller's JWT and
role are re-verified server-side against founder/PM, matching `learn_article_write` — the same
pattern as `admin-create-user`.

**Setup before the button works:**

```
supabase secrets set GEMINI_API_KEY=...
supabase functions deploy learn-draft
```

Until then it returns a message naming the missing key rather than failing silently. Gemini Flash's
free tier is very likely to cover the firm's entire usage at four active projects.

`npx tsc -b --force` clean.

**Run migration 056, then 057, then 058.**

### Fix — the empty method statement was a dead end (second time)

Reported with a screenshot: a method statement created with no steps, Publish refusing, and no way
forward on the screen.

The refusal was correct — `fn_learn_set_status` will not publish a step-less procedure. The screen
was the problem: it stated "no steps written yet" and offered only a generic **Edit**, while the
"Draft the structure" button lives two scrolls away inside the editor. Somebody who has just created
a method statement lands exactly here, so the way forward belongs here.

- The empty-steps message is now a card with **Add the procedure** on it, plus a line saying where
  the AI drafter is and what it does.
- **Publish is disabled** when a method statement has no steps, with the reason on hover. The RPC
  still refuses — that is the boundary — but a button that always fails is just a worse error
  message.

**This is the second dead end shipped in this project**, after the labour screen telling a founder
to go to Money → Labour to add a contractor. Same shape both times: an accurate message with no
action attached. Worth checking for deliberately — any place that says "there is nothing here yet"
should also say what to do about it, for the roles that can.

### Fix — "Failed to send a request to the Edge Function" was a CORS preflight

The Draft-the-structure button failed with that message after the function was deployed and
`GEMINI_API_KEY` was set. It was never a deployment problem.

`supabase-js`'s `functions.invoke()` attaches `apikey`, `x-client-info` and
`x-supabase-api-version` on top of `authorization` and `content-type`. The function's
`Access-Control-Allow-Headers` named only the last two, so the browser failed the preflight and the
POST never left the machine. supabase-js reports a fetch that never happened as
`FunctionsFetchError` — "Failed to send a request to the Edge Function" — which reads exactly like
the function not existing, so the first two hours went into checking the deployment.

`admin-create-user` carried the identical header list and would have failed the same way the first
time anybody used it. Both fixed.

**Lesson: a client-side network failure and a missing endpoint produce the same message.** The
distinguishing test is the error CLASS, not the text — `FunctionsHttpError` means the function
answered and refused; `FunctionsFetchError` means the browser never got there, which is CORS, the
wrong project URL, or offline. Any new Edge Function copies the canonical allow-list, not a
hand-written pair.

### Fix — the real cause was gateway `verify_jwt`, not the CORS header list

Probing `https://<ref>.supabase.co/functions/v1/learn-draft` in a browser tab returned
`{"code":"UNAUTHORIZED_NO_AUTH_HEADER"}` — proof the function was deployed and that the GATEWAY was
refusing it, not the function.

`verify_jwt = true` makes the gateway demand an Authorization header before invoking the function.
A CORS preflight is sent without one by specification, so the gateway answered the OPTIONS request
401 with no CORS headers, and the browser blocked the POST that would have followed. The function's
own OPTIONS handler never ran. The widened `Access-Control-Allow-Headers` list from the previous fix
was correct and necessary, but it was never going to be reached.

Fixed by adding `supabase/config.toml` with `verify_jwt = false` on `learn-draft` and
`admin-create-user`. Both re-verify the caller server-side — Bearer token, `auth.getUser()`,
`profiles.role` — so no protection is lost; the gateway check was redundant with the function's own.
`daily-task-push` keeps it, being pg_net server-to-server with no browser involved.

**Three lessons.** (1) `verify_jwt` and browser CORS are incompatible — any function called from the
app turns it off and authenticates internally. (2) Put the setting in `config.toml`, not a
`--no-verify-jwt` flag, or a later deploy silently reinstates the bug. (3) **Probe the endpoint
before theorising.** One browser tab distinguished deployed-but-refused from never-deployed in ten
seconds, after two rounds of reasoning from a message that cannot tell those apart.

### Fix — "Gemini returned 404": the model had been retired

With the gateway and CORS out of the way the whole chain worked — browser, auth, role check, outbound
call — and Gemini itself answered 404. `gemini-2.0-flash`, chosen when 058 was written, was shut
down by Google on 1 June 2026.

Two changes:

- The model name is now `GEMINI_MODEL`, defaulting to `gemini-3.5-flash` (released May 2026, no
  announced shutdown). Deliberately NOT `gemini-2.5-flash`, which is already scheduled to go on
  16 October 2026 — migrating onto a model with a known death date two months out is not a
  migration.
- A 404 from the provider now says the model has probably been retired and names it, instead of
  printing a status code that reads like a broken URL.

**Lesson: a third-party model name is a perishable constant, so treat it like one.** It belongs in
config, not in a source file, because its expiry has nothing to do with our release cycle and the
fix should not require a deploy. And the failure it produces — a bare 404 — is indistinguishable
from a wrong endpoint, so the error message has to name the likely cause or the next person searches
their API key instead.

---

## Session — C1 part 2: library documents + text extraction (migration 059)

The brief: an upload button on Mason Learn, and the documents stored so that a later AI assistant
can answer questions FROM them rather than just linking to them.

### Built

**Migration 059** — `learn_documents`, verified on a real PostgreSQL (three clean runs under
`ON_ERROR_STOP=1`, fixtures produced by running the REAL 057 and 058 rather than hand-written stubs,
which is the 056 lesson applied).

- **One table, not two.** `article_id` is nullable: null = a document on a shelf in its own right,
  set = an attachment on that article. A standalone PDF and an attachment are the same object with a
  different owner, and two tables would have meant two search indexes, two extraction paths and two
  places for the assistant to look — which is exactly how "the bot could not find it" happens to a
  document that is plainly in the library.
- `learn_articles.attachments` (a `text[]` added by 057 and never written to, because the upload UI
  was never built) is migrated into the new table and then dropped. Two representations of one fact
  eventually disagree.
- Trigger-maintained tsvector, weights A/B/D. **The extracted body is weight D on purpose**: a
  200-page standard says "concrete" four hundred times and would otherwise outrank the one-page
  article actually titled "Concrete".
- **The index input is capped at 500k characters**; `extracted_text` itself is stored whole. A
  tsvector has a hard 1 MB limit and exceeding it raises "string is too long for tsvector", which
  would refuse the upload of exactly the large reference documents this feature exists for.
  Confirmed: a 2 MB document stores 2,080,000 characters, produces a 4 KB tsvector, and is findable.
- `fn_learn_doc_search` for the screen, `fn_learn_category_counts` extended with `document_count`
  (a shelf holding only PDFs was reading as empty), `fn_learn_by_ref` now answers with documents too.
- **`fn_learn_retrieve` — the seam for the assistant.** One call, ranked passages across articles,
  steps and documents, each carrying its source so an answer can always be traced back. Nothing
  calls it in the UI yet; it exists so that building the assistant is a function call rather than a
  project, and so vector retrieval can be substituted later without touching a caller.

**Client-side extraction** (`src/lib/pdfText.ts`) — pdf.js behind a dynamic import. Confirmed
code-split: 427 KB + a 1.26 MB worker, both lazy, neither in the main bundle.

**UI** — `LearnUpload` (shared by the shelf and the article), `LearnDocCard`, upload buttons on both
screens, documents listed as their own labelled block in search results.

### Decisions worth keeping

- **Extract at upload, not later.** A file in a bucket is opaque; every question anybody could ask
  of it needs its text. Doing it now means the document is searchable immediately with no assistant
  involved at all, and when the assistant arrives it reads a column instead of re-downloading and
  re-parsing the whole library.
- **No embeddings yet, deliberately.** Postgres FTS answers "which documents mention this" well, and
  the retrieval design is far easier to get right once there is a real corpus and real questions to
  test against. `fn_learn_retrieve` is where that swap happens.
- **A scanned PDF says so.** pdf.js correctly returns nothing for a picture of a page. That is
  recorded as `no_text` with a sentence explaining it, and shown on the card — not stored as an
  empty string that looks like a successful extraction. A library that quietly contains documents
  nobody can search is worse than one that names them. No OCR; that is its own decision.
- **Extraction never throws.** A file that could not be parsed is still filed, with the reason
  recorded. Losing the upload because a convenience failed would trade away the thing the user
  actually asked for.
- **Uploaded byte for byte, images included** — unlike the vault, which compresses images to 300 KB.
  A vault photo records that something happened; a library document is a reference somebody reads a
  figure off, and a scanned spec sheet through a JPEG quantiser is one where 8 becomes 3. Same rule
  as `uploadDrawing`.
- **RLS composes two conditions.** A document is visible if its own status allows it AND, when it
  hangs off an article, that article is visible too. The second is not redundant: without it,
  publishing a document attached to a draft method statement would leak the draft through its own
  evidence. Confirmed in testing — a supervisor sees the two published standalone documents and not
  the published document attached to a draft.
- **`fn_learn_retrieve` is `security invoker`**, so RLS decides what each caller can be answered
  from. A supervisor's question must never be answered out of a draft, and putting that gate
  anywhere else would mean a second copy of the visibility rules.
- **`ts_headline` output is split on the tags and re-emitted as React elements**, never
  `dangerouslySetInnerHTML`. The snippet now comes out of an uploaded PDF, which is not trusted
  markup.

### Guards confirmed firing

| Guard | Result |
|---|---|
| Supervisor reading a document attached to a draft article | hidden |
| Supervisor inserting a document | refused by RLS |
| Same file uploaded twice | refused by `learn_doc_path_uk` |
| Document with no shelf and no article | refused by `learn_doc_placed` |
| 2 MB extracted text | indexed, searchable, no tsvector overflow |

### Run migration 059 before testing.

---

## Session — C2 Client Approvals (migration 060)

An internal register of decisions the CLIENT made. No portal, no client login, nobody outside the
firm touches it. What it captures is what actually happens on these jobs: the owner says "yes, the
Statuario" on a site walk, work proceeds, and four months later somebody asks who approved it.

### Built

**Migration 060** — `client_approvals`, three enums, `v_client_approvals`,
`fn_set_approval_status`, `fn_project_approval_summary`, `fn_delete_approval`, guard trigger, audit
trigger. **Verified on a real PostgreSQL by running the actual 001–016 chain first**, so the
fixtures ARE the production schema rather than a hand-written approximation — which is the 056
lesson, where stubbed columns passed three clean runs and then failed twice on the founder's paste.
Three clean runs of 060 under `ON_ERROR_STOP=1`.

**UI** — register at `/tasks/approvals` (new Approvals tab), log form with evidence upload, decision
recording, and an approvals card on project detail.

### Decisions worth keeping

- **No amount column, ever.** Supervisors must read this register — they are the ones acting on
  "the client approved the sample, proceed" — and CLAUDE.md's #1 rule is that they see no figures.
  So an approval concerning money LINKS to the variation order and holds no rupee value itself,
  exactly as `site_instructions` does with `has_cost_implication`. The view LEFT JOINs
  `variation_orders`, whose own RLS excludes supervisors, so a supervisor sees the approval with the
  VO number blank and a founder sees both. **Confirmed in testing.** The money stays where its own
  policy already guards it and this module never has to know the rule.
- **The client is free text, not a row in `profiles`.** Giving them a user row — or a `client_users`
  table — would imply an account that will never exist. The register records what somebody outside
  the system said.
- **The "cannot approve what you raised" rule deliberately does NOT apply.** That rule stops
  somebody rubber-stamping their own request; here the decision was made by the client, outside the
  system, and the PM is a witness recording it. Applying it would mean the person who took the phone
  call is the one person who cannot log it — which is the entire use case.
- **So refuse to hide the weakness instead.** One person can, alone, assert the client approved
  something; that is inherent to recording an out-of-band decision and cannot be designed away. What
  can be done is not flatten it: `method` is mandatory so verbal never looks like signed, the card
  prints what each method is worth, and `fn_project_approval_summary` counts DECIDED approvals with
  no evidence attached and the project card shows that number. A register that displays a phone call
  and a countersigned sheet identically looks authoritative about something it cannot support.
- **Three nullable FKs, not `(table_name, record_id)`.** A generic pair cannot be enforced — nothing
  stops it pointing at a row that was cancelled, deleted or never existed, and no check will catch
  it. Three explicit FKs get referential integrity for one nullable column each. ON DELETE SET NULL,
  not cascade: deleting a document must not delete the record that the client approved something
  (the 031 container rule).
- **`decided_on` is separate from `created_at`.** When the client decided is not when somebody got
  round to typing it in, and it is the first one that matters when a sequence of events is
  reconstructed. The form says so rather than defaulting silently to today.
- **A BEFORE UPDATE guard on the decision columns.** An RLS UPDATE policy cannot say which columns,
  so the policy letting a PM fix a typo also lets a PATCH set `status = 'approved'` with no
  `decided_by` and no trail. Discriminated on `current_user` — PostgREST is `authenticated`, the
  RPCs are SECURITY DEFINER — and it RAISES rather than silently reverting, because a PATCH only
  sends changed columns so the trigger fires only when somebody meant it.
- **Pending deletes, decided does not.** A pending approval is a note somebody typed. A decided one
  is a record of something the client said, and deleting it destroys evidence — the fix for a
  mistake is to set it back to pending and correct it, which leaves the whole sequence in
  `audit_log`. Its own `fn_delete_approval` rather than a branch on `fn_delete_record`, following
  050: re-emitting a 300-line function to add five lines is how a transcription error ships.
- **`oldest_pending_days`, not just a count.** Three pending approvals is normal; one of them
  sitting nine weeks is what stalls a job, and a count cannot show that.

### Guards confirmed firing

| Guard | Result |
|---|---|
| Supervisor reads the register | allowed, VO number and title blank |
| Supervisor inserting an approval | refused by RLS |
| Supervisor calling `fn_set_approval_status` | refused — founder/PM only |
| PATCH setting `status` directly | refused by `ca_guard` |
| Rejection with a blank reason | refused, by RPC and by CHECK |
| Deleting a decided approval | refused, names the number and says what to do |
| Deleting a pending approval | allowed |
| Audit trail | 3 INSERT, 2 UPDATE, DELETE + DELETE_HARD, all present |

### Run migration 060 before testing.

**2026-08-21 — migrations 059 and 060 confirmed APPLIED by the founder.** Mason Learn documents
(upload + text extraction + retrieval seam) and the client approval register are both live.
APPLY_pending.sql is now empty. Next migration = 061.

---

## Session — D1 AI Photo Helper (migration 061 + `photo-analyse` Edge Function)

An optional second look at a site photo. Somebody taps **Analyse photo**, the image goes to Gemini
Flash through an Edge Function, and back comes a description plus a list of things worth checking.

### Built

**Migration 061** — `photo_analyses`, two enums, guard + touch triggers, audit trigger,
`fn_accept_photo_analysis`, `fn_dismiss_photo_analysis`, `fn_reanalyse_photo`,
`fn_photo_analysis_summary`. Verified on a real PostgreSQL with **the entire 001–060 chain as
fixtures** (three files abort only on their final `cron.job` verify line — pg_cron is not in the
sandbox — so everything above them ran). Three clean runs of 061; eleven guards confirmed firing.

**`photo-analyse` Edge Function** — reuses the existing `GEMINI_API_KEY`.

**UI** — `PhotoHelper`, wired into Snags (defect photo), Site log (saved photos) and QA inspection
comments.

### The central decision: give it nowhere to put the thing it must not say

A general vision model cannot measure a crack, judge cover, or tell shrinkage from settlement. It is
good at "there is a dark linear feature that looks like cracking" and confidently wrong about what
that means. So the restraint is structural, not just prompted:

- The table has **no severity column**. The response schema has **no** severity, measurement or
  verdict field — the model cannot return one because there is nowhere to put it.
- The column is `concerns`, not `defects`, and every concern must carry **`what_to_check`** — an
  instruction to a person. That single required field turns the whole output into a question rather
  than a finding.
- The prompt forbids measurements, verdicts and causes, and requires hedging.
- A regex scrub removes any dimension, grade or percentage that survives all of that.

Same shape as 058's method-statement drafter: let the model produce the SHAPE, never the value that
reaches a decision. There it was cover and curing days; here it is crack widths.

### Other decisions worth keeping

- **The function fetches the image as the CALLER.** The client sends a path, not bytes; the function
  downloads it with a Supabase client built from the caller's own Authorization header, so
  `site-photos` RLS decides access. The service-role key would have worked and would have made this
  an "analyse any photo in the company" endpoint.
- **The function writes the row itself**, also as the caller. If the browser did the insert, `model`
  would be a claim rather than a fact and the guard trigger freezing the analysis text would be
  guarding nothing.
- **Accepting creates a record in the acting user's name**, with the text editable on the way in and
  the severity supplied by the person. A defect report that belongs to nobody is one nobody will
  defend.
- **Opt-in per photo**, never on upload — inside the free tier, and a thing somebody chose. A unique
  index on `photo_path` stops a double tap buying a second opinion; two analyses of one picture is a
  disagreement nobody can resolve.
- **Dismissals are kept**, and `fn_photo_analysis_summary` reports the accept rate over decided rows.
  An AI feature nobody can evaluate stays switched on forever by default.
- **Supervisors are the audience.** They hold the phone in front of the wall, and there is no money
  anywhere in this feature, so nothing to hide from them. NCRs stay founder/PM, matching 043.

### Guards confirmed firing

| Guard | Result |
|---|---|
| Supervisor on another project reads it | zero rows |
| PATCH setting `status` directly | refused by `pa_guard` |
| PATCH editing the analysis text | refused — "that is what the model returned" |
| Second analysis for the same photo | refused by `photo_analysis_path_uk` |
| Supervisor raising an NCR | refused — founder/PM only |
| Accept with a blank location | refused |
| Accept an already-accepted suggestion | refused |
| Re-analyse an accepted photo | refused — the snag would lose its origin |
| Re-analyse a dismissed photo | allowed |
| Dismissed row after dismissal | kept, with the note |
| Audit trail | 2 INSERT, 2 UPDATE, 1 DELETE — the cleared analysis survives in `old_data` |

### Run migration 061 before testing.

Then `supabase functions deploy photo-analyse`. **No new API key** — `GEMINI_API_KEY` is already set
on this project for `learn-draft` and Supabase secrets are project-wide.

---

## Session — D2 Clash Detection (migration 062)

A coordination clash register: two systems in the same place, found by a person, written down so it
gets chased before it gets built over.

### Built

**Migration 062** — `clashes`, two enums, sequence, `v_clashes`, `fn_set_clash_status`,
`fn_raise_rfi_from_clash`, `fn_project_clash_summary`, `fn_delete_clash`, guard + touch triggers,
audit trigger. Verified on a real PostgreSQL with the **actual 001–060 chain as fixtures**; three
clean runs, twelve guards confirmed firing.

**Independent of 061.** It touches projects, profiles, drawings and rfis only — all from 001–029 —
so it can be applied in either order.

**UI** — `/tasks/clashes` (new Clashes tab), raise form with two systems + disciplines + grid ref +
drawing pickers + photos, status actions, ask-the-consultant flow, and `DrawingOverlay`.

### The central decision: name it after what it is

Navisworks resolves geometry — it knows two solids intersect, in what volume, at what coordinate.
This has no geometry, no models and no coordinates. It is a register of what people found.

Everything follows from that:

- No tolerance field, no auto-detection, no "clash count" presented as absolute.
- The register footer says in words: **an empty list means nobody has looked**, not that there are no
  clashes.
- The overlay carries a **permanent banner**, not a tooltip: it cannot prove a clearance and cannot
  prove the absence of a clash.
- The overlay ships **manual nudge and scale sliders** precisely because the two sheets are not
  registered to a common origin. Auto-aligning them would imply a dimensional relationship that does
  not exist; making the user line them up by eye means they know what the result is worth.

A tool that looks like clash detection and is not is worse than no tool, because somebody will trust
it. Same family as calling the MIS figure "net position" rather than cash (056).

### Other decisions worth keeping

- **Disciplines reuse `drawing_discipline` from 029.** Two enums meaning the same six things drift
  the moment somebody adds to one. Severity got its own type, because a clash severity and a snag
  severity describe different things and should be able to diverge independently.
- **The RFI is created in the same transaction as the link**, and `rfi_id` is refused from the
  client by the guard trigger. Two steps would eventually produce a clash marked "sent to the
  consultant" with no RFI behind it.
- **The RFI question gets the clash number, both systems, the location and every drawing number
  appended server-side.** The consultant's first reply is otherwise "which drawings?", and that
  round trip costs a week.
- **Verification is founder/PM, and the resolver cannot verify their own work** — enforced in the
  RPC, not just the UI. Same split as snags (027).
- **A supervisor can delete only a clash they raised themselves**, and only while open with no RFI
  attached.
- **`system_a <> system_b` is a CHECK constraint.** A clash between a thing and itself is a typo,
  and catching it at the keyboard beats discovering it in a coordination meeting three weeks later.
- **`awaiting_rfi` on the summary** counts open clashes whose question has gone out and not come
  back. Those are the ones nobody inside the firm can move — they need chasing, not assigning.

### Guards confirmed firing

| Guard | Result |
|---|---|
| Supervisor raises a clash | allowed |
| Clash between a thing and itself | refused by `clash_two_systems` |
| PATCH setting `status` directly | refused by `clash_guard` |
| Resolve with a blank account of the fix | refused |
| Supervisor verifies | refused — founder/PM only |
| Supervisor raises an RFI | refused — founder/PM only |
| PM raises the RFI from the clash | RFI written, linked, drawing refs appended |
| A second RFI on the same clash | refused, names the existing one |
| Delete a clash that has an RFI | refused |
| The resolver verifies their own work | refused, names the clash |
| A different PM verifies | allowed, resolution text kept |
| Supervisor deletes somebody else's clash | refused |
| Supervisor on another project | zero rows |
| Audit trail | 2 INSERT, 3 UPDATE, DELETE + DELETE_HARD |

### Run migration 062 before testing.

**2026-08-25 — migrations 061 and 062 confirmed APPLIED by the founder.** The AI photo helper and
the clash register are both live. APPLY_pending.sql is empty. Next migration = 063.

**Still outstanding for D1 to actually work:** `supabase functions deploy photo-analyse`, then turn
OFF Verify JWT on that function in the dashboard. No new API key — `GEMINI_API_KEY` is already set
on the project and Supabase secrets are project-wide.

---

## Session — D3 Predictive Intelligence (migration 063)

A health-signals panel: simple arithmetic over data the app already holds, turned into sentences.
No model, no training, nothing predicted.

### Built

**Migration 063** — `project_health_snapshots` (nightly, pg_cron at 22:50 IST), `health_flag_acks`,
two enums, `fn_capture_health_snapshot`, `fn_project_health_flags`, `fn_deadline_signals`,
`fn_health_trend`, `fn_ack_health_flag` / `fn_unack_health_flag`, audit trigger on the acks.
Verified on a real PostgreSQL with the **actual 001–062 chain as fixtures**; three clean runs, ten
guards firing, arithmetic hand-checked against seeded data.

**UI** — `/money/signals` (new Signals tab beside MIS), plus a signals card on project detail that
renders only when something is flagging.

### The history problem, and what I did about it

Three of the five requested signals have real history: task rollover (`tasks.rolled_from` +
`planned_date`), defect accumulation (snag/NCR created and resolved dates), and deadlines (three
alert functions already exist).

**Two do not.** `schedule_activities.pct_complete` holds one current value and EVM derives from it,
so "spend rising faster than progress" and "CPI trending below 1" **cannot be computed backwards** —
there is no historical progress figure anywhere in this database.

So those two ship as **point-in-time**, with `basis` printed on the card, and
`project_health_snapshots` starts recording nightly so the same flags can be trended from tomorrow.
No back-history was invented. Inventing one would have made every early "trend" a straight line
through a single point.

### Decisions worth keeping

- **Every flag carries `basis` and `sample_n`, and the card prints both.** A divergence measured
  once today and a slope over six readings are different claims. Trend arms refuse below three
  observations; the rollover flag additionally requires ten tasks in the window, because one
  rollover out of two is 50% and means nothing.
- **Every card shows the raw number** in the serif face next to the sentence, so a reader who thinks
  10 points is the wrong gap argues with the threshold rather than with the app.
- **Progress is weighted by activity budget.** In testing that gave 30% where a plain average of
  percentages said 25% — a plain average treats site clearance and superstructure as equals.
- **The three existing alert functions are composed, not rewritten.** `fn_compliance_alert` (028),
  `fn_bg_alert` (033) and `fn_insurance_alert` (034) already carry their own role gates; restating
  the thresholds here would put the same rule in two places.
- **A snooze expires.** 90 days maximum, no permanent dismissal. A signal that can be silenced
  forever will be. The ack is the only human act in an otherwise read-only module, which is why it
  is the only thing here with an audit trigger — auditing a nightly bookkeeping sweep would be
  auditing a log.
- **The empty state does not say "healthy."** It says these particular checks found nothing on the
  data entered. And a supervisor gets **zero rows, not zeros** — a row of zeros on a health panel
  reads as an all-clear (the 056 lesson).
- **The sweep reads base tables, not the owner-run views**, because pg_cron has no `auth.uid()` and
  every role-gated view would return nothing (the 038 lesson).

### Observed in testing, worth knowing

CPI came back **null** on the seeded project because no expense carried an `activity_id`. That is
the untagged-expense blind spot documented in `COST_RECONCILIATION_CHECKLIST.md` §4.2, showing up
honestly as "no reading" rather than as a fabricated number — and it means the CPI flag will stay
silent on any project whose spend is not tagged to activities.

### Guards confirmed firing

| Guard | Result |
|---|---|
| Supervisor reads flags | zero rows |
| Supervisor reads deadline signals | zero rows |
| Supervisor reads the snapshot table | zero rows (RLS) |
| Accounts | `cost` category only — no schedule or quality flags |
| Founder | all four flags, correct basis and sample sizes |
| Snooze for 400 days | refused — 1 to 90 only |
| Supervisor snoozes a flag | refused — founder/PM |
| Snoozed flag | disappears from the list |
| Bring it back | reappears |
| Audit on the ack | INSERT + DELETE recorded |

### Run migration 063 before testing.

It schedules a nightly pg_cron job at 22:50 IST. There will be **no trends until a few nights have
passed** — that is correct, not a fault. "Capture today's reading" on the panel takes one manually.

**2026-08-28 — migration 063 confirmed APPLIED.** Health signals live. APPLY_pending.sql is empty.
Next migration = 064.

**Groups A, B, C and D are complete — all 39 roadmap items built.** What remains is not new modules:
- Run `SUPERVISOR_RLS_CHECKLIST.md` (139 checks; §12 tests RLS directly rather than the UI).
- Run `COST_RECONCILIATION_CHECKLIST.md` (75 checks; §9 lists the nine figures that are not supposed
  to reconcile, and flags EVM BAC vs project budget as the one real unknown).
- Deploy `photo-analyse` and turn off its Verify JWT, or D1 stays unreachable.
- Long-standing: M21 petty cash has backend and no UI; `admin-create-user` never run end to end;
  `VITE_VAPID_PUBLIC_KEY` not set in the Cloudflare Worker; GST treatment unconfirmed with the CA.
- Signals need a few nights of snapshots before any trend arm fires. That is expected.

**2026-08-28 — `photo-analyse` deployed.** D1 is reachable; the AI photo helper works end to end.
Supervisor access spot-checked and behaving.

**Not yet recorded as passed:** the full `SUPERVISOR_RLS_CHECKLIST.md`, specifically §12 — the
twenty console commands that query the database directly with a supervisor's own token. Every other
section tests the UI and RLS together, so a screen that looks right has only passed the courtesy
check. §12 is the one that shows whether the data is protected or merely hidden. Until it is run,
treat the supervisor audit as partial.

---

## Session — In-app AI assistant (migration 064 + the `assistant` Edge Function)

A chat panel reachable from every screen. Answers questions about the firm's own data, answers
construction questions grounded in Mason Learn, explains the app, and drafts a small set of records
for a person to confirm.

### Built

**Migration 064** — `chat_threads`, `chat_messages`, `assistant_actions`, `assistant_usage`, three
enums, `fn_assistant_quota`, `fn_assistant_propose`, `fn_assistant_execute`, `fn_assistant_cancel`,
`fn_assistant_stats`, audit trigger on the actions. Verified on a real PostgreSQL with the whole
001–063 chain as fixtures; three clean runs, nine guards firing.

**`assistant` Edge Function** — reuses `GEMINI_API_KEY`. Streaming function-calling loop over a
whitelist (`tools.ts`), plus a hand-written app guide (`guide.ts`).

**UI** — floating launcher in `AppShell`, full-height panel, streaming render, tool chips showing
what it looked at, confirmation cards.

### The finding that changed the design

**RLS alone is not enough for an assistant.** `v_project_spend` is `security_invoker` over
`expenses`, whose RLS excludes supervisors. A supervisor selecting from it gets **one row of zeros**,
not zero rows — `sum()` over no visible rows is null and the view coalesces it. Verified against a
real database during this session.

A human never sees that, because the dashboard checks the role first and prints "restricted for your
role". A **model** sees `total_spent: 0` and answers *"nothing has been spent on Villa 12"* — a
confident lie, and considerably worse than a refusal.

So every tool declares which roles may call it, **on top of** RLS. RLS remains the boundary — it is
what stops a crafted request — and the role list stops the assistant reporting a misleading zero.
The general rule: whenever a machine reads a view that a human only reaches through a guarded
screen, check what that view returns to someone unauthorised. Zeros are the dangerous case, not
errors.

### The security model

- Every read and write runs on the **caller's own JWT**. No service-role key exists in this feature.
- The model **never writes SQL**. It picks a name from the whitelist; `runTool` maps it to one
  hard-coded query; an unrecognised name is refused before anything runs.
- Write tools **do not write**. They store a proposal and return a card. Only `fn_assistant_execute`
  inserts, and it is **SECURITY INVOKER** — so a supervisor confirming an RFI proposal is refused by
  `rfi_insert` itself, not by a role check that could drift. Confirmed in testing.
- **No code path to any financial table exists.** Five branches: task, snag, site log note, RFI,
  document note. Not a guarded branch for money — no branch at all. The prompt also forbids it, but
  the prompt is the courtesy and the missing code is the protection.
- Nothing is ever deleted, voided or modified. Every write is an INSERT of a new record.
- Rate limit runs **before** the model call. `assistant_usage` has no write policy, so only the
  SECURITY DEFINER function increments it — the thing being counted cannot reset its own counter.

### Other decisions worth keeping

- **The confirmation card renders the stored payload**, not a paraphrase, so what is shown and what
  gets inserted cannot disagree.
- **Proposals are kept whether confirmed or declined.** `fn_assistant_stats` reports the confirm
  rate — the only number that says whether this earns its API calls.
- **Conversations are private to the person who had it**, not visible to a founder. The data inside
  was already gated by RLS when it was fetched; the conversation is that person's working notes.
- **Tool calls are stored on the message**, so "why did it say that" stays answerable.
- **The app guide is hand-written prose.** Letting the model infer the app from tool names produces
  confident directions to screens that do not exist — the worst possible failure for somebody on
  site looking for a button.
- **Streaming is real**, not a typing effect over completed text: a stream containing a functionCall
  is drained, the tool runs, and a fresh stream opens with the result appended.

### Guards confirmed firing

| Guard | Result |
|---|---|
| Supervisor reading `v_project_spend` directly | **a row of zeros** — the hazard, now handled at the tool layer |
| Propose an expense | refused — not a proposable kind |
| Supervisor proposes + confirms a task | allowed, task created |
| Confirm the same proposal twice | refused |
| Supervisor confirms an RFI proposal | refused by `rfis` RLS |
| PM confirms the same RFI | allowed, RFI-0002 created |
| Founder reads a supervisor's conversation | zero threads, zero messages |
| Rate limit exceeded | refused with the daily-limit message |
| Resetting your own usage counter | `UPDATE 0` — RLS refused |

### Run migration 064 before testing.

Then `supabase functions deploy assistant`, and **turn off Verify JWT** on it in the dashboard.
**No new API key** — `GEMINI_API_KEY` is already set and Supabase secrets are project-wide.

**2026-08-28 — migration 064 applied and the `assistant` Edge Function deployed.**
APPLY_pending.sql is empty. Next migration = 065.

**Deploy note worth keeping:** the dashboard's "Create new edge function" flow starts with a single
`index.ts`, so a multi-file function fails to bundle with `Module not found ".../tools.ts"`. The two
extra files have to be added with **+ Add File**, named exactly `tools.ts` and `guide.ts` at the
same level as index.ts. `npx supabase functions deploy assistant` walks the whole directory and
avoids the problem entirely — worth preferring for any function that is more than one file.

**Fix — the assistant launcher was hidden behind the bottom nav.** It shipped with
`bottom-24 z-40 sm:bottom-6`, written on the assumption that the tab bar is mobile-only. It is not:
`AppShell`'s nav is `fixed inset-x-0 bottom-0 z-50` at every width. So on a desktop window the
button sat 24px up, underneath a 68px-tall nav with a higher z-index — faintly visible through the
`backdrop-blur`, and impossible to tap. Now `bottom-24 z-[55]` at all widths.

**Lesson: a fixed-position element needs checking against every other fixed element in the shell,
not just the one you were thinking about.** A typecheck cannot see this and neither can a lint rule;
it took reading a screenshot. Worth a deliberate look whenever something new is added with
`position: fixed`.

**Fix — the assistant's first real turn failed with `400 Function call is missing a
thought_signature`.** Gemini 2.5+ attaches a `thoughtSignature` to each `functionCall` part and
requires it echoed back unchanged on the following turn. The tool loop rebuilt the part as
`{ functionCall: part.functionCall }`, which silently dropped it — and the resulting error reads
like a malformed request rather than a lost field.

**Never reconstruct a model part; pass back exactly what arrived.** Fixed by pushing the part
verbatim, merging consecutive text chunks only where no signature is attached.

Found a second issue in the same loop while fixing it: a thinking model emits its reasoning as parts
flagged `thought: true`. Those carry text and were being streamed straight to the chat — the model's
private working-out displayed to a site engineer as if it were the answer. They are now kept for the
next turn (they carry signatures) and never sent to the browser.

**Assistant model is now `ASSISTANT_MODEL`, falling back to `GEMINI_MODEL`.** Supabase secrets are
project-wide, so setting `GEMINI_MODEL` to a Pro model would silently re-point `learn-draft` as well
— the Learn skeleton drafter does not need a reasoning model and would only cost more and run
slower. Same separation as `GEMINI_VISION_MODEL` on `photo-analyse`.

To run the assistant on Gemini 3.1 Pro:
`supabase secrets set ASSISTANT_MODEL=gemini-3.1-pro-preview`
(the bare `gemini-3.1-pro` is not found on API version v1beta — the preview id is the one).

**Gemini 3.1 Pro preview was tried and abandoned.** `gemini-3.1-pro-preview` returned 429 on the
first attempt and 503 UNAVAILABLE ("high demand") on the next — the second is Google's capacity, not
our quota. Preview Pro models carry a tiny free-tier allowance and are frequently overloaded, which
is not something a chat panel on a site phone can be built on.

Two things came out of it that are worth keeping regardless of model:
- `quotaMessage()` parses Gemini's 429 body and says whether the limit was per-minute or DAILY, with
  Google's own retry delay. "Try again in a minute" is useless advice against a daily cap.
- `callGemini()` retries 503 (and a short 429) up to three times with backoff, and retries nothing
  else — a 400 or 404 means the request is wrong and retrying it just wastes the user's time.
  Bounded at three because somebody is watching a spinner: failing in three seconds with a reason
  beats failing in thirty.

Running on `gemini-3.5-flash`. Switching models is one secret, not a deploy.

---

## Session — desktop layout, first slice (DL1 + DL2)

The founder works on a laptop; the app was built for a phone on site. Measured before changing
anything: **14 files hardcoded `max-w-lg`** (512px, ~73% of a 1900px screen unused), **1 distinct
`lg:` utility and 1 `xl:` in the whole codebase**, **112 `grid-cols-2` with only 3 responsive
variants**, and tab strips of 15 (Tasks) and 18 (Money) items scrolling horizontally.

### Built

**DL1 — one page-width rule.** `.page-w`, `.page-w-wide`, `.page-w-form` in `index.css`, replacing
`max-w-lg` in 14 files. Below `lg` they are byte-identical to what shipped, so the phone layout does
not move; desktop widths layer on above.

I first wrote this as a `<Container>` component and **deleted it**: two mechanisms for one rule is
the drift problem the exercise existed to solve, and a CSS utility is a pure class-name swap where a
component would have been a 14-file structural refactor. Runtime interpolation into a Tailwind class
was also considered and rejected — the scanner cannot see it.

**DL2 — left rail at `lg`+**, bottom tabs below. Both navigations render from the same `TABS` array
through the same role filter, so a destination cannot appear in one and not the other — which is how
a supervisor would eventually find Money on a desktop.

**PageHeader now takes a `width`.** Dashboard and ProjectDetail are `wide`; everything else is
`list`. Without it the title sat at a different left edge from the content it labels, which reads as
a broken layout rather than a choice.

### Verified

`tsc -b --force` clean. oxlint: **6 warnings before, 6 after** — checked against a stash, so nothing
new was introduced. Production build succeeds and all three utilities are present in the emitted CSS.

### Lesson

**A width rule copy-pasted into fourteen files is not a style, it is fourteen styles that happen to
agree today.** The cost only shows up when a second device appears. Anything used on every screen —
width, gutter, card padding — belongs in one place from the start, and a CSS utility is the cheapest
one-place there is: no import, no component boundary, and the change is a class name.

**Follow-up — the space was there but nothing used it.** Widening the container alone left the same
single column of cards floating in the middle of a laptop screen: more width just makes wider empty
cards. Two changes actually filled it.

- The four section layouts (`TasksLayout`, `MoneyLayout`, `DocsLayout`, `MaterialsLayout`) wrap
  every sub-page, so switching those four to `page-w-wide` widened roughly forty screens at once —
  including all the ones that carry no width class of their own and simply inherit it.
- A new `.card-grid` utility replaces `space-y-3` on all **28** card lists: a stack below `lg`,
  two columns above it. At 1024px each card gets roughly the width it was designed for, and the
  scroll halves.

`PageHeader` was widened to match on all four, or the title would sit at a different left edge from
the content it labels.

**Lesson: on a wide screen, "empty" is usually a LAYOUT problem, not a width problem.** The instinct
is to stretch the container; the actual fix is to give the content somewhere to go. Widening alone
would have made the emptiness wider.

---

## Session — motion and depth on Dashboard + Project Detail

Asked for "more attractive or interactive". That pulls against the documented aesthetic —
*restrained luxury, architect's studio, precision over decoration* — so the brief was narrowed with
the founder first: **motion and feedback** plus **richer visual depth**, on the two screens they
live in, before rolling anything outward.

### Built

**`<Figure>`** — money figures count up on first paint. The design system asks for money to "feel
important"; a number that moves holds the eye for the half-second it takes to land, which is the
same reason a printed report sets the total in a heavier face.

Three refusals inside it, all deliberate:
- It **never animates between two real values** after first render. Watching a spend figure roll
  from last month's number to this month's would imply the money moved while you watched, and
  somebody would screenshot the wrong frame. A data change snaps.
- It **does nothing under `prefers-reduced-motion`**.
- It **does not animate below ₹1,000** — counting from zero to a small number is theatre.

**`<GrowBar>`** — budget bars grow to their ratio rather than appearing at it, so an over-budget
fill visibly runs past the budget marker and the eye follows it there.

**`.card-interactive`** — 2px lift, deeper shadow, a hint of accent on the border. Hover-only
(`@media (hover: hover)`), so a phone tap does not leave a stuck hover state, and under reduced
motion the shadow still changes so the affordance survives without the movement.

Applied **only to cards that actually navigate**. A lift on a card that does nothing is a promise
the interface does not keep — on Project Detail the section cards lift only when they have an
`onAction`.

**`.card-grid-3`** — three across at 1440px. Deliberately not at 1024px, where a third column gives
each card ~330px, narrower than the phone they were designed for.

### Verified

`tsc -b --force` clean. oxlint 6 warnings, same as baseline. Build succeeds, both new utilities
present in the emitted CSS.

### Lesson

**Restraint is a design system's most expensive rule to keep, and motion is where it usually
breaks.** Every animation added here had to answer "what does this tell the reader" — the count-up
draws the eye to money, the growing bar makes overspend legible, the lift says a card is a door.
Anything that only said "look, movement" was left out, and the count-up was deliberately crippled in
three ways to stop it lying about data.

---

## Session — CLIENT role + curated client data layer (migration 065)

A fifth role. A client signs in to the same app, is tied to exactly ONE project, and reaches a small
curated surface built for them. **Data layer only — no UI this session, as asked.**

### The three things that would have leaked

**1. `is_member()` is the key to the whole building.** ~30 tables are gated on it. Had a client been
added to `project_members`, they would have inherited read on tasks, site logs, snags, RFIs,
clashes, approvals, documents, material inward, purchase orders, drawings and RA bills in one step.

Two defences: the link is a separate table (`client_projects`), **and** `is_member()` now returns
false for a client before it consults `project_members` at all. Verified by deliberately inserting
the bad row — `is_member` stayed false and every internal count stayed at zero. The second defence
is the one that matters; the first is only a convention.

**2. Fourteen policies said `using (true)`** — "any authenticated user". A client is authenticated.
Without the change they would have seen every staff profile, the whole materials master, the labour
supply chain, Mason Learn, and `project_members` — which maps every project in the company and hands
a client the project ids of your other clients to probe with. All now `is_internal()`.

**3. `invoice_type` contains `management_fee`.** "Show the client their invoices" would have told
them the fee in rupees. `v_client_invoices` returns `progress` only.

### Built

`client_projects` (one project per client, enforced by a unique constraint), `client_photos`,
`client_messages`, `documents.client_visible` (default false), `invoices.paid_on/paid_amount`,
`is_client()`, `is_internal()`, `fn_client_project()`, a hardened `is_member()`, ten `v_client_*`
views, `fn_client_decide`, `fn_record_invoice_payment`, audit triggers throughout.

Every curated view is **owner-run with `where project_id = fn_client_project()` as the access
control** — the 010/038 pattern, and it carries the same warning: losing that WHERE from any one
view is a silent total leak.

### Caught in testing

**`fn_audit` assumes an `id` column.** `client_projects` was keyed on `user_id`, so the audit trigger
raised "record new has no field id" and — because the trigger runs in the same transaction —
**aborted the write**. Granting a client access would have failed in production with an error naming
neither the table nor the function. Exactly the 051 trap. Fixed with a surrogate `id` plus a unique
constraint on `user_id`, which keeps "exactly one project" intact.

### Two things that did not exist and were added rather than faked

- **Payment status.** `invoice_status` is only ('issued','cancelled'); there is no payment tracking
  anywhere. Rather than derive a fiction, `paid_on`/`paid_amount` plus `fn_record_invoice_payment`.
  Deliberately not a payments ledger with allocations — that is its own module.
- **Photo sharing.** Photos live in a `text[]`, so a per-photo flag was impossible without a second
  index-aligned array. Publishing a photo is now its own row with an author and a timestamp.

### Verified — two clients, two projects, on a real PostgreSQL

| Check | Result |
|---|---|
| 19 internal money surfaces (expenses, budgets, POs, VOs, invoices, RA bills, retention, BGs, overheads, vendors, wage rates, rate comparisons, audit log, P&L, spend, budget-vs-actual, portfolio) | all **0** |
| 9 company-wide tables that were `using (true)` | all **0** |
| 8 project tables (schedule, tasks, site logs, documents, snags, RFIs, clashes, drawings) | all **0** |
| `profiles` | exactly **1** — their own |
| Curated views | their project only, correct data |
| Second client | sees only their own project, 0 of the first client's documents/invoices |
| Client wrongly added to `project_members` | `is_member` **false**, all counts still **0** |
| `management_fee` invoice | absent from `v_client_invoices` |
| Confidential document flagged client_visible | still hidden |

### The commercial decision, stated rather than buried

Open-book spend **plus** contract value lets a client derive gross margin by subtraction, while the
same brief says never show margin. Both cannot hold. It is implemented as asked, the contradiction
is written into the migration header and the end of `CLIENT_SECURITY_TEST.md`, and the one-line fix
is named. A commercial choice made silently inside a migration is the worst place for it to live.

### Run migration 065 before testing.

Then work through `CLIENT_SECURITY_TEST.md` — §1i (client wrongly added to project_members) is the
one that matters in three years.

**Follow-up — the client guard (CP2a).** Testing 065 with a real client account showed the data
layer working exactly as designed (every internal surface empty) but the client standing in the
wrong building: they landed on the internal Command dashboard reading "No projects yet", with a Docs
tab offering Drawings and Learn, and a card offering them a daily task reminder.

None of that leaked anything. All of it looked broken.

- **`RequireInternal` wraps the entire `<AppShell>` route**, not each screen. One insertion point,
  so every internal screen — including ones added next year by somebody who has never read 065 — is
  covered by default. A per-screen list is a list somebody forgets to add to, and the forgotten one
  is the leak.
- **`RequireClient` + `/portal`** — a deliberately near-empty holding page showing only the client's
  project name. That one fact proves `fn_client_project()` and `v_client_project` work end to end
  through a real session, and everything else needs the curated screens designed properly. The
  temptation on a holding page is to put "something useful" on it; that is how a half-built room
  nobody revisits gets made.
- **`TABS` no longer has `roles: null`.** There is no "everyone" any more — a client is
  authenticated too, and that is precisely what advertised Dashboard and Docs to them. Now
  `INTERNAL_ROLES`, as a second layer behind the guard.
- **The assistant refuses clients twice** — the launcher does not render, and the Edge Function
  returns 403. A client has no tools (none list `client`) so nothing could have leaked, but they
  would have reached Gemini on the firm's quota and got a general chatbot wearing the firm's name.

**Lesson: a component that is safe only because of where it is mounted is one move away from being
unsafe.** The assistant launcher was fine inside AppShell and would have become a client-facing
chatbot the moment somebody mounted it in a layout. The role check belongs in the component.

**2026-08-29 — migration 065 applied and confirmed live.** A real client account signs in, is
redirected to `/portal` by `RequireInternal`, and sees its own project name — proving the whole
chain end to end through a real session: JWT → `is_client()` → `fn_client_project()` → owner-run
curated view. No internal chrome reachable.

The "not linked to a project yet" state was hit first and did its job: it named the missing step
rather than showing an error, which is exactly the case it was written for (a founder creates the
account but has not linked it, and the client cannot fix it themselves).

Still to do before the portal is real: **run `CLIENT_SECURITY_TEST.md`** against the live database.
The guard is convenience; that document is the proof. §1i is the one that matters in three years.
