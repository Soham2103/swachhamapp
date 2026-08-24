## What

Adds a Super Admin portal — two-step sign-in, an approval queue for businesses and riders, and a B2B/B2C sales dashboard — replaces the per-role login screens with one sign-in for everyone, lets a business hold several mobile numbers under a limit the super admin sets, and ports the customer catalogue off Postgres so `/api/services` stops throwing.

## Why

**Nobody could administer anything.** `users` holds `CUSTOMER` and `ADMIN` rows in the same table, but `/auth/customer/login` filters `role = 'CUSTOMER'` in SQL and `/auth/business/login` reads the separate `business_users` table. An `ADMIN` row could authenticate through no route at all, so every `/api/admin/*` endpoint was unreachable by anyone.

**Sign-in had grown a screen per role.** Customer, business, sorter and super admin each had their own entry point, and the app had to know which kind of user it was dealing with before it could ask anything. The server already knows; the client should not have to guess.

**A business could order without the details needed to invoice it.** Onboarding is done by a super admin on the client's behalf, and fields get missed while that happens. Nothing checked.

**A business is reached on more than one number,** but a number lived in two columns that could disagree — one business already held `7030492233` on its business row and `9175584227` on its account.

**`/api/services` threw on every call.** Unported Postgres: `$1` placeholders, `ILIKE`, a `categories` table that does not exist (it is `service_categories`), and columns this schema never had. Confirmed against the live database: `ER_NO_SUCH_TABLE` and `ER_BAD_FIELD_ERROR`.

## Changes

**Unified sign-in** (`unifiedAuth.service.ts`, `SignInPasswordScreen`)
- One entry point: mobile → OTP → the server decides. Customers are signed in and land on Home; staff and business accounts go on to a password step; an unrecognised number becomes a `CUSTOMER` and is signed straight in.
- Resolution searches **both id-spaces** — businesses live in `business_users`, not `users`, so a lookup reading only `users` would have been blind to every business account.
- Ambiguity resolves **downwards**: a number matching several accounts gets the customer account if there is one, and is otherwise refused. Four numbers already match more than one account; picking a winner would let a shared or recycled number hand somebody a staff session.
- The password step is bound to the OTP step by a 15-minute pre-auth token signed with a **separate derived secret** — sharing `JWT_SECRET` would let a half-finished login pass `authenticate` as a full session. It also checks the username resolves to the *same* account the OTP was proven against.
- The separate "Staff login" and "Super Admin login" entries are gone.

**Super admin portal** (`superAdmin.service.ts`, `superAdmin.routes.ts`, 7 screens)
- Dashboard: revenue headline, B2B/B2C trend chart, approval queues, create actions.
- Approvals for businesses and riders, with an audit trail (`reviewed_at`, `reviewed_by`, note) rather than a status that silently flipped.
- Direct onboarding of businesses and riders.
- Sales APIs derive the B2B/B2C split from which owner column an order carries, not a flag that could drift. Both channels are always returned and every period is zero-filled, so a chart never meets a missing series.

**Charts** (`chartTheme.ts`, `RevenueLineChart`)
- Colour was computed, not chosen. The brand green **failed** validation — chroma 0.078 is under the floor, so it reads grey in a chart, and green-vs-amber is a classic protan confusion at deltaE 7.0. The shipped pair (`#0891B2` / `#EA580C`) passes every check with CVD deltaE 19.8 protan against a floor of 8.
- One y-axis, never two. Both series are rupees; a second scale would let the shapes be compared when the magnitudes cannot be.
- Both channels are drawn even though B2C is currently flat at zero — dropping an empty series would imply it does not exist.

**Mandatory establishment details** (`businessCompleteness.ts`)
- Six fields required before a business may order: establishment name, address, GST, contact person, mobile, email. One list, read by the ordering gate, the business's own profile and the super admin screen, so "complete" cannot mean different things in different places.
- `createOrder` refuses an incomplete business with 403 **and names the missing fields**.
- Super admin can read and fill any business's details, validated by the *same code* the self-service update runs.

