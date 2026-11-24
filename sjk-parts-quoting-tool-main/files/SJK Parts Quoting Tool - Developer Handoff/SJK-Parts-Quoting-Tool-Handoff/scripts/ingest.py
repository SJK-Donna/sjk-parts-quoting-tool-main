#!/usr/bin/env python3
"""
SJK Parts Costing - Club Car price data import.

Reads the Club Car source folder (one sub-folder per cart model, each with
Parts/*.csv fitment lists and Price(s)/*.pdf dealer price quotes, plus the
Minibus catalogue PDF) and writes:
  <out>/parts_data.json   compact file the prototype front end loads
  <out>/parts_master.csv  one row per part, human-readable

Usage:  python3 ingest.py "<path to Club Car folder>" <out_dir>
Needs:  pip install pdfplumber ; poppler-utils (pdftotext) on PATH
"""
import sys, os, re, csv, json, glob, subprocess, collections
import pdfplumber

ROOT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

MODELS = [("Tempo","Golf"),("Tempo (New Dash)","Golf"),("Onward","Golf / Personal"),
          ("Precedent 2019","Golf"),("Precedent 2015","Golf"),("Precedent 2009P","Golf"),
          ("Carryall 300","Utility"),("Carryall 500","Utility"),("Carryall 700","Utility"),
          ("Transporter 4 & 6","Passenger"),("Villager 6 & 8","Passenger"),
          ("Villager 6 & 8 (AC)","Passenger"),("Minibus 11 & 14","Passenger")]
MI = {m: i for i, (m, _) in enumerate(MODELS)}
MINIBUS = "Minibus 11 & 14"

def model_of(path):
    """Folder name -> canonical model name. Folder names carry trailing spaces."""
    p = os.path.relpath(path, ROOT).split(os.sep)
    if p[0] == "carryall":
        return {"CA300": "Carryall 300", "CA500": "Carryall 500", "CA700": "Carryall 700"}[p[1]]
    if p[0] == "Tempo":
        return "Tempo" if p[1] == "Tempo" else "Tempo (New Dash)"
    return p[0].strip()

# ---------- 1. Club Car dealer price quotes (PDF "Cart Items" tables) ----------
# Columns: Item | Item Description | MSRP | Unit Price | Quantity | Total Price.
# Descriptions wrap onto lines above/below the item row and long prices wrap
# ("USD" on one line, value below), so parse by word position, not by lines.
NUM = re.compile(r'^[\d,]+\.\d{2}$')
rows = []
for f in sorted(glob.glob(ROOT + "/**/*.pdf", recursive=True)):
    if "Parts Book" in f or MINIBUS.split()[0] in f:
        continue
    model = model_of(f)
    pdf = pdfplumber.open(f)
    hdr = pdf.pages[0].extract_words()
    hx = lambda t: [w['x0'] for w in hdr if w['text'] == t][0]
    cx = dict(msrp=hx("MSRP"), unit=hx("Unit"), qty=hx("Quantity"))
    for pg in pdf.pages:
        ws = pg.extract_words()
        anchors = []
        for a in ws:   # part numbers sit in the left column (x < 100)
            if a['x0'] < 100 and re.match(r'^[A-Za-z0-9][A-Za-z0-9\-\.]+$', a['text']) \
               and a['text'] not in ("Item", "Page") \
               and any(abs(w['top'] - a['top']) < 16 and w['text'] == "USD" for w in ws):
                anchors.append(dict(pn=a['text'], top=a['top'], desc=[], msrp=[], unit=[]))
        if not anchors:
            continue
        for w in ws:   # assign each word to the nearest item row by vertical distance
            if w['x0'] < 100:
                continue
            best = min(anchors, key=lambda a: abs(a['top'] - w['top']))
            dy = abs(best['top'] - w['top'])
            if dy > 14:
                continue
            if w['x0'] < cx['msrp'] - 4:
                best['desc'].append(w)
            elif NUM.match(w['text']):
                v = float(w['text'].replace(',', ''))
                if w['x0'] < cx['unit'] - 4:  best['msrp'].append((dy, v))
                elif w['x0'] < cx['qty'] - 4: best['unit'].append((dy, v))
        for a in anchors:
            if not a['unit']:
                continue
            d = " ".join(x['text'] for x in sorted(a['desc'], key=lambda w: (round(w['top'] / 3), w['x0'])))
            rows.append(dict(model=model, pn=a['pn'], desc=d.replace('""', '"'),
                             msrp=min(a['msrp'])[1] if a['msrp'] else None,
                             cost=min(a['unit'])[1], file=os.path.basename(f)))

