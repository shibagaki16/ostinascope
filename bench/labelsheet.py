# Contact sheet for labelling views by eye (bench/labels.json): each view
# with the labelling grid drawn over it (columns A, B, …; rows 1, 2, …), so
# that a pattern's rough box can be written as a cell range like "A2:C5".
# The grid is the one in labels.json ("grid": portrait 4 × 8, landscape
# 6 × 4 cells).
# usage: python3 -I bench/labelsheet.py <label> <out.png> [all]
#   default: views p0, p2, p4, l1, l3 of each photo (the labelled subset);
#   all: every view of the label
import json, sys
from PIL import Image, ImageDraw

label, outp = sys.argv[1], sys.argv[2]
every = len(sys.argv) > 3 and sys.argv[3] == "all"
SUBSET = ("p0", "p2", "p4", "l1", "l3")
GRID = json.load(open("bench/labels.json"))["grid"]

views = []
for d in ("views", "nviews"):
    try:
        idx = json.load(open(f"bench/data/{d}/index.json"))
    except FileNotFoundError:
        continue
    for v in idx:
        if v["label"] == label and (every or v["view"].split("-")[-1] in SUBSET):
            views.append((d, v))
if not views:
    sys.exit(f"no views for {label}")


def tile(d, v):
    im = Image.open(f"bench/data/{d}/{v['view']}.png").convert("RGB")
    sc = im.width / v["w"]
    cols, rows = GRID["portrait" if v["h"] > v["w"] else "landscape"]
    dr = ImageDraw.Draw(im)
    for c in range(1, cols):
        x = c * im.width / cols
        dr.line([(x, 0), (x, im.height)], fill=(255, 255, 255), width=1)
    for r in range(1, rows):
        y = r * im.height / rows
        dr.line([(0, y), (im.width, y)], fill=(255, 255, 255), width=1)
    for c in range(cols):
        for r in range(rows):
            x = c * im.width / cols + 2
            y = r * im.height / rows + 1
            dr.rectangle([x - 1, y, x + 17, y + 10], fill=(0, 0, 0))
            dr.text((x, y), f"{chr(65 + c)}{r + 1}", fill=(255, 255, 0))
    out = Image.new("RGB", (im.width, im.height + 14), (0, 0, 0))
    out.paste(im, (0, 14))
    ImageDraw.Draw(out).text((2, 1), f"{d}/{v['view']}", fill=(255, 255, 255))
    del sc
    return out


port = [tile(d, v) for d, v in views if v["h"] > v["w"]]
land = [tile(d, v) for d, v in views if v["h"] <= v["w"]]
pc, lc = 5, 3
pw = max([t.width for t in port] or [0]); ph = max([t.height for t in port] or [0])
lw = max([t.width for t in land] or [0]); lh = max([t.height for t in land] or [0])
prow = (len(port) + pc - 1) // pc
lrow = (len(land) + lc - 1) // lc
W = max(pc * (pw + 6), lc * (lw + 6))
S = Image.new("RGB", (W, prow * (ph + 6) + lrow * (lh + 6)), (40, 40, 40))
for i, t in enumerate(port):
    S.paste(t, ((i % pc) * (pw + 6), (i // pc) * (ph + 6)))
for i, t in enumerate(land):
    S.paste(t, ((i % lc) * (lw + 6), prow * (ph + 6) + (i // lc) * (lh + 6)))
S.save(outp)
print(outp, len(views), S.size)
