# ANC ERP — Production Deployment

Target: Ubuntu VPS, Node.js 22.x, PostgreSQL 18.x, Nginx, PM2, domain
`erp.alnaeemcargo.com`. This document reflects an audit of the
repository as it actually is — nothing here is aspirational.

## 1. Stack facts (verified from the repo)

- **Framework**: Next.js `16.3.0`, React `19.2.8`.
- **Package manager**: npm (`package-lock.json` present; no yarn/pnpm lockfile).
- **Build command**: `npm run build` (→ `next build`).
- **Start command**: `npm run start` (→ `next start`), or via PM2 — see `ecosystem.config.js`.
- **Prisma**: `6.16.2` (`prisma` and `@prisma/client` pinned to the same version — keep them in sync on upgrade).
- **Prisma schema**: `prisma/schema.prisma`. CLI config: `prisma.config.ts` (points at `prisma/schema.prisma` and `prisma/migrations`, loads `.env` via `dotenv/config`).
- **No `middleware.ts`** — auth is enforced per-route via `getCurrentUser()` (`lib/auth.ts`), not Next.js Edge Middleware. Nothing deployment-specific follows from this.
- **No hardcoded `localhost`/dev-only assumptions** found anywhere in `app/` or `lib/`.

## 2. Environment variables

The application code reads exactly three (verified via `grep -r process.env app lib`):

| Variable | Required | Where used | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | `lib/prisma.ts`, `prisma.config.ts` | PostgreSQL connection string. |
| `JWT_SECRET` | Yes | `lib/auth.ts`, `app/api/auth/login/route.ts` | App **throws at startup** if unset — no fallback. Rotating it logs everyone out. |
| `NODE_ENV` | Implicit | `next start` sets it; also read directly at `app/api/auth/login/route.ts:111` | See the SSL/cookie warning in §6. |

`PORT` is not read anywhere in application code, but `next start` honors it natively — set it for the PM2 process (`ecosystem.config.js` already does, default `3000`).

A template is provided at **`.env.example`** (repo root) — no real values, nothing secret. The task states production's `.env` already exists on the VPS; this repo does not create, read, or overwrite it. Confirm the existing production `.env` defines all three variables above before deploying.

## 3. ⚠️ Migration status — read this before running any Prisma command against production

**Finding, directly verified, not assumed:**

```
$ npx prisma migrate status
1 migration found in prisma/migrations
Database schema is up to date!
```

This output looks clean, but it is **not** the whole picture, and taking it at face value would be a mistake:

