# SJK Parts Quoting Tool (HTML · CSS · JS)

> **The live site is the interface from the Sales Tool Guide and Admin Console Guide** (`files/.../guides/`):
> `index.html` (sales at `#find`, admin console at `#setup`) + `backend.js` + `data/parts_data.json`.
> Screens, wording and behaviour follow the guides; access is by section passwords.
> **Backend:** Supabase project `pitfqmvanfnaxsdajhzr`. The `parts-api` Edge Function implements the REST
> contract at the top of `backend.js` (costing settings, section passwords, unlock). Setup steps:
> [`supabase/README.md`](supabase/README.md). Until the function is deployed, costing saves on each device only.
>
> The earlier, larger version (Zoho deal + PDF proposal + My quotes + user logins) is kept as
> `full-tool.html` with `css/`, `js/` and `supabase/`. It is not published. The rest of this README
> describes that version.

Front end for the Club Car spare-parts quoting tool described in James's `SPEC.md`. A rep finds parts, the
tool prices them from the admin costing settings, builds the quote, creates the PDF proposal and the
Zoho CRM deal. Plain HTML, CSS and JavaScript — no build step, no frameworks.

## Work on it in VS Code

1. VS Code → Source Control → **Clone Repository** → `SJK-Donna/sjk-parts-quoting-tool`.
2. Install the recommended **Live Server** extension (VS Code offers it), right-click `index.html` → **Open with Live Server**.
3. Edit, then commit and **Sync Changes**. Pushing to `main` deploys to parts.sjkguahan.com automatically.

## Deploy — https://parts.sjkguahan.com (Cloudflare Pages + Access)