P = {}
for r in rows:
    p = P.setdefault(r['pn'], dict(p=r['pn'], d=r['desc'], c=r['cost'], m=r['msrp'], o="US",
                                   k=set(), a=[], src=r['file']))
    p['k'].add(MI[r['model']])
    if len(r['desc']) > len(p['d']):
        p['d'] = r['desc']

# ---------- 2. Minibus catalogue (FCA China, one table) ----------
mb = {}
for cat in glob.glob(ROOT + "/Minibus*/Price*/*.pdf"):
    txt = subprocess.run(["pdftotext", "-layout", cat, "-"], capture_output=True, text=True).stdout
    rx = re.compile(r'^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*?)\s+\$\s+([\d,]+\.\d+)\s*$')
    for line in txt.splitlines():
        mm = rx.match(line)
        if not mm:
            continue
        _, pn, s1, s2, d, pr = mm.groups()
        alts = [x for x in (s1, s2) if x not in ("#N/A", "0")]
        if pn not in P:
            P[pn] = dict(p=pn, d=d.strip(), c=float(pr.replace(',', '')), m=None, o="CN",
                         k={MI[MINIBUS]}, a=alts, src=os.path.basename(cat))
        for x in alts + [pn]:
            mb[x] = pn

# ---------- 3. Fitment from parts-book CSV upload lists ----------
unpriced = collections.defaultdict(set)
for f in glob.glob(ROOT + "/**/*.csv", recursive=True):
    m = model_of(f)
    for r in csv.reader(open(f, encoding='utf-8-sig')):
        if not r or r[0] == "CC Part Number":
            continue
        pn = r[0].strip()
        key = pn if pn in P else mb.get(pn) or mb.get(re.sub(r'-[A-Z]$', '', pn))
        if key and key in P: P[key]['k'].add(MI[m])
        else:                unpriced[pn].add(MI[m])

