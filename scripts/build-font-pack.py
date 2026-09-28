"""Build the fallback font pack served from /public/fonts/pack.

When an edited PDF needs a glyph its embedded (subset) font doesn't contain, the editor uses the SAME
typeface from this pack (e.g. Montserrat ExtraBold for a Canva catalog) or a metric-compatible clone
for Office fonts (Calibri→Carlito, Arial→Arimo, Times New Roman→Tinos…). All fonts are OFL/Apache.

Each face is downloaded as TTF from Google Fonts and subset to Latin-1 + Latin Extended-A +
punctuation/currency, without hinting or layout tables (PDF renderers need neither), ~20–40 KB each.

Requires fontTools:  python -m pip install fonttools
Usage:               python scripts/build-font-pack.py
"""
import json, os, re, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from fontTools import subset
from fontTools.ttLib import TTFont

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "fonts", "pack")
UA = "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; en-us) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1"  # makes Google Fonts serve plain TTF

FAMILIES = {
    "sans": [
        "Inter", "Roboto", "Open Sans", "Montserrat", "Lato", "Poppins", "Nunito", "Nunito Sans", "Raleway", "Oswald",
        "Source Sans 3", "Noto Sans", "PT Sans", "Work Sans", "DM Sans", "Rubik", "Barlow", "Mulish", "Ubuntu",
        "Quicksand", "Manrope", "Figtree", "Plus Jakarta Sans", "Fira Sans", "Karla", "Josefin Sans", "Titillium Web",
        "Roboto Condensed", "Archivo", "Kanit", "Heebo", "Outfit", "Lexend", "League Spartan", "Bebas Neue", "Anton",
        "Arimo", "Carlito",
    ],
    "serif": [
        "Playfair Display", "Merriweather", "Lora", "Libre Baskerville", "PT Serif", "Noto Serif", "EB Garamond",
        "Crimson Text", "Roboto Slab", "Cormorant Garamond", "Tinos", "Caladea", "Gelasio",
    ],
    "mono": ["Roboto Mono", "Source Code Pro", "IBM Plex Mono", "JetBrains Mono", "Cousine"],
}
WEIGHTS = [300, 400, 500, 600, 700, 800, 900]
ITALIC_WEIGHTS = [400, 700]

# Common non-Google fonts → closest face in the pack (metric-compatible where one exists).
ALIASES = {
    "arial": "arimo", "helvetica": "arimo", "helveticaneue": "inter", "liberationsans": "arimo", "nimbussans": "arimo",
    "timesnewroman": "tinos", "times": "tinos", "timesroman": "tinos", "liberationserif": "tinos", "nimbusroman": "tinos",
    "couriernew": "cousine", "courier": "cousine", "liberationmono": "cousine", "nimbusmono": "cousine",
    "calibri": "carlito", "cambria": "caladea", "georgia": "gelasio",
    "segoeui": "opensans", "segoe": "opensans", "verdana": "opensans", "tahoma": "opensans",
    "garamond": "ebgaramond", "sourcesanspro": "sourcesans3", "canvasans": "opensans",
    "charis": "ptserif", "charissil": "ptserif", "charter": "ptserif", "bitstreamcharter": "ptserif", "dejavuserif": "ptserif",
    "dejavusans": "opensans", "liberationsansnarrow": "arimo", "trebuchetms": "firasans", "centurygothic": "montserrat",
    "gillsans": "lato", "gillsansmt": "lato", "bookantiqua": "ebgaramond", "palatinolinotype": "ebgaramond", "palatino": "ebgaramond",
    "constantia": "ptserif", "candara": "lato", "corbel": "opensans", "franklingothic": "archivo", "franklingothicmedium": "archivo",
    "lucidasans": "opensans", "lucidagrande": "opensans", "sfprotext": "inter", "sfprodisplay": "inter", "aptos": "inter",
    "nimbusromno9l": "tinos", "nimbussanl": "arimo", "nimbusmonl": "cousine", "nimbusromanno9l": "tinos",
    "cmr": "tinos", "cmbx": "tinos", "cmti": "tinos", "cmsl": "tinos", "cmcsc": "tinos", "lmroman": "tinos",
    "cmss": "arimo", "lmsans": "arimo", "cmtt": "cousine", "lmmono": "cousine", "cmu": "tinos", "cmuserif": "tinos",
    "arialnarrow": "robotocondensed", "arialblack": "arimo", "impact": "oswald", "minionpro": "crimsontext",
    "minion": "crimsontext", "myriadpro": "sourcesans3", "myriad": "sourcesans3", "adobegaramondpro": "ebgaramond",
    "adobegaramond": "ebgaramond", "gotham": "montserrat", "proximanova": "figtree", "avenir": "figtree",
    "avenirnext": "figtree", "dinpro": "barlow", "din": "barlow", "dinnextltpro": "barlow", "bahnschrift": "barlow",
    "consolas": "cousine", "menlo": "cousine", "monaco": "cousine", "sfmono": "jetbrainsmono", "freeserif": "tinos",
    "freesans": "arimo", "freemono": "cousine", "stixgeneral": "tinos", "stix": "tinos", "stixtwotext": "tinos",
    "texgyretermes": "tinos", "texgyreheros": "arimo", "texgyrecursor": "cousine", "texgyrepagella": "ebgaramond",
    "urwpalladio": "ebgaramond", "centuryschoolbook": "ptserif", "bookmanoldstyle": "ptserif", "sylfaen": "ptserif",
    "gentium": "ptserif", "gentiumplus": "ptserif", "cardo": "ebgaramond",
}
UNICODES = "U+0020-007E,U+00A0-00FF,U+0100-017F,U+0192,U+02C6,U+02C7,U+02D8-02DD,U+2013-2014,U+2018-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20AC,U+2122,U+2212"

