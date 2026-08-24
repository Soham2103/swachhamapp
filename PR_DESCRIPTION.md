## What

Adds the rider module — the pickup and delivery leg of an order — where a job created by the Sorter's acceptance is offered to the nearest riders at once, the first to accept takes it, and it is closed with a handover code the customer reads out; plus Google Maps turn-by-turn routing, a "hold" answer for a rider who is not free yet, and fixes for five bugs found on the way.

## Why

**The schema had space for riders and nothing behind it.** `pickups` and `deliveries` have carried an `assigned_to` column since the first schema and nothing ever set it. The orders enum has carried `PICKUP_ASSIGNED`, `PICKED_UP`, `DELIVERY_ASSIGNED` and `OUT_FOR_DELIVERY` with nothing to move an order through them. The `RIDER` role has existed since migration 020, and rider accounts could be created through the Manager and Super Admin request flows — but a rider who signed in landed on a **blank navigator**, because no stack was ever mounted for the role.

**Assigning pickups was a manual, human job.** There was no way to tell which rider was near an order, no way to offer work without phoning someone, and no record of who was asked or who answered.

**Order placement returned 500 on orders that had saved.** `createOrder` calls `createNotification` *after* its transaction commits, and every statement in `notification.service.ts` was written for PostgreSQL — `$1` placeholders and `RETURNING *` — against a MySQL pool that understands neither. The order was written, the notification threw, and the customer saw a failure. `production.service` had the same problem on every status change.

## Changes

**Dispatch** (`dispatch.service.ts`, new)
- An order being placed sends nearby riders an **advisory only** — no job exists yet and none can be accepted, because the order has not been confirmed by anyone.
- The **Sorter's acceptance** is what creates a real pickup job and offers it. `out_for_delivery` does the same for the return leg — deliberately not `ready`, which only means the laundry is finished and an order can sit finished on a shelf.
- Offers fan out to the 5 nearest online riders rather than assigning to the single closest: the closest rider may be looking at their handlebars, and an order that waits for one person to notice is an order that waits.
- **First accept wins, atomically** — a single conditional `UPDATE ... WHERE status = 'OFFERED' AND rider_id IS NULL` inside a locked transaction. Checking then writing would let two riders both pass the check. Losers get a 409 and their card clears.
- Candidate riders are found with a bounding-box prefilter so MySQL uses the location index instead of computing a distance for every rider on the books.
- **A delivery is matched on the FACILITY, not the customer.** The rider must load before they can deliver, so the facility is their first stop; matching on the customer would offer the job to whoever lives near a door they cannot usefully visit yet. Jobs therefore carry an origin as well as a destination.
- Radius, offer TTL and the stale-fix window are configurable (`RIDER_OFFER_RADIUS_M`, `RIDER_OFFER_TTL_SECONDS`, `RIDER_STALE_FIX_MINUTES`); the facility is `FACILITY_LATITUDE`/`FACILITY_LONGITUDE`.

**The rider's side** (`rider.service.ts`, `rider.routes.ts`, both new)
- Duty switch, position pings, the job pipeline, and the rider's own day. 15 endpoints, `RIDER`-gated once at router level like the Sorter module; every route derives the rider from the token and never from the body, so there is nowhere to name another rider's job.
- Going online **requires a position**: a rider online with no coordinates is invisible to dispatch and would sit waiting for offers that can never arrive.
- **A pickup does not end at the doorstep.** `ASSIGNED → EN_ROUTE → ARRIVED → COLLECTED → COMPLETED`, where `COLLECTED` means the bags are on the vehicle and `COMPLETED` means they reached the facility. Closing the job at the handover made the rider's load invisible the instant they acquired it.
- **Handover codes.** A job only completes when the customer or establishment reads out a 4-digit code. A rider cannot mark work done on their own say-so, which is what makes the record worth something in a dispute.
- **Hold** — a third answer to an offer, beside accept and decline. A rider who is not free yet reserves the job rather than giving it up; it is not offered to anyone else, and is reclaimed automatically after 45 minutes so an order cannot be parked indefinitely.
- **No prices anywhere.** Same rule the Sorter module states, enforced by never selecting the columns rather than by hiding UI.