# ---------- 4. Category by keyword (first match wins; order matters) ----------
# Seats and Steering run before Lighting so "LIGHT BEIGE" seats and "LEAF SPRING, LIGHT" stay out of Lighting.
R = [("Shop Tools & Service", r"\b(TOOL|PULLER|REAMER|CUTTER|GAUGE|HYDROMETER|THERMOMETER|TESTER|DISCHARGE UNIT|SEAL PULLER|YOKE|ADAPTER, \d)"),
 ("Decals & Labels", r"\b(DECAL|STRIPE|LABEL|EMBLEM|BADGE|BRANDING|NAMEPLATE)"),
 ("Hardware & Fasteners", r"^(ASM,? |KIT,? )?(SCREW|BOLT|NUT|LOCKNUT|WASHER|LOCKWASHER|CLIP|RIVET|PIN|STUD|SPACER|RETAINER|CLAMP|GROMMET|SHIM|RING|SNAP RING|O-RING|KEY,|BARREL|U-NUT|J-CLIP|CAPSCREW|CAP SCREW|SETSCREW|TIE|CABLE TIE|PUSH|E-RING|COTTER|HOSE CLAMP|M\d|\d/\d|#\d)\b"),
 ("Batteries & Charging", r"\b(BATTERY|BATT|BATTERIES|CHARGER|CHARGING|CHARGE|CORD|REEL|DEIONIZER|WATERING|RECEPTACLE|ONBD|LITHIUM|LI,)"),
 ("Seats & Restraints", r"\b(SEAT|SEATS|SEATBELT|BELT, SEAT|BACKREST|BACK REST|SEATBACK|CUSHION|HIP RESTRAINT|RESTRAINT|ARMREST|HEADREST|GRAB BAR|HANDLE, GRAB)"),
 ("Steering & Suspension", r"\b(STEERING|STR |TIE ROD|SPINDLE|KING ?PIN|SHOCK|ABSORBER|LEAF|SPRING, LEAF|A-ARM|CONTROL ARM|SWING ARM|SNUBBER|RACK|PINION|BALL JOINT|SUSPENSION|BUSHING|STRUT, FRONT|KNUCKLE|TORSION|STABILIZER)"),
 ("Lighting", r"\b(LIGHT(?![ ,]*(BEIGE|GRAY|GREY|DUTY|WEIGHT))|LIGHTS|LAMP|LED|HEADLIGHT|TAILLIGHT|BULB|LENS)\b"),
 ("Wheels & Tires", r"\b(TIRE|TIRES|WHEEL|WHL|RIM|HUBCAP|HUB CAP|LUG|KENDA|VALVE STEM|WHEEL COVER)"),
 ("Brakes & Pedals", r"\b(BRAKE|BRAKES|CALIPER|ROTOR|PAD|PADS|SHOE|SHOES|PEDAL|PARK|MASTER CYL|DRUM)"),
 ("Engine & Fuel", r"\b(KOHLER|ENGINE|FUEL|CARB|CARBURETOR|PISTON|CRANKSHAFT|CAMSHAFT|CAM|VALVE|GOVERNOR|INTAKE|EXHAUST|MUFFLER|OIL|AIR FILTER|FILTER|SPARK|STARTER|CYLINDER|EFI|THROTTLE|CHOKE|ROCKER ARM|ROCKER COVER|FLYWHEEL|CONNECTING ROD|HEAD GASKET|GASKET|CRANKCASE|TAPPET|PUSH ROD|PUSHROD|BREATHER|DIPSTICK|INJECTOR|GAS)\b"),
 ("Drivetrain & Clutch", r"\b(CLUTCH|TRANSAXLE|DIFFERENTIAL|AXLE|GEAR|GEARS|BELT|SYNCHRONIZER|SHIFTER|DRIVE|DRIVEN|BEARING|SEAL|HUB|GEARCASE|UNITIZED|SHAFT|DIFF)\b"),
 ("Electrical & Controls", r"\b(HARNESS|HARN|WIRE|WIRES|SWITCH|KEYSW|FUSE|RELAY|CONTROLLER|SOLENOID|SENSOR|MOTOR|TERMINAL|FNR|CONVERTER|HORN|MODULE|ELEC|ELECTRIC|BUZZER|RESISTOR|DIAGNOSTIC|MCOR|POTENTIOMETER|DISPLAY|LCD|DASHBOARD|USB|KEY SWITCH|ACCELERATOR|CABLE, BATTERY|BTY CABLE|CAMERA|RADIO|SPEAKER|BROADCASTER|WIPER|E-STOP|INVERTER|CIRCUIT|CONNECTOR|BREAKER|ODOMETER|METER)\b"),
 ("Canopy, Roof & Windshield", r"\b(CANOPY|ROOF|TOP|WINDSHIELD|ENCLOSURE|STRUT|STRUTS|RAIN|SUNTOP)\b"),
 ("Cargo Bed & Utility", r"\b(BED|CARGO|BOX|STAKE|VAN|TAILGATE|HITCH|DUMP|LIFT|BUCKET|RACK|TOW)\b"),
 ("Accessories", r"\b(BAG|COOLER|SAND|BOTTLE|BALL WASHER|SCORECARD|HOOP|UMBRELLA|CUP HOLDER|CLUB|ARM ?REST|MIRROR|FLOORMAT|FLOOR MAT|BRUSH GUARD|COVER, STORAGE|ACCESSORY|ICE CHEST|BASKET)"),
 ("Body & Trim", r"\b(PANEL|PNL|COWL|BUMPER|FENDER|DASH|DOOR|TRIM|BODY|ROCKER|COVER|GUARD|INSERT|GLOVE|HINGE|LATCH|BEAUTY|BROW|SKIRT|SPLASH|MOLDING|BEZEL|GRILLE|HOOD|COMPARTMENT|STORAGE|CAP|SEAL, STRIP|FLOOR|PLATE)"),
 ("Frame & Chassis", r"\b(FRAME|WELDMENT|XMBR|CROSSMEMBER|CHASSIS|BRACKET|BRKT|BKT|MOUNT|MTG|SUPPORT|BRACE|BEAM|BAR|TUBE|ROD)"),
 ("Hardware & Fasteners", r"\b(SCREW|BOLT|NUT|WASHER|CLIP|RIVET|PIN|STUD|SPACER|LOCKNUT|RETAINER|CLAMP|GROMMET|SHIM|RING|SPRING|PLUG|HOSE)\b"),
 ("Batteries & Charging", r"\b(SPWS|SPW|HOLD DOWN)"),
 ("Hardware & Fasteners", r"\b(PUSHNUT|CIRCLIP|KEY,? (WOODRUF|SUNK|SHORT|3/16)|KEY SUNK|KEY - SHORT|SCR|SEMS|FHCS|SHCS|HWHCS|FITTING|COLLET|SEALANT)\b"),
 ("Engine & Fuel", r"\b(JET|FLOAT|COIL|IGNITION|SHROUD|FAN|RPM|LIMITER|LASH|FE350|FE290|TUNE UP|EVAP|CANISTER|PTO)"),
 ("Drivetrain & Clutch", r"\b(MOVEABLE FACE|FXD FACE|FIXED FACE|SYNCHRO|EQUALIZER|TRANS SHIFT|CAGE, ROLLER)"),
 ("Steering & Suspension", r"\b(DELTA|CLEVIS|BELLOWS|LINK, DRAG|JOINT, BALL)"),
 ("Electrical & Controls", r"\b(DIODE|ARMATURE|BRUSH|COMMUTATOR|HEADBAND|FERRITE|FUSEHOLDER|TURN SIGNAL|REGULATOR|AMMETER|VOLT|ST/GEN|IQDM|JUMPER|ISOLATOR|CABLE|KEYS)"),
 ("Lighting", r"\b(REFLECTOR)"),
 ("Body & Trim", r"\b(FOOTDECK|FASCIA|UNDERBODY|FOOT REST|SHIELD|CONTAINER|STIFFENER|WEDGE)"),
 ("Frame & Chassis", r"\b(CROSS MEMBER|STRUCTURE|WLDMT)")]
