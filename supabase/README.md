# Supabase setup: shared costing and section passwords

Project: `https://pitfqmvanfnaxsdajhzr.supabase.co` (already in `backend.js`).
About 10 minutes, once. After this, costing saved in the Admin console reaches every sales rep, and the
section passwords from the Admin Console Guide (§3) are checked on the server.

## 1. Create the tables
Supabase → **SQL Editor** → **New query** → paste the whole of [`parts-api.sql`](parts-api.sql) → **Run**.
It should end with "Success. No rows returned".

> Only run `parts-api.sql`. `schema.sql` and `functions/admin-users` belong to the earlier full tool and
> aren't needed (see `README-full-tool.md`).

## 2. Deploy the function
1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly **`parts-api`**.
3. Delete the sample code, paste the whole of [`functions/parts-api/index.ts`](functions/parts-api/index.ts) → **Deploy function**.
4. Open the function → **Details** (or Settings) → turn **OFF "Verify JWT with legacy secret"** /
   "Enforce JWT verification" → **Save**. The tool sends its own unlock token, not a Supabase login,
   so with this left on every request is refused.

No keys go into the website. The function reads the database with the service-role key that Supabase
gives it automatically.

## 3. Check it
Open this address in a browser:
`https://pitfqmvanfnaxsdajhzr.supabase.co/functions/v1/parts-api/settings/locks`
You should see `{}`, meaning no passwords are set yet. A 401 error means step 2.4 wasn't saved.

Then open the tool's **admin link (`#setup`)**. The Costing setup tab should say
"Changes here apply to everyone using this tool once you press Save" (not "saved on this device only").

## 4. First use, in this order (Admin Console Guide §3)
1. **Passwords & access** → set the **Find a part** and **Quote** password (the same one), then the
   **Admin console** password last. Until the Admin console has a password, anyone with the admin link can change costing.
2. You'll be asked for the Admin console password straight away. Enter it.
3. **Costing setup** → enter your real rates → **Save costing** → "Saved for everyone ✓".

## How it protects things
| | Who | How |
|---|---|---|
| Change costing or passwords | Only someone who entered the **Admin console** password | Checked by the function on every save |
| Read costing | Anyone with the link | Needed to show prices |
| Password hashes, tokens | Nobody outside the function | Tables have no public access |
| Guessing passwords | Paused after 10 wrong tries per IP in 15 min | `unlock_failures` table |
| Admin session | Ends after 12 hours, or straight away when the Admin console password changes | `unlock_tokens` table |

Every costing save and password change is kept in the **`settings_history`** table
(Supabase → Table Editor), so you can see when the prices changed.

## Not covered yet
- `data/parts_data.json` (dealer costs) is still a public file on the website. The Find a part password
  hides the screen, not the file. Next step: have this function serve the parts list only to people
  who unlocked a section (`partsUrl` in `backend.js`).
