# Supabase setup for full-tool.html (earlier version — NOT used by the live site)

With this set up, everyone signs in with their own email and password, costing saved by an admin
reaches every rep straight away, and quotes, users and price lists are kept in one place instead of
in each browser. About 20 minutes, once.

## 1. Create the project
1. Go to https://supabase.com, then **Sign in** → **New project**.
2. Name: `sjk-parts`. Region: **Southeast Asia (Singapore)**, the closest to the Philippines.
   Set a strong database password and keep it in your password manager.
3. Wait until the project says it is ready.

## 2. Create the tables
1. Left menu → **SQL Editor** → **New query**.
2. Paste the whole of `supabase/schema.sql` → **Run**. It should end with "Success. No rows returned".

## 3. Lock down sign-ups
**Authentication → Sign In / Providers → Email**:
- turn **off** "Allow new users to sign up" (admins create accounts in the tool),
- turn **off** "Confirm email" (admins set a temporary password instead).

## 4. Create the first admin (you)
**Authentication → Users → Add user → Create new user**: your email + a password, tick
"Auto Confirm User". The first account created becomes an **active admin** automatically.
Everyone else is added from the tool's **Users** tab.

## 5. Deploy the user-management function
**Edge Functions → Deploy a new function → Via Editor**, name it exactly `admin-users`,
paste `supabase/functions/admin-users/index.ts`, then **Deploy**. Without it, the Users tab can't add
people, reset passwords or deactivate anyone.

## 6. Connect the tool
**Project Settings → API**: copy the **Project URL** and the **anon public** key into `js/config.js`:

```js
storeMode: 'supabase',
supabaseUrl: 'https://xxxxxxxx.supabase.co',
supabaseAnonKey: 'eyJ...',
```

The anon key is meant to be public. The database rules decide what each person can see.
**Never** put the `service_role` key in the website.

## 7. Check it works
1. Open the tool and sign in as the admin from step 4.
2. **Users** → add a sales user with a temporary password.
3. **Costing** → change the forex → **Save costing**.
4. In another browser (or on a phone), sign in as the sales user. The new forex is used, and
   **My quotes** shows only that rep's quotes.
5. Back as admin: change the margin and save. The sales screen shows "Costing updated" and the
   prices change without a reload.

## What each role can do (enforced by the database, not just hidden in the page)
| | Sales | Admin | Deactivated |
|---|---|---|---|
| Read costing, part edits, price list | ✓ | ✓ | ✗ |
| Change costing, part edits, price list | ✗ | ✓ | ✗ |
| Quotes | own only | all | ✗ |
| Users | read names | add, edit, deactivate, reset password | ✗ |
| Zoho log | write | read + write | ✗ |

## Not covered yet (next phases)
- **Dealer costs are still in `data/parts_data.json`**, which any signed-in or even anonymous visitor
  could download from the site. Next phase: move the parts into the database and compute selling
  prices on the server, so sales never receive dealer cost.
- **The quote is checked by the app, not the database.** A technically skilled rep could edit their own
  quote's data, e.g. the margin approval, through the browser console. Next phase: approvals written by
  a database function only admins can call.
- **Zoho** still uses the demo CRM. The Zoho backend can be Supabase Edge Functions too, with the Zoho
  refresh token stored as a function secret.
- Old quotes saved in browsers during the demo are not copied across.
