# Synthetic "phone views" with ground truth: printed patterns or rows of
# look-alike objects, pasted (in perspective, shaded) over real background
# photos, then put through a rough camera model.
#
# usage: python3 -I bench/scenes.py <photos> <outdir> <count> [seed]
#          [--seq FRAMES]       hand-held sequences instead of single frames
#          [--empty]            backgrounds only (nothing should play)
#          [--kinds a,b,...]    pattern kinds to draw (default: all)
#          [--labels a,b,...]   background photo labels (default: expect=none)
import json, math, os, random, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

PH, OUT, COUNT = sys.argv[1], sys.argv[2], int(sys.argv[3])
SEED = int(sys.argv[4]) if len(sys.argv) > 4 and not sys.argv[4].startswith("--") else 1
arg = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
SEQ = int(arg("--seq") or 0)
EMPTY = "--empty" in sys.argv
os.makedirs(OUT, exist_ok=True)
rng = random.Random(SEED)
manifest = json.load(open(os.path.join(PH, "manifest.json")))
LABELS = arg("--labels").split(",") if arg("--labels") else None
backs = [m["file"] for m in manifest if (m["label"] in LABELS if LABELS else m["expect"] == "none")]
sprites_src = [m["file"] for m in manifest]
UP = 3

INKS = [(20, 20, 22), (200, 35, 40), (30, 70, 190), (235, 190, 20), (30, 120, 70), (90, 60, 40)]
PAPERS = [(238, 234, 224), (250, 250, 248), (215, 205, 185), (60, 60, 64), (240, 200, 60)]
ALL = ["stripes", "stripes", "grid", "dots", "hexdots", "checker", "rings", "rays", "band", "row", "row", "row"]
KINDS = arg("--kinds").split(",") if arg("--kinds") else ALL
FAMILY = {"stripes": "line", "band": "line", "grid": "lattice", "dots": "lattice", "hexdots": "lattice",
          "checker": "lattice", "rings": "radial", "rays": "radial", "row": "row"}


def pattern(kind, size, period):
    ink = rng.choice(INKS)
    paper = rng.choice(PAPERS)
    if abs(sum(ink) - sum(paper)) < 150:
        paper = (240, 238, 230)
    if rng.random() < 0.2:
        ink, paper = paper, ink
    im = Image.new("RGB", (size, size), paper)
    d = ImageDraw.Draw(im)
    c = size / 2
    duty = rng.uniform(0.25, 0.6)
    if kind in ("stripes", "band"):
        x = -size
        while x < 2 * size:
            d.rectangle([x, -size, x + period * duty, 2 * size], fill=ink)
            x += period
    elif kind == "grid":
        p2 = period * rng.choice([1, 1, 1.25, 1.333, 1.5, 0.75])
        lw = max(2, period * rng.uniform(0.12, 0.3))
        x = 0.0
        while x < size:
            d.rectangle([x, 0, x + lw, size], fill=ink); x += period
        y = 0.0
        while y < size:
            d.rectangle([0, y, size, y + lw * p2 / period], fill=ink); y += p2
    elif kind in ("dots", "hexdots"):
        r = period * rng.uniform(0.18, 0.35)
        row, y = 0, 0.0
        while y < size + period:
            off = (period / 2 if row % 2 else 0) if kind == "hexdots" else 0
            x = off
            while x < size + period:
                d.ellipse([x - r, y - r, x + r, y + r], fill=ink); x += period
            y += period * (math.sqrt(3) / 2 if kind == "hexdots" else 1)
            row += 1
    elif kind == "checker":
        n = int(size / period) + 1
        for i in range(n):
            for j in range(n):
                if (i + j) % 2:
                    d.rectangle([i * period, j * period, (i + 1) * period, (j + 1) * period], fill=ink)
    elif kind == "rings":
        r = period * rng.uniform(0.5, 2)
        while r < size * 0.72:
            d.ellipse([c - r, c - r, c + r, c + r], outline=ink, width=max(2, int(period * duty))); r += period
    elif kind == "rays":
        n = rng.choice([24, 36, 48, 64, 96])
        r0 = size * rng.uniform(0.05, 0.2)
        for i in range(n):
            a0 = 2 * math.pi * i / n
            a1 = a0 + 2 * math.pi / n * duty
            d.polygon([(c + r0 * math.cos(a0), c + r0 * math.sin(a0)), (c + size * math.cos(a0), c + size * math.sin(a0)),
                       (c + size * math.cos(a1), c + size * math.sin(a1)), (c + r0 * math.cos(a1), c + r0 * math.sin(a1))], fill=ink)
    return im, paper


