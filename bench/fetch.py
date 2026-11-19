# Download a test corpus of photographs from Wikimedia Commons.
# usage: python3 -I bench/fetch.py [outdir=bench/data/photos]
# Resumable; rate-limited politely. Photos are only used locally for testing.
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "bench/data/photos"
UA = "OstinascopeBench/0.1 (prototype testing)"
API = "https://commons.wikimedia.org/w/api.php"
PER = 4
# label: (expected, kind, [category names] or search query)
SETS = {
    "blinds": ("line", "cat", ["Venetian blinds", "Window blinds"]),
    "zebra": ("line", "cat", ["Zebra crossings in Japan", "Zebra crossings"]),
    "stairs": ("line", "cat", ["Stairs"]),
    "piano": ("line", "cat", ["Piano keyboards"]),
    "fence": ("line", "cat", ["Picket fences", "Wooden fences"]),
    "brick": ("lattice", "cat", ["Brick walls", "Brickwork"]),
    "chainlink": ("lattice", "cat", ["Chain-link fences"]),
    "keyboard": ("lattice", "cat", ["Computer keyboards"]),
    "polka": ("lattice", "cat", ["Polka dots", "Polka dot patterns"]),
    "facade": ("lattice", "cat", ["Windows in grid pattern", "Curtain walls"]),
    "bottles": ("row", "search", "row of bottles shelf"),
    "chairs": ("row", "search", "row of chairs"),
    "cups": ("row", "search", "cups lined up"),
    "bikes": ("row", "search", "parked bicycles row"),
    "lamps": ("row", "search", "street lamps row"),
    "shoes": ("row", "search", "shoes lined up"),
    "jars": ("row", "search", "jars on shelf"),
    "portrait": ("none", "cat", ["Portrait photographs of men", "Portrait photographs of women"]),
    "nature": ("none", "cat", ["Forests", "Grasses"]),
    "food": ("none", "cat", ["Food photographs", "Japanese cuisine"]),
    "desk": ("none", "cat", ["Desks", "Offices"]),
    "gravel": ("none", "cat", ["Gravel", "Sand textures"]),
    "room": ("none", "cat", ["Living rooms", "Kitchens"]),
    "street": ("none", "cat", ["Streets in Tokyo", "Street scenes"]),
}


def fetch(url):
    for a in range(6):
        try:
            time.sleep(1.5)
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(15 * (a + 1))
    raise RuntimeError("gave up")


def api(params):
    return json.loads(fetch(API + "?" + urllib.parse.urlencode({**params, "format": "json"})))


def listing(kind, src):
    common = {"prop": "imageinfo", "iiprop": "url|size|mime", "iiurlwidth": 960}
    if kind == "search":
        d = api({"action": "query", "generator": "search", "gsrnamespace": 6, "gsrsearch": src + " filetype:bitmap", "gsrlimit": 12, **common})
        pages = sorted(d.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    else:
        d = api({"action": "query", "generator": "categorymembers", "gcmtitle": "Category:" + src, "gcmtype": "file", "gcmlimit": 30, **common})
        pages = sorted(d.get("query", {}).get("pages", {}).values(), key=lambda p: p["title"])
        step = max(1, len(pages) // PER)
        pages = pages[::step]
    out = []
    for p in pages:
        ii = (p.get("imageinfo") or [{}])[0]
        if ii.get("mime") == "image/jpeg" and (ii.get("width") or 0) >= 700:
            out.append((p["title"], ii.get("thumburl") or ii.get("url")))
    return out


os.makedirs(OUT, exist_ok=True)
mpath = os.path.join(OUT, "manifest.json")
man = json.load(open(mpath)) if os.path.exists(mpath) else []
for label, (expect, kind, src) in SETS.items():
    got = sum(1 for m in man if m["label"] == label)
    for one in (src if isinstance(src, list) else [src]):
        if got >= PER:
            break
        try:
            items = listing(kind, one)
        except Exception as e:  # noqa
            print("list fail", one, e, file=sys.stderr)
            continue
        for title, url in items:
            if got >= PER:
                break
            if any(m["title"] == title for m in man):
                continue
            try:
                data = fetch(url)
            except Exception as e:  # noqa
                print("dl fail", title, e, file=sys.stderr)
                continue
            name = f"{label}_{got}.jpg"
            open(os.path.join(OUT, name), "wb").write(data)
            man.append({"file": name, "label": label, "expect": expect, "title": title})
            got += 1
    print(label, got, file=sys.stderr, flush=True)
    json.dump(man, open(mpath, "w"), ensure_ascii=False, indent=1)
print(len(man), "photos")