Cloudflare Pages builds and publishes on every push to `main`. Cloudflare Access puts a login in front of the
site so only `@sjkguahan.com` people can open it (`data/parts_data.json` holds SJK's dealer costs).
GitHub Actions (`.github/workflows/ci.yml`) only runs the tests.

One-time setup in the Cloudflare dashboard (the account that holds sjkguahan.com):

1. **Workers & Pages → Create → Pages → Connect to Git** → GitHub → allow access to `SJK-Donna/sjk-parts-quoting-tool`.
   - Project name: `sjk-parts` · Production branch: `main` · Framework preset: **None**
   - Build command: `sh scripts/build-site.sh` · Build output directory: `_site`
2. Project → **Custom domains → Set up a custom domain** → `parts.sjkguahan.com` (Cloudflare adds the DNS record).
3. **Zero Trust → Access → Applications → Add → Self-hosted**
   - Domains: `parts.sjkguahan.com` **and** `sjk-parts.pages.dev` (also `*.sjk-parts.pages.dev` for previews),
     so the Pages address can't be used to get around the login.
   - Policy: Action **Allow**, Include **Emails ending in** `@sjkguahan.com`.
   - Login method: One-time PIN (default), or add Google Workspace as an identity provider.

Free plan covers this (Access is free up to 50 users).

> The Access login only controls who can open the site. Roles inside the tool (Sales vs Admin) are still the
> browser demo until the backend exists (SPEC §11).

## Run it

```bash
cd sjk-quoting-tool
python3 -m http.server 8000
# open http://localhost:8000
```

It must be served over HTTP (not opened as a file) because it loads `data/parts_data.json`.

Demo sign-ins (password `demo1234`):

| Email | Role |
|---|---|
| `admin@sjkguahan.com` | Admin — everything, plus Costing, Users, Parts data, Zoho |
| `sales@sjkguahan.com` | Sales — Find a part, Quote, My quotes |

## What's in it

| File | What it does |
|---|---|
| `index.html` | Page shell, sign-in, tabs |
| `css/styles.css` | All styling. Mobile-first; tables turn into cards on phones |
| `js/config.js` | Switch between the demo CRM and your backend (`zohoMode`) |
| `js/pricing.js` | The SPEC §5 costing formula. Pure functions, also runs in Node |
| `js/store.js` | Saves users, settings history, quotes and versions, part edits (browser storage, demo mode) |
| `js/store-supabase.js` | Same data in the shared Supabase database with real logins (`storeMode: 'supabase'`) |
| `supabase/` | Database tables and rules (`schema.sql`), the `admin-users` function, and the setup steps (`supabase/README.md`) |
| `js/zoho.js` | Zoho adapter: `MockZoho` (demo CRM in the browser) and `ApiZoho` (calls your backend) |
| `js/proposal.js` | The customer PDF proposal (A4 HTML matching `Sample Proposal - SP-GC-07680-v1.pdf`) |
| `js/pdf.js` | Turns the proposal into a downloadable PDF file in the browser |
| `js/app.js` | Every screen and the generate → Zoho sync flow |
| `data/parts_data.json` | 4,781 parts (3,518 priced), unchanged from the handoff pack |
| `tests/pricing.test.js` | SPEC §5.3 test cases: `node tests/pricing.test.js` |

## Spec coverage

- **Find a part (§7.1):** model and category filters with live counts, AND-search over part no., description
  and supplier codes, exact/prefix part-number ranking, "price on request" parts, 150 per page, expandable
  detail with cost bar, sea/air toggle.
- **Pricing (§5):** exact formula; all four §5.3 test cases pass. Also: per-part weights, an
  "air never below sea" guard, and lithium batteries flagged as dangerous goods (air freight blocked) — §5.4.
- **Quote (§7.2):** Zoho account/contact search, new customer/contact (respects duplicates), reference,
  cart model, margin with minimum check, qty and kg overrides, totals, all 15 required deal fields
  prefilled from the account's last deal, Unit Offered set automatically (Battery / Tires / GCPH Wear & Tear).
- **Below-minimum margin (§8.4):** sales requests approval; an admin approves; the approver is printed on the PDF.
- **Proposal (§8):** SP-<Deal No>-vN numbering, SP-TMP-… while Zoho is unreachable, terms from settings,
  "Approved by" only when needed, page x of y. Never shows cost, landed, margin, freight or duty.
- **Zoho (§9):** save first, then create deal → read Deal_No → upload PDF → add note. Revisions update the
  same deal. Auto-retry with backoff for 5xx/429, manual Retry, duplicate guard before re-creating.
- **My quotes:** search, status filters (draft, needs approval, issued, won, lost, expired), versions
  (read-only), revise.
- **Admin:** costing settings with live preview and change history; users (add, role, deactivate,
  password); part edits (weight, category, dangerous goods, notes); load a new `parts_data.json` from
  `ingest.py` with a diff before publishing; Zoho log and an outage switch for testing.
- **Open question §12 Q1:** whether sales see dealer/landed cost is a setting ("Sales can see…"), off by default.

All six §9.6 acceptance tests were run against the demo CRM.

## What still needs a backend (important)

This is the complete front end. Three things **cannot be made secure in a browser alone** (SPEC §11):

1. **Logins and roles.** Sign-in here is a demo stored in the browser. Production needs real
   authentication (Google Workspace SSO or Zoho) with roles checked on the server.
2. **Costs.** `parts_data.json` sends every dealer cost to every browser. For sales users, the server
   should send selling prices only.
3. **Zoho credentials.** The OAuth refresh token must live on the server. Set `zohoMode: 'api'` in
   `js/config.js` and implement these endpoints (they forward to Zoho CRM REST, Sandbox first):

| Method & path | Zoho call |
|---|---|
| `GET /api/zoho/picklists` | `/settings/fields?module=Deals` + layout `4983915000040429371` (cache) |
| `GET /api/zoho/accounts?search=` | `/Accounts/search?word=` |
| `GET /api/zoho/accounts/:id/contacts` | `/Accounts/:id/Contacts` |
| `GET /api/zoho/accounts/:id/history` | COQL on Deals → `{hasClosedWon, lastDeal}` |
| `POST /api/zoho/accounts`, `POST /api/zoho/contacts` | create; return `{duplicate:true, record}` on duplicate |
| `GET /api/zoho/deals?quote=` | find deal whose Description contains `[quoteId]` → `{deal}` |
| `POST /api/zoho/deals` | `POST /Deals` with `trigger:["workflow"]`; set Owner from the user's email |
| `GET /api/zoho/deals/:id`, `PUT /api/zoho/deals/:id` | read Deal_No / update Amount, Closing_Date, Description |
| `POST /api/zoho/deals/:id/proposal` | body `{fileName, html}` → render PDF (headless Chrome) → `POST /files` → add to `Proposal_Upload` |
| `POST /api/zoho/deals/:id/notes` | `POST /Deals/:id/Notes` |

Quotes, settings and users are also kept in the browser for now. `js/store.js` is the one place to swap
for database calls (shapes follow SPEC §4.2).

## PDF

**Server-side (exact, selectable text):** `node scripts/render-proposal.js tests/fixtures/sample-proposal.json out.pdf`
prints the proposal HTML with headless Chrome/Edge (the same way the sample was made) and reproduces
`Sample Proposal - SP-GC-07680-v1.pdf` line for line: Inter font, same layout, footer
"Golf Carts PH · SJK Guahan Inc." / "SP-…-vN · page x of y". The backend's proposal endpoint should call `render()` from that script.

**In the browser:** "Download PDF" builds a real A4 PDF (`js/pdf.js`, using html2canvas + jsPDF from cdnjs), with
"Page x of y" on every page and page breaks between table rows. The text in this PDF is an image; with the
backend in place, render the same HTML server-side (headless Chrome) for selectable text — SPEC §8.4.
