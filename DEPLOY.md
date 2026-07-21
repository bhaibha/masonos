# Deploying Mason OS

Phase 0 runbook: Cloudflare Pages, PWA install, and the two GitHub Actions.

> Production build verified on Windows (~1.7s, `vite preview` serves it).
> Vite's chunk-size warning is expected and safe to ignore — see
> [Chunk-size warning](#chunk-size-warning) at the bottom.

---

## 1. Push to GitHub

```bash
cd C:\Users\HP\Desktop\masonos
git init                     # if not already a repo
git add .
git commit -m "Mason OS: modules 1-5, design system, PWA, CI"
git branch -M main
git remote add origin https://github.com/<you>/masonos.git
git push -u origin main
```

`.env.local` is covered by the `*.local` rule in `.gitignore`. Confirm it isn't
staged before the first push:

```bash
git status --porcelain | findstr /i env
```

Delete the stray `.env.local.txt` if it's still there — it holds live
credentials and the gitignore rule does **not** match it.

---

## 2. Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Authorise GitHub, pick the `masonos` repo, click **Begin setup**.
3. Build settings:

   | Field | Value |
   |---|---|
   | Production branch | `main` |
   | Framework preset | `Vite` (or None) |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | *(leave blank)* |

4. **Environment variables** → add both, for **Production** *and* **Preview**:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | your anon/publishable key |

   Both come from Supabase → **Project Settings → API**.

   These are baked into the JavaScript at build time — they are **not** secret,
   and they are visible to anyone who opens devtools. That's expected: the anon
   key is designed to be public and RLS is what protects the data. Never put the
   `service_role` key here.

5. Optionally set **Node version**: add a variable `NODE_VERSION` = `22`.
6. **Save and Deploy**.

Cloudflare rebuilds on every push to `main`, and gives every pull request a
preview URL.

### Files that make routing and caching work

Both already exist in `public/` and are copied into `dist/` by the build:

- `_redirects` — `/* /index.html 200`. Without it, refreshing
  `/project/<id>` or `/money/budget` returns a 404, because those routes only
  exist inside React Router.
- `_headers` — stops `/sw.js` being cached (otherwise a deploy can never
  replace the service worker) and pins `/assets/*` for a year, which is safe
  because Vite content-hashes those filenames.

### Supabase auth redirect

Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://masonos.pages.dev` (or your custom domain)
- **Redirect URLs**: add the same, plus `https://*.masonos.pages.dev/**` if you
  want preview deploys to be able to sign in.

Email/password login works without this, but it's needed the moment you add
password reset or magic links.

---

## 3. Installing the PWA

Once deployed over HTTPS:

- **Android / Chrome** — open the site, menu → *Add to Home screen*.
- **iOS / Safari** — Share → *Add to Home Screen*. iOS ignores
  `manifest.start_url` for the first launch but respects `display: standalone`.
- **Desktop Chrome/Edge** — install icon in the address bar.

The app opens at `/dashboard` and includes shortcuts for *Add expense* and
*Daily site log* (long-press the icon on Android).

**What the service worker does and doesn't do.** It caches the app shell and
Vite's hashed assets so the UI opens instantly and survives a dead signal. It
deliberately ignores every cross-origin request, which is all of Supabase —
REST, auth and storage. Caching those would show stale money figures and could
keep signed storage URLs readable past their expiry. **This is not offline
mode**: with no connection the shell loads and the data areas show errors.
Offline write queueing is a separate Phase 5 item.

---

## 4. GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon/publishable key |
| `SUPABASE_DB_URL` | Supabase → Project Settings → **Database** → Connection string → **URI** |

### Getting `SUPABASE_DB_URL` right

This is the step that most often fails, and the failure is confusing.

1. Supabase → **Project Settings → Database → Connection string**.
2. Choose the **Session pooler** tab, not *Direct connection*.
3. Copy the URI and replace `[YOUR-PASSWORD]` with your database password.

It looks like:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

**Why the pooler and not the direct connection:** Supabase's direct database
host resolves to IPv6 only on projects created since early 2024, and
GitHub-hosted runners have no IPv6. A direct URI fails with
`could not translate host name` or a connection timeout that looks like a
firewall problem. The session pooler is reachable over IPv4 and, unlike the
*transaction* pooler on port 6543, supports the long-lived session that
`pg_dump` needs.

If your password contains `@`, `:`, `/` or `#`, percent-encode it.

---

## 5. The two workflows

Both are in `.github/workflows/` and both have `workflow_dispatch`, so you can
run them by hand from the **Actions** tab before trusting the schedule.

**`supabase-keepalive.yml`** — daily at 01:00 UTC (06:30 IST). Sends one
authenticated REST request. Free-tier Supabase pauses a project after 7 days of
no activity; a pause means the app is simply down until someone restores it.
The query returns an empty array because RLS blocks the anon role, which is
fine — the point is that the database was touched.

**`supabase-backup.yml`** — Sundays 02:00 UTC (07:30 IST). Runs `pg_dump`
inside a `postgres:17-alpine` container so the client version matches the
server, dumps the `public` and `storage` schemas with `--no-owner
--no-privileges`, gzips it, and uploads it as a 90-day artifact. It fails
loudly if the dump comes back under 2KB, which is what a "connected but got
nothing" run looks like.

Bump the `postgres:17-alpine` tag if Supabase upgrades your project's major
version — `pg_dump` refuses to run against a newer server.

### Restoring

```bash
gunzip -c masonos-2026-07-26.sql.gz | psql "<connection string>"
```

Restore into a scratch project first. A restore over a live database will
collide with existing rows.

### Why artifacts instead of committing `backups/`

A dump contains every expense, vendor phone number and document title in the
system. Anything committed to git is permanent, present in every clone, and
readable by anyone who ever gets repo access. Artifacts expire, sit behind the
same authentication, and never enter clone history.

---

## Chunk-size warning

`vite build` warns that a chunk is over 500 kB. Expected, and safe to ignore
here: it's one bundle holding React, React Router, Supabase, Motion, Sonner and
Lucide, gzipping to roughly 130–150 kB. For ~15 internal users, most of whom
install the PWA and get the shell from cache after first load, that's fine.

If it ever matters, the fix is route-level code splitting — `React.lazy()` on
the five tab layouts in `src/App.tsx` — not a bundler change.

### Verifying a build locally

```bash
npm run build
npx vite preview --port 4173
```

Open `http://localhost:4173` and confirm the dashboard actually renders, not
just that the server starts. `vite preview` serves `dist/`, so this is the same
artifact Cloudflare will publish — with one exception: `_redirects` and
`_headers` are Cloudflare-specific and are ignored by `vite preview`. Deep-link
refreshes (`/project/<id>`) will 404 locally under preview but work once
deployed.
