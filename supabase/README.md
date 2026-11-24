# Supabase setup: sign-in, shared costing and section passwords

Project: `https://pitfqmvanfnaxsdajhzr.supabase.co` (already in `backend.js`).

Access follows the two layers in the Admin Console Guide §2:
- **Layer 1, sign-in:** everyone signs in with their own email and password. **admin** = the guide's
  *Editor*: changes costing and passwords and is never asked for section passwords. **sales** = the
  guide's *Viewer*: uses Find a part and Quote and sees costing read-only.
- **Layer 2, section passwords:** the Passwords & access tab, exactly as in the guide.

## 1. Tables
Supabase → **SQL Editor** → **New query** → paste the whole of [`parts-api.sql`](parts-api.sql) → **Run**.
Run it again even if you ran an earlier version: it adds the `profiles` table (roles) and a
"changed by" column, and keeps what's already there.
(Don't run `schema.sql`; it belongs to the old full tool.)

## 2. Function (optional for now)
Without it, sign-in still works and costing saves on each device. Deploy it when you want costing shared.

**Edge Functions** → `parts-api` (or **Deploy a new function → Via Editor**, name `parts-api`) → paste the whole of
[`functions/parts-api/index.ts`](functions/parts-api/index.ts) → **Deploy**.
In the function's **Details/Settings**, turn **OFF "Verify JWT"**. The function checks the sign-in itself.

## 3. Sign-in settings
**Authentication → Sign In / Providers → Email**:
- **Allow new users to sign up: OFF.** Only you add people.
- **Confirm email: OFF**, or tick "Auto Confirm User" whenever you add someone.

## 4. Put the public key in the website
**Project Settings → API Keys** → copy the **publishable** key (or the legacy **anon public** key) into
`backend.js`:
```js
anonKey: 'sb_publishable_…',
```
This key is meant to be public. Never put the **secret** / **service_role** key in the website.
Until `anonKey` is filled in, the tool has no sign-in and saves costing on each device only.

## 5. Add people
**Authentication → Users → Add user → Create new user**: email + password, tick **Auto Confirm User**.
- The **first** person added becomes **admin** automatically. Everyone after that is **sales**.
- To make someone admin, or to take access away: **Table Editor → profiles** → change `role`
  (`admin` / `sales`) or set `active` to false. To stop someone signing in at all, also delete or ban
  them under Authentication → Users.

## 6. First use (Admin Console Guide §3)
Open the admin link (`#setup`) and sign in as the admin.
1. **Passwords & access** → set the **Find a part** and **Quote** password (the same one) and an
   **Admin console** password. As an admin you're never asked for them; sales reps are.
2. **Costing setup** → your real rates → **Save costing** → "Saved for everyone ✓".

## Check it
`https://pitfqmvanfnaxsdajhzr.supabase.co/functions/v1/parts-api/settings/locks` in a browser should
say `{"error":"Please sign in."}`. That means the function is running and refuses people who aren't
signed in. "Requested function was not found" means step 2 isn't done.

## Who can do what (checked by the function, not just hidden in the page)
| | Not signed in | sales | admin |
|---|---|---|---|
| See costing / prices | ✗ | ✓ (after the section password) | ✓ |
| Change costing, set passwords | ✗ | ✗ | ✓ |
| Wrong section passwords | | paused after 10 tries in 15 min | |

Every costing save and password change is kept in **`settings_history`** with who made it.

## Not covered yet
- `data/parts_data.json` (dealer costs) is still a public file on the website. Now that everyone signs
  in, the function can serve it to signed-in people only (`partsUrl` in `backend.js`). That's the next step.