slug = lambda name: re.sub(r"[^a-z0-9]", "", name.lower())


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf8")


def face_job(family, weight, italic):
    fam_q = family.replace(" ", "+")
    spec = f"ital,wght@1,{weight}" if italic else f"wght@{weight}"
    try:
        css = fetch(f"https://fonts.googleapis.com/css2?family={fam_q}:{spec}")
    except urllib.error.HTTPError:
        return None  # weight not available for this family
    m = re.search(r"src:\s*url\(([^)]+)\)", css)
    if not m:
        return None
    raw = fetch(m.group(1), binary=True)
    name = f"{slug(family)}-{weight}{'i' if italic else ''}.ttf"
    tmp = os.path.join(OUT, name + ".full")
    with open(tmp, "wb") as f:
        f.write(raw)
    opts = subset.Options()
    opts.layout_features = []
    opts.hinting = False
    opts.drop_tables += ["GSUB", "GPOS", "GDEF", "DSIG", "STAT", "fvar", "gvar", "avar", "HVAR", "MVAR"]
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    opts.notdef_outline = True
    font = TTFont(tmp)
    if "glyf" not in font:  # CFF-flavoured OpenType is fine for fontkit, but keep glyf for pdf-lib subsetting
        font.close()
        os.remove(tmp)
        return None
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    font.save(os.path.join(OUT, name))
    font.close()
    os.remove(tmp)
    return (slug(family), family, weight, italic, name, os.path.getsize(os.path.join(OUT, name)))


# Last-resort faces for characters no Latin face has (Greek, Cyrillic, arrows, maths, check marks, dingbats...).
# DejaVu: Bitstream Vera license + public-domain changes, redistributable.
DEJAVU = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/"
UNIVERSAL = {
    "sans": {"400": "DejaVuSans.ttf", "700": "DejaVuSans-Bold.ttf", "400i": "DejaVuSans-Oblique.ttf", "700i": "DejaVuSans-BoldOblique.ttf"},
    "serif": {"400": "DejaVuSerif.ttf", "700": "DejaVuSerif-Bold.ttf", "400i": "DejaVuSerif-Italic.ttf", "700i": "DejaVuSerif-BoldItalic.ttf"},
    "mono": {"400": "DejaVuSansMono.ttf", "700": "DejaVuSansMono-Bold.ttf"},
}
UNIVERSAL_UNICODES = ("U+0020-007E,U+00A0-024F,U+0250-02FF,U+0370-03FF,U+0400-052F,U+1E00-1EFF,U+2000-206F,U+2070-209F,"
                      "U+20A0-20CF,U+2100-218F,U+2190-23FF,U+2460-24FF,U+2500-27BF,U+27C0-27FF,U+2900-2BFF,U+FB00-FB06")


def universal_job(cat, key, file):
    raw = fetch(DEJAVU + file, binary=True)
    name = f"universal-{cat}-{key}.ttf"
    tmp = os.path.join(OUT, name + ".full")
    with open(tmp, "wb") as f:
        f.write(raw)
    opts = subset.Options()
    opts.layout_features = []
    # Keep the TrueType instructions: without them MuPDF draws nothing for DejaVu's glyphs.
    opts.drop_tables += ["GSUB", "GPOS", "GDEF", "DSIG", "STAT", "MATH", "FFTM"]
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    opts.notdef_outline = True
    font = TTFont(tmp)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNIVERSAL_UNICODES))
    sub.subset(font)
    font.save(os.path.join(OUT, name))
    font.close()
    os.remove(tmp)
    return name, os.path.getsize(os.path.join(OUT, name))


def build_universal(manifest):
    out, total = {}, 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(universal_job, cat, key, file): (cat, key) for cat, faces in UNIVERSAL.items() for key, file in faces.items()}
        for fut, (cat, key) in futs.items():
            name, size = fut.result()
            out.setdefault(cat, {})[key] = name
            total += size
    manifest["universal"] = out
    return total


def main():
    if "--universal-only" in sys.argv:
        path = os.path.join(OUT, "manifest.json")
        with open(path, encoding="utf8") as f:
            manifest = json.load(f)
        manifest["aliases"] = ALIASES
        total = build_universal(manifest)
        with open(path, "w", encoding="utf8") as f:
            json.dump(manifest, f, indent=1, sort_keys=True)
        print(f"universal faces: {total/1024/1024:.2f} MB")
        return
    os.makedirs(OUT, exist_ok=True)
    jobs = []
    for cat, fams in FAMILIES.items():
        for fam in fams:
            for w in WEIGHTS:
                jobs.append((cat, fam, w, False))
            for w in ITALIC_WEIGHTS:
                jobs.append((cat, fam, w, True))
    manifest = {"version": 1, "families": {}, "aliases": ALIASES}
    total = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(face_job, fam, w, it): (cat, fam) for cat, fam, w, it in jobs}
        for fut, (cat, fam) in futs.items():
            try:
                res = fut.result()
            except Exception as e:  # network hiccup: skip the face, report
                print("skip", fam, e, file=sys.stderr)
                continue
            if not res:
                continue
            s, name, w, it, file, size = res
            total += size
            entry = manifest["families"].setdefault(s, {"name": name, "category": cat, "faces": {}})
            entry["faces"][f"{w}{'i' if it else ''}"] = file
    total += build_universal(manifest)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf8") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    faces = sum(len(v["faces"]) for v in manifest["families"].values())
    print(f"{len(manifest['families'])} families, {faces} faces, {total/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
