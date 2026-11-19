# Contact sheet of results: regions (ROW members as small boxes), GT outlines.
# usage: python3 -I bench/sheet.py <viewsDir> <res.json> <out.png> [filter] [max]
import json, sys
from PIL import Image, ImageDraw
d, res, outp = sys.argv[1:4]
filt = sys.argv[4] if len(sys.argv) > 4 else ""
mx = int(sys.argv[5]) if len(sys.argv) > 5 else 24
rows = [v for v in json.load(open(res)) if filt in v["view"]][:mx]
COL = {"STRIPE": (255, 210, 31), "GRID": (255, 75, 54), "DOTS": (255, 255, 255), "CONCENTRIC": (124, 157, 255), "RADIAL": (0, 220, 255), "ROW": (91, 227, 155)}
tiles = []
for v in rows:
    im = Image.open(f"{d}/{v['view'].split('_f')[0]}.png").convert("RGB").resize((v["w"] * 2, v["h"] * 2))
    dr = ImageDraw.Draw(im)
    for g in v.get("gt", []):
        dr.polygon([(x * 2, y * 2) for x, y in g["poly"]], outline=(255, 0, 255))
    for r in v["regions"]:
        c = COL.get(r["type"], (255, 255, 255))
        dr.rectangle([r["x"] * 2, r["y"] * 2, (r["x"] + r["w"]) * 2, (r["y"] + r["h"]) * 2], outline=c, width=2)
        for m in r.get("members") or []:
            dr.rectangle([m["x"] * 2 + 2, m["y"] * 2 + 2, (m["x"] + m["w"]) * 2 - 2, (m["y"] + m["h"]) * 2 - 2], outline=c, width=2)
        dr.text((r["x"] * 2 + 4, r["y"] * 2 + 3), f"{r['type'][:3]}{'×' + str(r['count']) if r.get('count') else ''} p{r['period']:.0f}", fill=c)
    dr.rectangle([0, 0, 170, 12], fill=(0, 0, 0)); dr.text((2, 1), v["view"][:30], fill=(255, 255, 255))
    tiles.append(im)
tw = max(t.width for t in tiles); th = max(t.height for t in tiles)
S = Image.new("RGB", (8 * tw, ((len(tiles) + 7) // 8) * th), (20, 20, 20))
for i, t in enumerate(tiles): S.paste(t, ((i % 8) * tw, (i // 8) * th))
S.thumbnail((2400, 2400)); S.save(outp); print(outp, len(tiles))