- `prisma/migrations/` contains **only one** migration: `20250101000000_baseline` (598 lines). It creates **15 tables**.
- The current `schema.prisma` defines **23 models**.
- The **8 models with zero migration-file coverage anywhere in the repo** (not in `prisma/migrations/`, not even in the archived ones below): `AuditLog`, `Bill`, `BillItem`, `BillSourceLink`, `BusinessSettings`, `DocumentTypeSettings`, `PrivatePhonch`, `PrivatePhonchVehicle`.
- There is also a `prisma/migrations_archive/` directory (outside Prisma's active migrations path, so the CLI never sees it) holding two further migrations — `20250823131400_replace_agent_account_with_agent_party` and `20260911035420_add_employee_payroll` — that were at some point moved **out** of the active folder.
- The live `_prisma_migrations` table in the development database lists all three migrations as applied, but with `applied_steps_count: 0` for every one of them, and in an order inconsistent with their own names/timestamps (the `_baseline` migration — named for January 2025 — shows the **latest** `finished_at` of the three). This is the signature of migrations having been marked "already applied" via `prisma migrate resolve` rather than genuinely executed in order, consistent with the schema instead being evolved live via `prisma db push` for a significant portion of its history.
- `migration_lock.toml` (normally present in `prisma/migrations/`, recording the provider) is **missing**. Not currently blocking the CLI, but another sign the migration folder's history isn't in its normal, Prisma-managed state.

**Why `migrate status` still says "up to date"**: it only checks whether every migration *file present in the folder* has a matching "applied" row in `_prisma_migrations` — it does not diff the live schema against `schema.prisma`. Against *this* development database (which already has all 23 tables, created through a mix of history), that check trivially passes. It would say the same thing after running `migrate deploy` against a **fresh, empty** production database — but in that case only the baseline's 15 tables would actually have been created, and the app would then throw/500 on any route touching Bill, AuditLog, Settings, or Private Phonch.

**I do not know production's actual current schema state** — this repo has no access to the VPS database, and the task states the production database "already exists," not whether it was ever `db push`'d to match the full current schema or stands at some earlier point. Guessing here is explicitly out of scope.

**Required action before any `prisma migrate deploy` (or any schema-altering command) touches production**: a human with access to the production database must determine its actual current table/column set (e.g. `\dt` in `psql`, or compare against `prisma db pull` run against a *copy*) and decide, together with this finding, how to proceed — most likely either (a) baselining a new migration that captures the full current schema state if production already matches it, or (b) writing/reviewing the real incremental migrations for the 8 uncaptured models before `migrate deploy` is attempted. **`scripts/deploy.sh` in this repo encodes this as a hard manual-confirmation gate and will not run `migrate deploy` on its own.**

## 4. Safe production installation sequence

```bash
# On the VPS, inside the project directory, with production .env already in place:

git pull origin main                 # never this repo's job — a human/CI step
npm ci                                # exact, lockfile-pinned install
npx prisma generate                   # regenerates the Linux-native Prisma client — NEVER copy node_modules/.prisma from another OS
npx prisma migrate status             # READ-ONLY — inspect, do not act on a clean result alone (see §3)
# --- STOP HERE if migrate status / the §3 finding raises any doubt ---
npm run build                         # next build
pm2 start ecosystem.config.js --env production    # first run
# or, on subsequent deploys:
pm2 reload ecosystem.config.js --env production    # zero-downtime reload
pm2 save
```

`scripts/deploy.sh` automates everything above except the actual migration decision, which it always stops for.

**Never run**, against production, under any circumstances this task covers: `prisma migrate reset`, `prisma db push`, `prisma db seed` / `npm run seed` (see §7), `DROP`/`TRUNCATE`, or any destructive SQL.

## 5. PM2

`ecosystem.config.js` (repo root) defines a single `anc-erp` app: `next start` on `PORT=3000`, `NODE_ENV=production`, `fork` mode (1 instance — sufficient for current scale), `autorestart` with a capped restart count (avoids an infinite crash loop if e.g. `JWT_SECRET` is ever missing), `max_memory_restart: 512M`, and `watch: false` (a production server must never restart because `.next/` output changed under it). **Not started by anything in this repo** — a human runs `pm2 start`/`reload` manually or via `scripts/deploy.sh`.

## 6. Nginx — reverse proxy + the SSL/cookie interaction

Template: **`deploy/nginx/erp.alnaeemcargo.com.conf`**. It is a plain file inside this repo, **not** linked into `/etc/nginx/` by anything here — a human copies it onto the VPS (exact commands are in the file's own header comment) and reloads Nginx. **No SSL is configured**, per this task's explicit scope.

**Important interaction to know before going live**: `app/api/auth/login/route.ts` sets the session cookie with `secure: process.env.NODE_ENV === "production"`. Once the app runs with `NODE_ENV=production` (which it must, in production), that cookie is marked `Secure` — browsers refuse to send a `Secure` cookie back over plain HTTP. Concretely: **login will appear to succeed, then the user will immediately look logged-out**, until HTTPS (e.g. `certbot --nginx`) is added on top of the Nginx config in this repo. This is not a bug to fix in code — it's the correct, secure behavior — just a sequencing fact: get Nginx proxying first (this step), confirm the app responds, then add SSL before treating the domain as usable by real users.

## 7. Seed script — do not run against production

`npm run seed` (`prisma/seed.ts`) creates a Super Admin user named `umar` with a **hardcoded password (`admin123`)** if no user with that username already exists. This is fine for a fresh local/dev database; it must **never** be run against production, where it would either do nothing (if a `umar` user already exists) or silently create a well-known, weak-password admin account. `scripts/deploy.sh` does not call it, and nothing in this repo's deployment path does either — keep it that way.

## 8. Static assets, images, and uploads

- `next/image` is used in a few places (`app/bill/[id]/page.tsx`, `app/bilty/[id]/print/page.tsx`, `app/settings/page.tsx`, `components/documents/DocumentPresentation.tsx`) with no custom loader/remote-pattern config in `next.config.ts` — fine, since every image source is either a local `public/` path or a same-origin `/uploads/...` URL; nothing here requires allow-listing an external image domain.
- **Branding uploads** (`app/api/settings/branding/upload/route.ts`) write real files directly to `public/uploads/branding/` on the server's local filesystem via Node's `fs/promises`, and store only the resulting `/uploads/...` URL in `BusinessSettings` — there is no S3/Cloudinary/equivalent in this project (confirmed: no such dependency in `package.json`).
- **This means uploaded files live only on the one VPS's local disk.** They are currently tracked in git (two logo files were committed in an earlier "Prepare ANC ERP for production deployment" commit), so a plain `git pull` deploy preserves them automatically. But: (a) this will slowly bloat the repository as more logos/signatures/stamps get uploaded over time, and (b) any future deploy process that does a *fresh* clone instead of `git pull`, or that runs `git clean`, would lose whatever was uploaded directly on the server and never committed back. **This repo does not redesign the upload system** (out of scope per this task) — the concrete recommendation is: back up `public/uploads/` as part of routine server backups, and if the deploy process ever changes to a fresh-checkout model, explicitly exclude/preserve `public/uploads/` (e.g. a symlink to a directory outside the deploy path) before that change ships.

## 9. Post-deploy smoke test checklist

After `pm2 start`/`reload` and Nginx proxying is live (even before SSL), confirm with plain `curl`/browser:

- `GET /login` and `POST /api/auth/login` — 200s, login flow completes (note the HTTP/SSL caveat in §6 if testing over the public domain before SSL exists).
- `GET /api/dashboard`, `/api/accounts`, `/api/parties` — 200, no 500s.
- `GET /` and a few key pages (`/dashboard`, `/accounts`, `/parties`, `/bilty`, `/challan`) render without server errors.
- `pm2 logs anc-erp` shows no repeated crash/restart loop.

## 10. Summary of blockers found

1. **Migration history is incomplete relative to the live schema (§3)** — the only real blocker in this audit. Requires a human decision before any `prisma migrate deploy` touches the production database. Everything else below is a lower-severity note, not a blocker.
2. `migration_lock.toml` missing from `prisma/migrations/` — minor irregularity, not currently breaking any CLI command tested, but consistent with the same migration-history disruption as #1.
3. Login cookie `Secure` flag means the site needs SSL before it's truly usable on the public domain — expected/correct behavior, just a sequencing note (§6).
4. Uploaded branding files live on local disk only, no off-server persistence (§8) — acceptable for now, flagged for future hardening.