def homography(src, dst):
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    n = 8
    M = [A[i] + [B[i]] for i in range(n)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        for r in range(n):
            if r != i:
                f = M[r][i] / M[i][i]
                for k in range(i, n + 1):
                    M[r][k] -= f * M[i][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def camera(img, motion=None):
    img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 1.6)))
    if motion:
        dx, dy, n = motion
        acc = img
        for i in range(1, n):
            acc = ImageChops.blend(acc, ImageChops.offset(img, int(round(dx * i / n)), int(round(dy * i / n))), 1 / (i + 1))
        img = acc
    k = rng.uniform(0.7, 0.92)
    off = rng.uniform(8, 35)
    img = img.point(lambda c: int(off + k * c))
    noise = Image.effect_noise(img.size, rng.uniform(2, 7)).convert("RGB")
    return ImageChops.add(img, noise, 1.0, -128)


def sprite(size):
    """A look-alike 'thing': a structured crop from a photo with an object-like
    silhouette, or a simple printed shape."""
    if rng.random() < 0.3:
        im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        ink = rng.choice(INKS) + (255,)
        shape = rng.choice(["circle", "tri", "square", "bottle", "cup"])
        m = size * 0.1
        if shape == "circle":
            d.ellipse([m, m, size - m, size - m], fill=ink)
            if rng.random() < 0.5:
                d.ellipse([size * 0.35, size * 0.35, size * 0.65, size * 0.65], fill=(240, 238, 230, 255))
        elif shape == "tri":
            d.polygon([(size / 2, m), (size - m, size - m), (m, size - m)], fill=ink)
        elif shape == "square":
            d.rectangle([m, m, size - m, size - m], fill=ink)
            d.rectangle([size * 0.3, size * 0.3, size * 0.7, size * 0.5], fill=(240, 238, 230, 255))
        elif shape == "bottle":
            d.rectangle([size * 0.42, m, size * 0.58, size * 0.35], fill=ink)
            d.rounded_rectangle([size * 0.28, size * 0.3, size * 0.72, size - m], radius=size * 0.08, fill=ink)
            d.rectangle([size * 0.3, size * 0.55, size * 0.7, size * 0.72], fill=(240, 238, 230, 255))
        else:
            d.rounded_rectangle([size * 0.2, size * 0.25, size * 0.72, size - m], radius=size * 0.06, fill=ink)
            d.ellipse([size * 0.62, size * 0.38, size * 0.9, size * 0.7], outline=ink, width=max(2, size // 14))
        return im
    for _ in range(20):
        src = Image.open(os.path.join(PH, rng.choice(sprites_src))).convert("RGB")
        cs = rng.randint(60, min(src.size) // 2)
        x0 = rng.randint(0, src.width - cs)
        y0 = rng.randint(0, src.height - cs)
        crop = src.crop((x0, y0, x0 + cs, y0 + cs)).resize((size, size), Image.LANCZOS)
        e = crop.convert("L").filter(ImageFilter.FIND_EDGES)
        if sum(e.getdata()) / (size * size) > 18:
            break
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    if rng.random() < 0.5:
        md.ellipse([size * 0.04, size * 0.04, size * 0.96, size * 0.96], fill=255)
    else:
        md.rounded_rectangle([size * 0.06, size * 0.02, size * 0.94, size * 0.98], radius=size * 0.18, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.5))
    crop.putalpha(mask)
    return crop


def paste_row(canvas, W, H):
    """3–7 look-alikes on a line, unevenly spaced. Returns GT (analysis px)."""
    short = min(W, H) / UP
    size = rng.uniform(0.11, 0.26) * short
    n = rng.randint(3, 7)
    base = sprite(int(size * UP))
    vertical = rng.random() < 0.25
    ang = math.radians(rng.uniform(-25, 25) + (90 if vertical else 0))
    ux, uy = math.cos(ang), math.sin(ang)
    gap = size * rng.uniform(1.15, 2.2)
    jit = rng.choice([0, 0.1, 0.25])
    ts = [0.0]
    for _ in range(n - 1):
        ts.append(ts[-1] + gap * (1 + rng.uniform(-jit, jit)))
    length = ts[-1]
    cx = rng.uniform(0.2, 0.8) * W / UP
    cy = rng.uniform(0.2, 0.8) * H / UP
    members = []
    for t in ts:
        s = rng.uniform(0.93, 1.07)
        sp = base.resize((int(base.width * s), int(base.height * s)), Image.LANCZOS).rotate(rng.uniform(-4, 4), resample=Image.BICUBIC)
        b = rng.uniform(0.88, 1.12)
        rgb = sp.convert("RGB").point(lambda v: min(255, int(v * b)))
        mx = cx + (t - length / 2) * ux
        my = cy + (t - length / 2) * uy
        px, py = int(mx * UP - sp.width / 2), int(my * UP - sp.height / 2)
        canvas.paste(rgb, (px, py), sp.split()[3])
        members.append([px / UP, py / UP, (px + sp.width) / UP, (py + sp.height) / UP])
    xs = [m[0] for m in members] + [m[2] for m in members]
    ys = [m[1] for m in members] + [m[3] for m in members]
    box = [min(xs), min(ys), max(xs), max(ys)]
    return {"kind": "row", "family": "row", "period": gap, "count": n, "members": members, "box": box,
            "poly": [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]}


def paste_pattern(canvas, W, H, kind):
    short = min(W, H) / UP
    period = math.exp(rng.uniform(math.log(3.2), math.log(0.3 * short)))
    side = max(rng.uniform(0.28, 0.85) * short, 3.2 * period)
    aspect = rng.uniform(0.6, 1.6)
    pw, ph = side * math.sqrt(aspect), side / math.sqrt(aspect)
    if kind == "band":
        aspect = rng.choice([rng.uniform(3, 6), 1 / rng.uniform(3, 6)])
        pw, ph = (side * 1.8, side * 1.8 / aspect) if aspect > 1 else (side * 1.8 * aspect, side * 1.8)
        period = min(period, min(pw, ph))
    T = int(max(pw, ph) * UP * 1.5) + 8
    tile, paper = pattern(kind, T, period * UP)
    tile = tile.rotate(rng.uniform(0, 180), resample=Image.BICUBIC, expand=False, fillcolor=paper)
    c = T / 2
    tile = tile.crop((int(c - pw * UP / 2), int(c - ph * UP / 2), int(c + pw * UP / 2), int(c + ph * UP / 2)))
    tw, th = tile.size
    t = rng.uniform(0, 0.28)
    dst = [(tw * t, 0), (tw * (1 - t), 0), (tw, th), (0, th)] if rng.random() < 0.5 else [(0, th * t), (tw, 0), (tw, th), (0, th * (1 - t))]
    if rng.random() < 0.5:
        dst = [(tw - x, th - y) for (x, y) in dst]
    dst = [(x + rng.uniform(-0.04, 0.04) * tw, y + rng.uniform(-0.04, 0.04) * th) for x, y in dst]
    coef = homography([(0, 0), (tw, 0), (tw, th), (0, th)], dst)
    mask = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(mask).polygon(dst, fill=255)
    warped = tile.transform((tw, th), Image.PERSPECTIVE, coef, Image.BICUBIC, fillcolor=paper)
    shade = Image.linear_gradient("L").resize((tw, th)).rotate(rng.uniform(0, 360), fillcolor=128)
    lo = rng.uniform(0.55, 1.0)
    shade = shade.point(lambda v: int(255 * (lo + (1 - lo) * v / 255)))
    warped = ImageChops.multiply(warped, Image.merge("RGB", [shade] * 3))
    px = min(max(rng.uniform(-0.15, 1.15) * W - tw / 2, -tw * 0.35), W - tw * 0.65)
    py = min(max(rng.uniform(-0.1, 1.1) * H - th / 2, -th * 0.35), H - th * 0.65)
    canvas.paste(warped, (int(px), int(py)), mask)
    xs = [(x + px) / UP for x, _ in dst]
    ys = [(y + py) / UP for _, y in dst]
    return {"kind": kind, "family": FAMILY[kind], "period": period, "box": [min(xs), min(ys), max(xs), max(ys)],
            "poly": [[x, y] for x, y in zip(xs, ys)]}


def scene(aw, ah, margin=1.0):
    W, H = int(aw * UP * margin), int(ah * UP * margin)
    bg = Image.open(os.path.join(PH, rng.choice(backs))).convert("RGB")
    s = max(W / bg.width, H / bg.height) * rng.uniform(1.0, 1.8)
    bg = bg.resize((int(bg.width * s) + 1, int(bg.height * s) + 1), Image.LANCZOS)
    x0 = rng.randint(0, bg.width - W)
    y0 = rng.randint(0, bg.height - H)
    canvas = bg.crop((x0, y0, x0 + W, y0 + H))
    gt = []
    if not EMPTY:
        for _ in range(1 if rng.random() < 0.75 else 2):
            kind = rng.choice(KINDS)
            gt.append(paste_row(canvas, W, H) if kind == "row" else paste_pattern(canvas, W, H, kind))
    return canvas, gt


def shift(g, fx, fy):
    o = {**g, "box": [g["box"][0] - fx, g["box"][1] - fy, g["box"][2] - fx, g["box"][3] - fy],
         "poly": [[x - fx, y - fy] for x, y in g["poly"]]}
    if "members" in g:
        o["members"] = [[a - fx, b - fy, c - fx, d - fy] for a, b, c, d in g["members"]]
    return o


index = []
for i in range(COUNT):
    aw, ah = (192, 416) if rng.random() < 0.75 else (307, 192)
    if not SEQ:
        img, gt = scene(aw, ah)
        motion = None
        if rng.random() < 0.3:
            a = rng.uniform(0, math.pi)
            L = rng.uniform(2, 9)
            motion = (L * math.cos(a), L * math.sin(a), 6)
        view = camera(img, motion).resize((aw, ah), Image.LANCZOS)
        name = f"s{i:03d}"
        view.save(os.path.join(OUT, name + ".png"))
        open(os.path.join(OUT, name + ".rgba"), "wb").write(view.convert("RGBA").tobytes())
        index.append({"view": name, "w": aw, "h": ah, "gt": gt, "label": "scene", "expect": "scene", "variant": "cam"})
    else:
        m = 1.35
        img, gt = scene(aw, ah, margin=m)
        W, H = img.size
        vw, vh = aw * UP, ah * UP
        ox, oy = (W - vw) / 2, (H - vh) / 2
        vx, vy = rng.uniform(-1, 1) * 6, rng.uniform(-1, 1) * 6
        for f in range(SEQ):
            jx, jy = rng.gauss(0, 4), rng.gauss(0, 4)
            fx = min(max(ox + vx * f + jx, 0), W - vw)
            fy = min(max(oy + vy * f + jy, 0), H - vh)
            crop = img.crop((int(fx), int(fy), int(fx) + vw, int(fy) + vh))
            motion = (jx * 0.8, jy * 0.8, 4) if abs(jx) + abs(jy) > 5 else None
            view = camera(crop, motion).resize((aw, ah), Image.LANCZOS)
            name = f"s{i:03d}_f{f:02d}"
            open(os.path.join(OUT, name + ".rgba"), "wb").write(view.convert("RGBA").tobytes())
            if f == 0:
                view.save(os.path.join(OUT, f"s{i:03d}.png"))
            index.append({"view": name, "seq": i, "frame": f, "w": aw, "h": ah, "gt": [shift(g, int(fx) / UP, int(fy) / UP) for g in gt],
                          "label": "seq", "expect": "scene", "variant": "cam"})
json.dump(index, open(os.path.join(OUT, "index.json"), "w"))
print(len(index), "views")
