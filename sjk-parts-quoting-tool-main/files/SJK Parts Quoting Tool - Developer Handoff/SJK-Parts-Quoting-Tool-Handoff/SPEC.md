# SJK Parts Quoting Tool — Product & Technical Specification (v1.1)

Product owner: James Robert Ugarte, GM, SJK Guahan Inc. · Prepared 23 Nov 2026 from a working prototype.

> **What to build, in one line:** an interactive spare-parts quoting tool. A sales rep picks parts, the tool prices them from management's costing settings, produces a **PDF proposal** for the customer, and **creates or updates the matching Deal in Zoho CRM** with the PDF attached.

---

## 1. Purpose

Service sales staff at Golf Carts PH (SJK Guahan's Club Car distribution unit, Philippines) need to price
Club Car spare parts quickly and safely. Today this means digging through Club Car price PDFs and
working out freight, duty and margin by hand.

The tool must:
1. Let a sales user find any part by **cart model**, **category**, **part number** or **description**, and see a reliable selling price in PHP.
2. Build a multi-line **quote** for a Zoho CRM customer (account + contact).
3. Produce a branded **PDF proposal** from the quote (§8).
4. **Create the Deal in Zoho CRM** (pipeline "Spare Parts") with the right field values and the PDF attached, and **update the same Deal** when the proposal is revised (§9).
5. Give management a **back-end costing layer** (forex, sea and air freight, duties, port charges, contingency, margin) that drives every price, with no maths done by sales.

**The end-to-end flow a rep follows:**
1. Choose the customer, searched live from Zoho Accounts and Contacts.
2. Add parts.
3. Check the prices and margin.
4. Fill the few deal fields Zoho requires.
5. Press **Generate proposal**. The PDF is created, the Zoho Deal is created with the PDF uploaded, and the rep downloads the PDF to send.

Revising the quote makes v2, v3 and so on, and updates the same Deal.

## 2. Users and roles

| Role | Who | Can |
|---|---|---|
| **Sales** | Service sales reps, service executives (~5–10 people) | Search parts, view prices, build and export quotes. **Cannot** see or change costing settings. |
| **Admin** | GM, finance / costing owner (1–2 people) | Everything Sales can, plus edit costing settings, manage users, import new price lists, view the data-coverage report. |

**Production requirement:** use real per-user authentication with roles (e.g. company Google Workspace SSO or email + password). The prototype's "section passwords" were a stop-gap and must be replaced; see §11.

## 3. Scope

**v1 (must have):**
- §5 costing formula, §6 price-list import, §7 screens
- role-based auth and saved quotes with versions
- **§8 PDF proposal**
- **§9 Zoho CRM deal creation and update**

**v1 nice to have:**
- Quote history per customer
- Audit log of costing-setting changes (who / when / old → new)
- Nightly sync of Deal Stage back into the tool (won / lost)

**Later (design for, don't build):**
- Emailing the proposal from the tool
- Zoho CRM Quotes module with line items (needs parts synced as Zoho Products)
- Zoho Books estimates
- More brands beyond Club Car (the Ground Masters PH turf equipment line, which uses Unit Offered "GMPH Wear & Tear")
- Live stock levels

## 4. Data

### 4.1 What exists today
- **3,518 priced parts** from Club Car dealer price quotes for SJK (dated 9 Aug 2026, USD). The "Unit Price" column is SJK's buy price; MSRP is Club Car's US list price.
- **262 Minibus parts** from the *2025 Minibus Complete Spare Parts Catalogue*: FCA China, USD dealer price, valid 1 Dec 2025 – 31 Dec 2026. These carry Club Car PNs plus supplier codes (`CA-xxxxxxx`, `1030…`).
- **1,263 part numbers** that appear in parts-book lists but on no price list. They are usually superseded or no longer available. Show them as "Price on request".
- **13 cart models in 3 groups:**
  - Golf: Tempo, Tempo (New Dash), Onward, Precedent 2019 / 2015 / 2009P
  - Utility: Carryall 300 / 500 / 700
  - Passenger: Transporter 4 & 6, Villager 6 & 8, Villager 6 & 8 (AC), Minibus 11 & 14
- **18 categories**, assigned by keyword rules on the description (`scripts/ingest.py` §4). Categories are approximate; allow an admin to override a part's category.

### 4.2 Suggested data model

```
cart_model      (id, name, group, sort_order)
category        (id, name, default_weight_kg)
part            (part_no PK, description, category_id, origin ['US'|'CN'],
                 weight_kg NULL,                -- per-part override; NULL → category default
                 category_override BOOL, is_hazmat BOOL, alt_codes TEXT[], notes)
part_fitment    (part_no, cart_model_id)        -- many-to-many
price_list      (id, supplier, name, currency, incoterm ['EXW'|'FCA'…],
                 effective_from, effective_to, source_file, imported_at, imported_by)
part_price      (part_no, price_list_id, dealer_cost, msrp NULL)  -- keep history; current = latest effective list
costing_settings(id, values JSONB, created_at, created_by)        -- append-only; latest row is live
quote           (id, proposal_no, version, status ['draft'|'issued'|'won'|'lost'|'expired'],
                 zoho_account_id, zoho_contact_id, customer_snapshot JSONB, reference, cart_model,
                 freight_mode, margin_pct, validity_days, valid_until,
                 deal_fields JSONB,            -- Zoho fields the rep filled (§9.3)
                 zoho_deal_id, zoho_deal_no, zoho_sync_status ['pending'|'synced'|'failed'], zoho_last_error,
                 pdf_file_url, created_by, created_at, settings_id)   -- settings snapshot used
quote_line      (quote_id, line_no, part_no, description, qty, weight_kg,
                 unit_landed_php, unit_sell_php, line_total_php)
user            (id, name, email, role, title, mobile, zoho_user_id, sjk_office_location)
```

**Rules:**
- A quote line stores the computed prices at the time it was quoted, so later forex or price changes don't silently change an issued quote.
- A part can fit several models (e.g. Tempo and Tempo New Dash share most parts).

### 4.3 `parts_data.json` (prototype format)
```
{ "v": "2026-11-20",
  "models": [["Tempo","Golf"], ...],     // index = model id
  "cats":   ["Accessories", ...],        // index = category id
  "rows":   [[part_no, description, dealer_cost_usd|null, msrp_usd|null,
              origin (0=US,1=CN), category_idx, [model_idx...], [alt_codes...]], ...] }
```
`parts_master.csv` has the same content with readable columns. Use it to seed the database.

## 5. Costing formula (authoritative)

All settings are admin-editable (§5.2). Calculate per unit, in this order:

```
buy_usd   = dealer_cost × (1 + china_origin_fee%  if origin = CN, else 1)
freight   = if basis[mode] = "pct": buy_usd × freight_pct[mode][origin]
            if basis[mode] = "kg" : weight_kg × freight_usd_per_kg[mode][origin]
insurance = (buy_usd + freight) × insurance%
cif       = buy_usd + freight + insurance            # Customs value
duty      = cif × duty%
brokerage = cif × brokerage_port%
subtotal  = cif + duty + brokerage
contingency = subtotal × misc%
import_vat  = subtotal × 12%                         # added to cost ONLY if vat_as_cost = true (default false)
landed_usd  = subtotal + contingency (+ import_vat)
fx          = forex_rate + forex_buffer              # PHP per USD
landed_php  = landed_usd × fx
sell_php    = ceil( landed_php / (1 − margin%) / round_to ) × round_to    # margin on selling price; round UP
sell_inc_vat= sell_php × 1.12
gross_profit= sell_php − landed_php
```
`mode` ∈ {sea, air}; `origin` ∈ {US, CN}; `weight_kg` = per-part weight, else the category default, else a per-quote-line override.

### 5.1 Breakdown display
Show the price as a stacked bar: buy price, freight, insurance, duty, brokerage & port, contingency, (import VAT), margin.

### 5.2 Settings and current defaults (placeholders, to be confirmed by James)
| Key | Default | Notes |
|---|---|---|
| forex_rate | 64.00 | PHP/USD. BSP reference was ~63.8 in mid-Nov 2026 |
| forex_buffer | 1.00 | PHP added per USD |
| sea basis / US % / CN % / US $/kg / CN $/kg | pct / 12 / 10 / 2.50 / 1.20 | |
| air basis / US % / CN % / US $/kg / CN $/kg | kg / 30 / 22 / 9.00 / 5.00 | |
| insurance % | 0.5 | of buy + freight |
| duty % | 10 | of CIF. Confirm HS-code rate with broker |
| brokerage, arrastre & port % | 3 | of CIF |
| china_origin_fee % | 3 | FCA excludes export & wood-packing fees |
| misc / contingency % | 5 | |
| vat_as_cost | false | Import VAT is creditable input VAT |
| margin % / minimum margin % | 35 / 20 | below minimum → warning + approval |
| round_to (PHP) | 5 | 0 = no rounding |
| category default weights (kg) | see prototype `KG` constant | e.g. Batteries 25, Hardware 0.05, Wheels & Tires 10 |

### 5.3 Test cases (defaults above; effective fx = 65.00)
| Part | Dealer USD | Mode | Freight PHP | Landed PHP | Sell ex-VAT | Sell inc-VAT |
|---|---|---|---|---|---|---|
| 102505401 XMBR-MIDDLE (Frame, US, 6 kg) | 75.10 | sea | 585.78 | 6,519.36 | 10,030 | 11,233.60 |
| 102505401 | 75.10 | air | 3,510.00 | 10,006.30 | 15,395 | 17,242.40 |
| 1012571 WASHER 5/16 (Hardware, US, 0.05 kg) | 0.54 | sea | 4.21 | 46.88 | 75 | 84.00 |
| 1012571 | 0.54 | air | 29.25 | 76.73 | 120 | 134.40 |

### 5.4 Known costing issues to solve in production
1. **Weights.** Club Car data has no weights, so per-kg air freight uses category averages. Example: Minibus motor 47786510001 (10 kW, really ~30+ kg) is costed at 0.8 kg, so air comes out *cheaper* than sea. Fix: a per-part `weight_kg` field, editable by admin and bulk-importable. Also add a guard so air freight is never below sea freight for the same part (or a minimum air % of value).
2. **Dangerous goods.** Lithium batteries (e.g. 47786538002, 47769678002) can't fly as standard cargo. Flag `is_hazmat` and block or warn on air mode.
3. **Minimum charges.** Forwarders charge per-shipment minimums. v1 can ignore these. Possible later feature: a per-quote "shipment charges" line.

## 6. Price-list import pipeline

### 6.1 Source folder structure
```
Club Car/
  <Model>/                       e.g. "Precedent 2015", "Onward " (names have trailing spaces)
    Club Car Parts Book/*.pdf    full parts book, 12–58 MB, not parsed
    Parts/PartUpload_*.csv       "CC Part Number,QTY": fitment list for the model
    Price(s)/PartsPrice_*.pdf    Club Car "Cart Items" dealer quote: Item | Description | MSRP | Unit Price | Qty | Total
  carryall/CA300|CA500|CA700/... same pattern
  Tempo/Tempo/All Parts/... and Tempo/Tempo - New Dash/...
  Minibus 11 & 14/Price/2025 Minibus Complete Spare Parts Catalogue.pdf   NO | CC PN | Supplier 1 | Supplier 2 | Description | $ Price
```

### 6.2 Parsing notes (`scripts/ingest.py` handles all of these)
- In the Cart Items PDFs, descriptions wrap onto lines above and below the item row, and long prices wrap too ("USD" on one line, value on the next). Parse by word **x/y position** (pdfplumber), not text lines. Column x-positions vary per file, so read them from the page-1 header.
- Discounts vary: most parts are MSRP − 40%, batteries and SVP accessories −25%, tools net. Always use "Unit Price" as cost. Don't derive it.
- Price lists include superseded or replacement PNs not in the CSV lists. Keep them as priced parts for that model.
- Minibus CSVs use supplier codes (`CA-2913101-A`). Map them to Club Car PNs through the catalogue's supplier columns, stripping a trailing `-A`-style suffix.
- **Known gap:** Precedent 2009P is missing price files 02 and 06, so 363 of its parts are unpriced.

### 6.3 Production import flow (admin screen)
1. Admin uploads new price PDFs or CSVs for a model.
2. The server parses them using `ingest.py` logic.
3. Admin reviews a diff: new parts, removed parts, price changes over ±X%, parse warnings.
4. Admin publishes, which creates a new `price_list` with an effective date.

Keep old lists for history and for quotes already issued.

## 7. Screens

The prototype shows all of these working; see `screenshots/` and `prototype/`.

### 7.1 Sales: Find a part (`s_find.png`, `s_search.png`, `s_detail.png`)
- **Filters:** cart model (grouped Golf / Utility / Passenger), category list with live counts, and a "show parts not on price list" toggle.
- **Search box:**
  - Matches part number, description and alt codes.
  - Multiple words are ANDed, case-insensitive, any order.
  - Ranking: exact part-number match first, then part-number prefix.
  - Debounce ~120 ms. Supports partial PNs.
- **Unpriced parts** appear only when the toggle is on, or when the search is a single token that prefixes their PN. They show as "Price on request" and can't be added to a quote.
- **Results table:** part no., description (+ category, fits), dealer cost, landed cost, selling price, Add button. Paginate 150 at a time.
- **Row expand:** big selling price (+ VAT-inclusive), stacked cost bar, fits (all models), origin, dealer cost, MSRP, freight basis used, landed cost, supplier codes.
- **Sea / Air toggle:** global, re-prices everything.
- **Field visibility (decision needed, see §10):** should sales see dealer cost and landed cost at all? Production must enforce field visibility by role **on the server**. The prototype sends every dealer cost to the browser.

### 7.2 Sales: Quote (`s_quote.png`, `s_floor.png`; production adds the items marked NEW)
- **NEW:** customer picker (Zoho account + contact, §9.4) instead of a free-text customer field.
- **NEW:** "Deal details" panel holding the §9.3 fields, prefilled and editable.
- Reference, cart model, margin % (defaults to standard; warns below minimum).
- Lines: qty, kg/unit (only when the current mode is per-kg), landed/unit, price/unit, line total, remove.
- Totals: landed, sell ex-VAT, VAT 12%, total inc-VAT, gross profit and %.
- **NEW:** **Generate proposal** button runs the §8 and §9 flow. Afterwards the screen shows:
  - proposal no. and version
  - a Download PDF button
  - an "Open in Zoho" link (`https://crm.zoho.com/crm/org756940602/tab/Potentials/<deal id>`; confirm the URL format)
  - Zoho sync status (Synced / Pending / Failed + Retry)
- **NEW:** "My quotes" list with search and filters (draft / issued / won / lost / expired), plus re-open and revise.
- Internal copy (with landed cost and GP) stays available to Admin only, as an export.

### 7.3 Admin: Costing setup (`a_setup_top.png`, `a_forex.png`, `a_sea.png`, `a_air.png`, `a_duties.png`, `a_pricing.png`, `a_preview.png`)
- Every field in §5.2, grouped Forex / Sea / Air / Duties & charges / Pricing / Default weights.
- Live preview of a sample USD 100, 2 kg part by sea and by air.
- Save applies to all users immediately. Keep history (§4.2).

### 7.4 Admin: Users & access (`a_access.png`)
In the prototype this is section passwords. In production it is user management: invite, assign role, deactivate.

### 7.5 Admin: Parts data (`a_coverage.png`)
- Coverage per model: priced vs not priced.
- Plus the import flow (§6.3) and per-part edit: weight, category override, hazmat flag, notes.

### 7.6 Both
- Responsive. Sales use phones in the field (`s_mobile.png`).
- PHP formatting `₱1,234.56`. Prices never wrap.

## 8. PDF proposal

A sample layout is in `proposal/Sample Proposal - SP-GC-07680-v1.pdf`. Copy its structure. Terms wording, logo and contact details are placeholders until James confirms them (§12).

### 8.1 When it's made
- The rep presses **Generate proposal** on the Quote screen. Validation runs first (§9.3).
- Every change after a proposal is issued creates a **new version** (v2, v3…). Issued versions are read-only, so a rep can always show exactly what the customer received.

### 8.2 Numbering and file name
- Proposal number = `SP-<Zoho Deal No>-v<version>`, e.g. `SP-GC-07680-v1`.
- To get the Deal No, create the Zoho Deal before rendering the PDF (§9.4).
- If Zoho is unreachable, use a temporary `SP-TMP-<quote id>-v1`. Re-render with the real number once the Deal syncs, before the rep downloads.
- File name: `<proposal_no> - <Account name>.pdf`.

### 8.3 Content (top to bottom)
1. **Header:**
   - Golf Carts PH logo, SJK Guahan Inc. legal name and address (1877 Paz M. Guazon cor. Pres. Quirino Ave, Paco, Manila 1007 — confirm with James)
   - title "SPARE PARTS PROPOSAL"
   - proposal no., date, valid-until date, Zoho Deal No.
2. **Prepared for:** account name, contact name and title, address, email and phone, all from Zoho.
3. **Reference:** quote reference (e.g. "Tempo fleet brake service"), cart model, shipment mode with lead-time text, prepared-by rep.
4. **Line table:** #, part no., description (title case), "Fits: <models>", qty, unit price ex-VAT, amount.
5. **Totals:** subtotal (VAT-exclusive), VAT 12%, **total (VAT-inclusive)**.
6. **Terms & conditions:** admin-editable text block (validity, delivery, payment, warranty, exclusions). Store it as a setting, not hard-coded.
7. **Signature row:**
   - **Prepared by:** rep name, title, mobile, email
   - **Approved by:** shown only when the quote margin is below the minimum margin; names the approver
   - **Conforme:** customer signature, printed name, date
8. **Footer:** company name, proposal no., page x of y.

### 8.4 Rules
- **Never print** dealer cost, landed cost, margin, freight or duty amounts. Customer-facing prices only.
- Unit prices are the rounded selling prices from §5. Amount = unit × qty. Totals are sums of amounts. No re-rounding.
- Validity days are an admin setting (default 15). Valid-until = proposal date + validity days. This is also the Deal's Closing Date.
- Render server-side (HTML template → PDF via headless Chrome/Playwright or WeasyPrint) so every rep gets identical output. A4, one page for up to ~12 lines, then flows to more pages with the header repeated.
- Store every PDF version (object storage or database). Upload the same file to Zoho (§9.4).
- **Below-minimum margin:** the rep can't generate the PDF until an Admin approves the quote in the tool. Record the approver's name and time and print them in "Approved by". (Confirm this approval flow with James, §12.)

## 9. Zoho CRM integration (Deals)

Facts below were read from SJK's live Zoho CRM on 23 Nov 2026. Re-check field API names in the Zoho sandbox before coding.

### 9.1 Account and connection
- **Org:** SJK GUAHAN INC, Zoho One Enterprise. Zoho CRM org id `4983915000000020005`. Time zone Asia/Manila, currency PHP.
- **API:** Zoho CRM REST API, current version. Confirm the data centre in the API Console; the org reports country code US, so most likely `https://www.zohoapis.com` with `https://accounts.zoho.com` for OAuth.
- **Auth:** OAuth 2.0 *server-based* client in the Zoho API Console. Keep the refresh token on the server only.
- **Integration user:** use one dedicated Zoho user (ask James which). The rep is set as **Deal Owner**, so the deal still belongs to the right person; Created By will show the integration user.
- **Scopes:**
  - `ZohoCRM.modules.deals.ALL`
  - `ZohoCRM.modules.accounts.ALL`
  - `ZohoCRM.modules.contacts.ALL`
  - `ZohoCRM.modules.notes.CREATE`
  - `ZohoCRM.users.READ`
  - `ZohoCRM.settings.fields.READ`
  - `ZohoCRM.settings.layouts.READ`
  - `ZohoCRM.Files.CREATE`
  - `ZohoCRM.coql.READ`
- **Build and test in the Zoho CRM Sandbox first** (included with Enterprise). Then switch to production.

### 9.2 How SJK records parts deals today (copy this)
- **Pipeline `Spare Parts`.**
  - Two older duplicate pipelines exist: `SpareParts` (561 deals) and `Parts` (556). Never use them.
  - Also don't use the separate `Pipeline_Test1` field.
- **Layout `Service Layout New`**, id `4983915000040429371`.
- **New parts deals start at Stage `Proposal/Price Quote`.** Reps move them to `Negotiation/Review` and `Closed Won` / `Closed Lost` / `Closed-Lost to Competition` in Zoho.
- **`Amount` is entered VAT-inclusive.** Examples: deal GC-07651 ₱13,440 = ₱12,000 + 12%; GC-07629 ₱323,120 = ₱288,500 + 12%. Confirm with James.
- **`Unit Offered` (`Pick_List_6`)** for parts deals uses `GCPH Wear & Tear` (Club Car parts), `Battery`, `Tires`, or `GMPH Wear & Tear` (Ground Masters parts).
- **Deal names today are free text** ("Spare Parts Proposal for RTP CC-0147", "Controller 1515-5206"). The tool standardises them (§9.3).

### 9.3 Field mapping for a new Deal
Every field marked **Req** is mandatory in the "Service Layout New" layout. The tool must collect it before **Generate proposal** is enabled. Prefill from the account's most recent deal wherever possible, so the rep normally just confirms.

| Zoho field (API name) | Label | Req | Value |
|---|---|---|---|
| `Layout` | – | | `{"id":"4983915000040429371"}` |
| `Deal_Name` | Project Name | Req | `Spare Parts Proposal – <Account name> – <Reference>` (≤ 120 chars) |
| `Pipeline` | Pipeline | Req | `Spare Parts` (exact) |
| `Stage` | Stage | Req | `Proposal/Price Quote` on create; don't change on revisions |
| `Lead_Creation` | Deal Creation | | `Service` |
| `Account_Name` | Account Name | Req | `{"id": <zoho account id>}` |
| `Contact_Name` | Contact Name | | `{"id": <zoho contact id>}` |
| `Owner` | Deal Owner | | `{"id": <rep's zoho_user_id>}`; match app user ↔ Zoho user by email (`GET /users?type=ActiveUsers`) |
| `Type` | Type of Client | Req | `Existing Business` if the account has any Closed Won deal, else `New Business` (rep can override) |
| `Business_Type` | Business Type | Req | `Business-to-Business` or `Business-to-Consumer` (rep picks; prefill) |
| `Industry_B2B` / `Industry_B2C` | Industry | Req* | Fill the one matching Business_Type. B2B options in this layout: `Golf`, `Resort/Hospitality`. B2C: `Industrial Sector`, `Golf`, `Non-Golf`, `Malls`, `Universities`, `Parks`, `Municipalities`, `Farms`. *Both show as required in the layout; test in sandbox whether sending only the relevant one passes. |
| `SJK_Office_Location` | SJK Office Location | Req | Multi-select array, e.g. `["SJK Manila"]`. Values: `SJK Manila`, `SJK Vismin`, `SJK Sta. Rosa`. Default from the rep's profile |
| `Pick_List_6` | Unit Offered | Req | `Battery` if Batteries & Charging lines are the largest share of quote value; `Tires` if Wheels & Tires are; otherwise `GCPH Wear & Tear` |
| `Amount` | Amount | Req | Proposal **total VAT-inclusive** (§9.2) |
| `GO_Chance` | GO Chance | Req | `25%` / `50%` / `75%` / `100%`; rep picks, default `50%` |
| `GET_Chance` | GET Chance | Req | Same options, default `50%` |
| `Street` | Street | Req | Account billing street (`Accounts.Billing_Street`), editable |
| `City` | City | Req | Account billing city (`Accounts.Billing_City`), editable |
| `Closing_Date` | Closing Date | Req | Proposal valid-until date (YYYY-MM-DD) |
| `Lead_Source` | Lead Source | | Rep picks from the Zoho picklist. Default `Repeat Client` for existing accounts |
| `Description` | Description | | `Proposal <no>, <n> lines, <Sea/Air> freight. Created by SJK Parts Quoting Tool.` |
| `Proposal_Upload` | Proposal Upload | | The PDF (file-upload field; see §9.4) |

Picklist values must match Zoho exactly, including spaces and the `%` sign. Load them at start-up from `GET /settings/fields?module=Deals` and `GET /settings/layouts/4983915000040429371`, then cache. That way a picklist change in Zoho doesn't break the tool.

### 9.4 API sequence
**Customer selection (Quote screen):**
1. Account typeahead: `GET /crm/{ver}/Accounts/search?word=<text>` (from 2 characters, debounced).
2. Contacts for the chosen account: `GET /crm/{ver}/Accounts/{account_id}/Contacts`.
3. "New customer" form creates the records:
   - Account: `POST /Accounts` with `Account_Name`, `Billing_Street`, `Billing_City`, `Phone`.
   - Contact: `POST /Contacts` with `Last_Name` (required), `First_Name`, `Email`, `Mobile`, `Account_Name:{id}`.
   - Respect Zoho's duplicate-check response. If a duplicate is returned, offer the existing record instead.

**Generate proposal, first version:**
1. Validate the quote and the §9.3 required fields.
2. `POST /crm/{ver}/Deals` with `{"data":[{...§9.3 fields...}], "trigger":["workflow"]}`, so SJK's existing Zoho workflow rules still fire. Save the returned `id` as `zoho_deal_id`.
3. `GET /crm/{ver}/Deals/{id}?fields=Deal_No`. Save it as `zoho_deal_no` and build the proposal number (§8.2).
4. Render the PDF and store it.
5. `POST /crm/{ver}/files` (multipart) with the PDF, which returns a `file_id`. Then `PUT /crm/{ver}/Deals/{id}` with `{"data":[{"Proposal_Upload":[{"file_id":"<id>"}]}]}`.
6. `POST /crm/{ver}/Deals/{id}/Notes` with title `Proposal <no> issued` and content listing every line (part no, description, qty, unit price, amount) plus totals. This gives a readable record inside Zoho.

**Revision (v2+):** never create a second Deal for the same quote.
- `PUT /Deals/{id}` with the new `Amount` and `Closing_Date`.
- Add the new PDF to `Proposal_Upload` without removing earlier versions. Verify the add-vs-replace behaviour of file-upload fields in the sandbox.
- Add a new Note.
- Leave `Stage` alone; the rep manages it in Zoho.

**Optional nightly sync:** read `Stage` for open quotes' deals (COQL `select id, Stage from Deals where id in (...)`) and mark quotes won or lost.

### 9.5 Failure handling
- Zoho errors must **never lose the quote**. Save the quote first, then push to Zoho.
- On failure: set `zoho_sync_status = failed`, show a clear message with Zoho's error text (e.g. `MANDATORY_NOT_FOUND: GO_Chance`), and offer **Retry**. Retry automatically with backoff for 5xx and rate-limit errors.
- Before retrying a create, look for an existing deal (search by `Description` containing the quote id) so a retry can't make duplicates.
- Log every request and response (minus tokens) for support.

### 9.6 Acceptance tests (run in sandbox)
1. New quote for an existing account produces a Deal in pipeline `Spare Parts` at stage `Proposal/Price Quote`, with the correct owner, VAT-inclusive Amount, closing date = valid-until, and the PDF in Proposal Upload.
2. Revising it updates the same Deal (Amount, Closing Date, new PDF, new note). There is still exactly one Deal.
3. A quote of batteries gets Unit Offered `Battery`; tyres get `Tires`; anything else gets `GCPH Wear & Tear`.
4. Removing a required value (e.g. GO Chance) blocks Generate in the UI. It never reaches Zoho half-filled.
5. With Zoho down, the quote and PDF are saved, the status shows Failed / Retry, and a retry later succeeds without duplicates.
6. The customer PDF contains no cost, landed, margin or freight figures. Check by text search on the PDF.

## 10. Non-functional
- Search across ~5k parts should feel instant (<100 ms). Client-side filtering of a role-filtered dataset is fine at this size; server-side search is also fine.
- Users are in the Philippines on mobile data, so keep the payload small. The prototype's whole dataset is 287 KB.
- All money in decimal (not float) server-side; round only for display and at the final sell price.
- Back up the database daily. Keep costing-settings history.

## 11. Security (important)
The prototype is a single static page:
- All dealer costs ship to every browser.
- Section passwords are checked client-side, so they are a convenience, not security.

Production must:
- authenticate every user;
- authorise by role on the server;
- never send costing settings or (if James decides so) dealer and landed cost to the Sales role.

## 12. Open questions for James
1. Should sales see **dealer cost** and **landed cost**, or only the selling price?
2. Real **freight rates** (forwarder sea and air, US and China, minimum charges) and **duty rate** (HS code from broker).
3. **Margin policy and approval.** One standard margin, or by category or customer tier? Who approves below-minimum quotes? Is approval inside the tool OK (§8.4)?
4. Should **import VAT** be treated as cost (default: no)?
5. **Proposal content:** logo file, company phone, email and TIN for the header; final terms & conditions wording; validity days (sample uses 15); lead-time wording for sea and air.
6. **Zoho:**
   - Confirm `Amount` is entered VAT-inclusive.
   - Confirm the Unit Offered rule (§9.3) and the default GO/GET chance (50%).
   - Which Zoho user should be the integration account?
   - Should the old `SpareParts` and `Parts` pipelines be merged into `Spare Parts`? That's a separate Zoho clean-up.
7. **Platform:** standalone web app, or built inside SJK's Zoho One stack (Zoho Creator: Zoho logins, native CRM access, built-in PDF templates)? Developer to recommend, with the trade-offs.
8. **Hosting and sign-in:** Google Cloud, AWS, Vercel or on-prem? Zoho or Google SSO?
9. Who will refresh price lists, and how often does Club Car issue them?
10. Source for **part weights** (Club Car, forwarder invoices, or weighing stock)?