**Many mobile numbers per business** (`business_mobiles`, `BusinessMobilesSection`)
- Any listed number can sign in to the business, so the list is an authentication surface, not contact details — which is why adds are capped and the last number cannot be removed.
- `businesses.max_mobiles` is the per-business allowance, set by the super admin. The backfill seeds it from what each business already holds, so nothing starts over its own limit.
- Adding a number used elsewhere succeeds **and warns**, naming where it is already used and that it can no longer sign in.

**Customer catalogue** (`service.service.ts`, `service.routes.ts`)
- Rewritten against the real schema. Scope defaults to `CUSTOMER` so a customer endpoint never serves the hotel list; `?scope=BUSINESS` still reaches it.
- Unpriced is no longer reported as free: every `base_price` is `0`, so `NULLIF` returns null and the client can say "price on request".
- `/services/categories` and `/services/popular` are registered at last — both have been in the README all along and neither was ever routed. They are declared **before** `/:id`, or Express matches them as an id.
- `getServiceById` throws 404 instead of returning null with a 200.

**Two unrelated fixes found while testing**
- `DATABASE_SSL` was parsed as `optionalEnv(...) === 'true'`, so any unrecognised value silently became `false`. A `.env` carrying `DATABASE_SSL=REQUIRED` disabled TLS and the pool connected to the managed MySQL instance **in plaintext**. `booleanEnv()` now throws on an unrecognised value rather than defaulting to the insecure one. Verified: `Ssl_cipher` empty before, `TLS_AES_256_GCM_SHA384` after.
- `start-lan.js` wrote `REACT_NATIVE_PACKAGER_HOSTNAME` into `mobile/.env`, which Expo SDK 54+ refuses to load — `npm start` failed every time. The value is already passed to the dev-server child process, so the write was redundant.

**Migrations** — `019` SUPER_ADMIN role · `020` RIDER role, PENDING business status, rider approval columns · `021` MANAGER role · `022` `business_mobiles` + `max_mobiles`. All additive, all idempotent, all gated on `information_schema`.

## Behaviour changes reviewers should know

- **Business self-registration is closed.** `POST /auth/business/register` returns 403 with an explanation; the handler that created accounts is deleted, not merely unrouted. `BusinessRegisterScreen` is now a dead end and needs removing.
- **GST is mandatory for everyone.** Three existing businesses (Test Hotel QA, Hotel ABC, Hos) have none and **cannot place orders** until a super admin fills it in.
- **New business signups land in `PENDING`** and wait for approval. Businesses that already existed stay `ACTIVE` — they predate approval being a concept.
- **A `BUSINESS` token is no longer sufficient to transact.** Registration still returns a session so the app can show a waiting state, so the real gate is a status check in front of the business ordering routes.
- **`HomeScreen.tsx` has zero net change.** The catalogue was wired into it and then reverted at the author's request. `ServiceCategoryScreen` and its route remain but are unreachable; they are the only consumer of the fixed catalogue endpoints and are kept as groundwork.

## Testing

Verified against the live database and a real device, not only at unit level:

| Area | Result |
|---|---|
| Unified sign-in, all 5 paths | new number, customer, super admin, business, ambiguous — each correct |
| Two-step bypass attempts | no token rejected; forged token rejected; pre-auth used as Bearer → **401** |
| Role isolation on `/api/super-admin/*` | `CUSTOMER` 403, plain `ADMIN` 403, no token 401 |
| Super admin on device | sign-in → dashboard → charts → approvals → establishment details, every request 200 |
| Completeness gate | blocked with the field named, then unblocked once GST was filled |
| Mobile allowance | add over cap refused; raise limit; add succeeds; duplicate warns; lower-below-held refused |
| Sign-in via a newly added business number | resolved to `PASSWORD_REQUIRED` / "Comffort Inn" |
| Catalogue endpoints | 102 items over 34 pages, 20 categories, search, 404 on unknown id |
| Migrations | applied; row counts intact before and after each |
| Typecheck | `tsc --noEmit` clean, backend and mobile |
| Bundles | Android and iOS both build, 0 errors |

## Notes

- `.claude/skills/pr-description/SKILL.md` is in the range but is the repo owner's own commit (`774b504`), not part of this work.
- This is large and splits cleanly along four seams if you would rather review it in pieces: unified auth, super admin portal, business mobiles, and the catalogue/config fixes.