**Rider app** (`mobile/src/screens/rider/`, `riderApi.ts`, `riderStore.ts`, all new)
- Dashboard: duty switch, live offer cards with countdowns, jobs in hand, held jobs, and the day's counts.
- Job screen: one next action at a time, directions, call, the piece list, and the handover field.
- **Google Maps turn-by-turn** (`utils/navigation.ts`), launched from the job screen, from the job list, and automatically when a rider taps "I'm on my way". A delivery routes to the facility until the rider has loaded, then to the customer.
- The app **polls** while on duty rather than listening: the backend emits every rider event over Socket.IO, but `socket.io-client` is not a dependency of this project and adding one is a bundling decision that belongs to whoever owns the dependency list. `startWatch` is the single place that changes when a socket client is added.
- `RiderStack` mounted in `AppNavigator`, and `userTypeFor` in `authStore` taught about `'rider'` — it fell through to `'customer'`, which left `userType` and `user.role` disagreeing.

**Bugs fixed**
- `notification.service.ts` rewritten for MySQL. Notification failures now log and swallow rather than misreporting a committed order as a 500.
- `socket.service.ts` `join-order` had the same Postgres-placeholder bug, so **no client ever joined an order room**. It was also too narrow: business orders hang off `business_user_id`, so an establishment could never watch its own order, and the assigned rider was refused too.
- **Offers never expired.** `offered_at` came from MySQL's `NOW()` but `expires_at` was a JS `Date`, which mysql2 serialises in the *Node process's* timezone — a 90-second offer was stored 5.5 hours out (19890s, measured). All expiry arithmetic now happens on the database clock, and the app is sent a duration rather than a timestamp.
- **Every accept was rejected as expired.** The pool runs `bigNumberStrings: true`, so `(expires_at < NOW())` returns the string `'0'` — which is truthy in JavaScript. Now compared as a number.
- **Jobs whose offers all lapsed were stranded.** Nothing re-offered them: they sat at `OFFERED` with no live offer, invisible to every rider, and only the decline path triggered a re-dispatch. Added `redispatchStaleJobs`, bounded by the existing 3-attempt ceiling.

**Business pickup points** (`businessProfile.service.ts`)
- `businesses.latitude`/`longitude` were only writable through a legacy admin route the Super Admin onboarding flow does not use, so **every business onboarded through the live flow had NULL coordinates** and could never have a rider matched to it. Coordinates are now part of the shared profile-update builder, validated, both-or-neither.

**Migrations** — `036` (rider tables), `037` (collected/held states), `038` (drops the weight-capacity fields added in 037, after the requirement was clarified: a rider decides what they can carry, the server does not), `039` (job origin). `037`→`038` is kept as real history rather than squashed, because `036` has already been applied and editing it would not reach an existing database.

**Tests** — three smoke suites, **50 checks**, run against the real database and restoring everything they touch: `smoke_rider_dispatch` (26), `smoke_rider_hold` (16), `smoke_rider_delivery` (8). The delivery suite's decisive assertion is that the same order's pickup and delivery go to **different** riders — if the origin were ignored, every other check could still pass.

**Also** — Expo aligned to `54.0.37` / `expo-file-system@19.0.24`; a `__DEV__`-only service-area bypass in `locationGateStore` for testing outside Ratnagiri; helper scripts under `backend/scripts/` for driving the flow by hand.

## Notes for the reviewer

- `unifiedAuth.service.ts` shows as modified with a **zero-line diff** — line endings only.
- Riders still sign in through the existing staff flow (mobile → OTP → username + password); nothing about authentication changed.
- The rider app has no notifications screen yet, so `RIDER_JOB_OFFER` rows are written and pushed but not browsable in-app.