RC = [(n, re.compile(x)) for n, x in R]
def classify(d):
    u = d.upper()
    return next((n for n, rx in RC if rx.search(u)), "Other")

# ---------- 5. Output ----------
parts = [dict(p=p['p'], d=p['d'], c=p['c'], m=p['m'], o=p['o'], g=classify(p['d']),
              k=sorted(p['k']), a=p['a'], src=p['src']) for p in P.values()]
for pn, ks in unpriced.items():
    parts.append(dict(p=pn, d="", c=None, m=None, o="CN" if MI[MINIBUS] in ks else "US",
                      g="Not on price list", k=sorted(ks), a=[], src=""))
parts.sort(key=lambda x: (x['c'] is None, x['p']))
cats = sorted({x['g'] for x in parts}); CI = {c: i for i, c in enumerate(cats)}
json.dump(dict(v=os.environ.get("DATA_VERSION", ""), models=MODELS, cats=cats,
               rows=[[x['p'], x['d'], x['c'], x['m'], 0 if x['o'] == "US" else 1, CI[x['g']], x['k'], x['a']] for x in parts]),
          open(os.path.join(OUT, "parts_data.json"), "w"), separators=(',', ':'))
with open(os.path.join(OUT, "parts_master.csv"), "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["part_no", "description", "category", "fits_models", "origin", "dealer_cost_usd",
                "msrp_usd", "alt_codes", "price_status", "source_file"])
    for x in parts:
        w.writerow([x['p'], x['d'], x['g'], "; ".join(MODELS[i][0] for i in x['k']),
                    "US" if x['o'] == "US" else "CN", x['c'] if x['c'] is not None else "",
                    x['m'] if x['m'] is not None else "", "; ".join(x['a']),
                    "priced" if x['c'] is not None else "not_on_price_list", x['src']])
print(f"{len(parts)} parts, {sum(1 for x in parts if x['c'] is not None)} priced -> {OUT}")
