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

## Connect Zoho CRM (customers on the Quote tab)
Once connected, the Quote tab's **Customer** box searches Zoho CRM Accounts. Picking one fills in
the address and phone and lists that account's Contacts. The Zoho login stays in Supabase as a
secret. It never goes to the browser.

1. **Create a Self Client:** go to https://api-console.zoho.com → **Add Client → Self Client → Create**.
   Copy the **Client ID** and **Client Secret**.
2. **Generate a code** (same page, tab **Generate Code**):
   - Scope: `ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.users.READ`
   - Time duration: 10 minutes · Description: SJK parts tool → **Create**. Copy the code; it expires in 10 minutes.
3. **Turn the code into a refresh token and store everything as secrets.** In the VS Code terminal
   (PowerShell), replace the three `PASTE_…` values, then run:
   ```powershell
   $id = "PASTE_CLIENT_ID"; $secret = "PASTE_CLIENT_SECRET"; $code = "PASTE_CODE"
   $r = Invoke-RestMethod -Method Post "https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=$id&client_secret=$secret&code=$code"
   if ($r.refresh_token) { npx supabase secrets set --project-ref pitfqmvanfnaxsdajhzr ZOHO_CLIENT_ID=$id ZOHO_CLIENT_SECRET=$secret ZOHO_REFRESH_TOKEN=$($r.refresh_token) } else { $r }
   ```
   It should end with "Finished supabase secrets set". If it prints an `error` instead, generate a new code (step 2) and run it again.
   Don't paste these values into chats or files. Supabase stores them encrypted.
4. **Update the database and the function:**
   - SQL Editor: run `parts-api.sql` again (adds the `zoho_cache` table).
   - Terminal: `npx supabase functions deploy parts-api --project-ref pitfqmvanfnaxsdajhzr --no-verify-jwt` → **Yes**.
5. Open the tool, press Ctrl+F5, go to **Quote**. The Customer box should say *"Search Zoho accounts (2+ letters)"*.

Your Zoho CRM lives on the **.com** data centre (crm.zoho.com). If that ever changes, set the
`ZOHO_ACCOUNTS_URL` / `ZOHO_API_DOMAIN` secrets to match (e.g. `https://accounts.zoho.com.au`).

## Not covered yet
- **Creating or updating the Deal in Zoho CRM with the PDF attached** (README flow step 4). That's the next step after customer search.
- `data/parts_data.json` (dealer costs) is still a public file on the website. Now that everyone signs
  in, the function can serve it to signed-in people only (`partsUrl` in `backend.js`). That's the next step.
