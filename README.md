# Free Talk — Deployable Copy (Render)

A standalone, deployable copy of the **Free Talk** social voice-chat app, built
from the approved product spec. It exists because the Muse artifact version
has **no export path and no public link** — this project is the same app as a
normal Node service that any host can run.

**One Node.js service serves both the front end and the API.** Storage is
Postgres when `DATABASE_URL` is set, otherwise a local file DB
(`data/db.json`) so it can be run and smoke-tested anywhere with zero setup.
The app **starts EMPTY** — no users ship. Only the gift catalogue (25 gifts)
and coin packages (4) are seeded.

## Run locally (smoke test)

```bash
node server.js            # http://localhost:10000  (file DB, no setup)
npm run smoke             # full automated check: OTP → register → friends →
                          # DM/read receipt → room → heartbeat → Easypaisa
                          # approval → gift → verification → call → posts
```

Last local run (2026-10-27): **all 35 smoke checks PASSED** (wrong OTP and
duplicate SIM rejected; duplicate/fake XP blocked; DM blocked before
friendship; balance 0 before admin verification and exactly 550 after;
non-admin rejected by admin endpoints; non-live verification upload rejected).

## Deploy to Render (free tier, no bank card)

The included `render.yaml` Blueprint creates the web service **and** the
Postgres database in one go.

1. **Owner step (only the owner can do this):** create a Render account at
   render.com **in the owner's own name** (email/Google/GitHub — no card
   needed for the free tier) and a GitHub account if the repo will live there.
2. Put this folder in a Git repository (GitHub/GitLab/Bitbucket).
3. In Render: **New → Blueprint**, select the repo. Render reads
   `render.yaml`, creates `free-talk` (web service) + `free-talk-db`
   (Postgres) and wires `DATABASE_URL` automatically.
4. Open the service URL (`https://free-talk-xxxx.onrender.com`) — `/api/health`
   should return `{"ok":true,...}` and the app should load.
5. **The owner registers the FIRST account inside the live app** — the first
   account becomes Owner/Super Admin pinned at TOP level (Lv 10, 10,000 XP),
   exactly like the Muse version. Nobody else should register before him.
6. Point the Android APK at the live address (see the APK section below).

### Free-tier limits — known upfront, not surprises

- The free web service **sleeps after ~15 min idle**; the first visitor
  waits ~1 minute for it to wake.
- The free Postgres **expires after 30 days**. Before then, upgrade the
  database (Basic ≈ $6/mo) and, for always-on, the service (Starter $7/mo) —
  ≈ **$13/mo total**. Paid tiers need an international card; none of these
  hosts take Easypaisa.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no (Render sets it) | Port the service listens on. Default 10000. |
| `DATABASE_URL` | set by Blueprint | Postgres connection string. Unset = local file DB. |
| `OWNER_EASYPAISA` | no | Easypaisa number shown for coin-purchase instructions. Default `03365913165`. |

No secret keys are stored in the mobile app/APK. RTC provider keys
(LiveKit/Agora) are entered later in **Admin → Settings** inside the app,
never in code.

## Point the APK at the live app

1. In `~/workspace/free-talk-apk/app/src/main/java/com/aifreevision/freetalk/MainActivity.java`,
   set `APP_URL = "https://<your-render-address>/";`
2. Run `./build.sh` in `~/workspace/free-talk-apk/` (rebuilds + signs with the
   same keystore as v1, so it installs over the setup-screen build).
3. Install the new `FreeTalk-v1.apk` on the phone and test: login, a room,
   mic permission.

## What is implemented vs honestly limited

**Implemented and smoke-tested at API level:** SIM + password registration
with 6-digit OTP step (wrong code rejected, one SIM = one account, unique
username + Free Talk ID, age from DOB — full DOB never returned by the API);
profiles with gallery picture; friend requests with friends-only DM/calls by
default; private chat (text/emoji/photos/files ≤ 2 MB, voice messages,
delivered + read receipts); voice rooms (create + full settings, join/speak
policies, 4–12 seats, raise-hand + approvals, roles/moderators, ban list,
room chat + slow mode, local music upload/play, tiers Starter→Legendary);
real device microphone in rooms with a live voice meter and mute that cuts
the actual mic track; call signalling state machine (ringing → ongoing →
ended) with the full call UI and local camera preview; XP system — level
strictly from XP, XP only from room time (+1/min, cap 120/day), speaking
(+5/min, cap 300/day) and invited friends actually joining (+50, cap 250/day),
timed by the server clock (fake instant claims earn 0); owner pinned at TOP;
gift shop (25 gifts) + wallet with append-only ledger; Easypaisa purchases by
transaction reference, credited **only** after admin verification; live-camera
verification (non-live uploads rejected) with admin approval before the badge;
8 locked badges with real progress; Facebook-style posts with
like/comment/share; Super Admin panel with server-side role checks,
analytics, bans, verification/payment review, gift & package pricing,
featured rooms, reports, announcements, audit log and settings (XP rates,
RTC, Easypaisa). Calls, messages and rooms are **100% free and unlimited** —
coins exist only for optional gifts, and no endpoint lets a user change their
own balance.

**Honestly limited (same limits as the current app, labelled in the UI):**
- **Cross-device voice/video media** needs the owner's LiveKit/Agora keys
  (Admin → Settings). Signalling, seats, call UI and your own mic/camera work
  today; hearing each other across phones starts when keys are added.
- **SMS OTP**: no SMS provider is connected, so the OTP code is shown in-app
  with a clear note instead of being texted. The OTP gate itself (expiry,
  wrong-code rejection) is fully enforced.
- The Postgres path is code-complete (`pg` installs and loads — verified) but
  was **not** run against a live Postgres in this environment (no local
  Postgres); the file-DB path is the one covered by the smoke test. First
  Render deploy should watch the service logs on first boot.
- Media (avatars, selfies, room covers, chat files, music) is stored as
  data URLs inside the database state — simple and portable, fine for launch
  scale; move to object storage before heavy growth.

## Layout

```
server.js          API + static hosting, auth, XP, wallet, admin (zero deps except optional pg)
public/index.html  App shell + styles
public/app.js      All screens (Home/Rooms/Friends/Messages/Gifts/Profile/Admin)
render.yaml        Render Blueprint (service + Postgres)
scripts/smoke.mjs  Automated end-to-end smoke test (runs on a temp copy)
```
