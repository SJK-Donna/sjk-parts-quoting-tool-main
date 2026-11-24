# SJK Parts Quoting Tool — Developer Handoff

**Start here, then read `SPEC.md`.**

SJK Guahan (Golf Carts PH) needs a production **interactive quoting tool** for Club Car spare parts:

1. A sales rep picks a Zoho customer and adds parts.
2. The tool prices the parts from management's costing settings (forex, sea and air freight, duty, charges, margin).
3. It generates a **PDF proposal**.
4. It **creates or updates the Deal in Zoho CRM** with the PDF attached.

A working prototype covers the pricing and quoting part. The PDF and Zoho parts are fully specified in SPEC §8 and §9, with field-level detail taken from SJK's live Zoho CRM.

## What's in this pack

| Folder / file | What it is |
|---|---|
| `SPEC.md` | Requirements, data model, costing formula, screens, import pipeline, **PDF proposal (§8)**, **Zoho CRM deal integration (§9)**, test cases, open questions (§12) |
| `proposal/` | Sample proposal PDF (target layout) + its HTML as a starting template |
| `prototype/` | The working prototype (single HTML page + data). Run: `cd prototype && python3 -m http.server 8000`, open http://localhost:8000/#find (sales) or /#setup (admin) |
| `data/parts_master.csv` | Clean parts database: 4,781 rows (3,518 priced), one row per part number |
| `data/parts_data.json` | Same data in the compact format the prototype loads (format in SPEC §4.3) |
| `data/Club Car Parts Master.xlsx` | Same data for business users, with summaries by model and category |
| `scripts/ingest.py` | Re-builds the data from Club Car's raw price PDFs and parts-list CSVs |
| `screenshots/` | Every prototype screen |
| `guides/` | The end-user guides (sales and admin). They describe the intended workflow |

## Live prototype
- Sales: https://claude.ai/artifact/Jo5kkbXvVgu4aHaKZ98UiT#find
- Admin: https://claude.ai/artifact/Jo5kkbXvVgu4aHaKZ98UiT#setup
(Ask James for access. The prototype's settings storage is specific to the Claude platform; replace it in production.)

## Raw source data
Not included in this pack (≈ 450 MB of parts-book PDFs). It lives in James's folder
`Desktop/SJK/GCPH/Service Quoting tool/Club Car/`. Structure is in SPEC §6. Ask James for a copy of the
`Club Car` folder if you need to run `ingest.py`.

## Contact
James Robert Ugarte — General Manager, SJK Guahan Inc. (product owner)
