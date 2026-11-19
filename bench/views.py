# Cut photographs into "phone views" at the detector's analysis resolution.
# usage: python3 -I bench/views.py <photos> <outdir> [labels,comma,separated]
import json, os, random, sys
from PIL import Image, ImageChops, ImageFilter

PH, OUT = sys.argv[1], sys.argv[2]
ONLY = sys.argv[3].split(",") if len(sys.argv) > 3 else None
os.makedirs(OUT, exist_ok=True)
manifest = json.load(open(os.path.join(PH, "manifest.json")))
rng = random.Random(7)
SHAPES = [("p", 390 / 844, (192, 416)), ("l", 1.6, (307, 192))]


def camera(img):
    img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.6, 1.4)))
    k, off = rng.uniform(0.7, 0.9), rng.uniform(10, 35)
    img = img.point(lambda c: int(off + k * c))
    return ImageChops.add(img, Image.effect_noise(img.size, rng.uniform(2, 6)).convert("RGB"), 1.0, -128)


index = []
for m in manifest:
    if ONLY and m["label"] not in ONLY:
        continue
    src = Image.open(os.path.join(PH, m["file"])).convert("RGB")
    W, H = src.size
    base = os.path.splitext(m["file"])[0]
    for shape, aspect, (aw, ah) in SHAPES:
        cw0, ch0 = (H * aspect, H) if W / H > aspect else (W, W / aspect)
        views = []
        for zoom in (1.0, 0.6, 0.38):
            for _ in range(1 if zoom == 1.0 else 2):
                cw, ch = cw0 * zoom, ch0 * zoom
                views.append((rng.uniform(cw / 2, W - cw / 2), rng.uniform(ch / 2, H - ch / 2), cw, ch))
        for vi, (cx, cy, cw, ch) in enumerate(views):
            crop = src.crop((int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2)))
            view = camera(crop.resize((aw * 3, ah * 3), Image.LANCZOS)).resize((aw, ah), Image.LANCZOS)
            name = f"{base}-{shape}{vi}"
            open(os.path.join(OUT, name + ".rgba"), "wb").write(view.convert("RGBA").tobytes())
            view.save(os.path.join(OUT, name + ".png"))
            index.append({"view": name, "file": m["file"], "label": m["label"], "expect": m["expect"], "w": aw, "h": ah})
json.dump(index, open(os.path.join(OUT, "index.json"), "w"))
print(len(index), "views")
