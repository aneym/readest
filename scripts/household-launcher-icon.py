#!/usr/bin/env python3
"""Homebase Readest Android launcher icon: regenerate or verify every layer.

Default mode rewrites, deterministically, from the tracked master art
(apps/readest-app/src-tauri/icons/icon.png):

  mipmap-*/ic_launcher_foreground.png  adaptive foreground, 108 dp
  mipmap-*/ic_launcher_monochrome.png  themed-icon glyph, 108 dp
  mipmap-*/ic_launcher.png             legacy icon on a white rounded square, 48 dp
  mipmap-*/ic_launcher_round.png       legacy icon on a white circle, 48 dp
  values/ic_launcher_background.xml    adaptive background colour, #FFFFFF

The adaptive layers keep the whole book and the H badge inside the centred
66 dp circle, the only area no launcher mask ever crops.

  --check          verify the tracked set and exit non-zero on any failure
  --out DIR        write the set under DIR instead of the repo
  --preview DIR    also write mask, tint and grayscale previews to DIR

Pure Pillow, no network.
"""

import argparse
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

REPO = Path(__file__).resolve().parent.parent
MASTER = REPO / "apps/readest-app/src-tauri/icons/icon.png"
RES = "apps/readest-app/src-tauri/gen/android/app/src/main/res"

DENSITIES = [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]
SS = 4  # supersampling factor for every composite

ADAPTIVE_DP = 108
SAFE_DP = 66
LEGACY_DP = 48
ART_RADIUS_DP = 32.0  # circumscribed radius of book + badge on the 108 dp layer
LEGACY_ART_RADIUS_DP = 19.0  # the same, on the 48 dp legacy plate
LEGACY_INSET_DP = 1.0
LEGACY_CORNER = 0.22  # rounded-square corner radius, as a share of the plate side

# Badge geometry in master pixels, measured from icon.png (green disc 333..456).
BADGE_CENTRE = (394.5, 394.5)
BADGE_RADIUS = 62.0
BADGE_SCALE = 1.12  # a touch larger, so the H survives 48 px launchers
BADGE_RING = 6.0  # page-cream sticker edge, separates the badge from the cover
BADGE_GREEN = (74, 124, 89)
PAGE_CREAM = (255, 246, 214)
WHITE = (255, 255, 255)

BACKGROUND_XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    "<resources>\n"
    '  <color name="ic_launcher_background">#FFFFFF</color>\n'
    "</resources>\n"
)

ALPHA_FLOOR = 16  # the spec's "visible pixel" threshold


def luma(rgb):
    r, g, b = rgb[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


class Art:
    """Master art plus the derived masks every layer is composed from."""

    def __init__(self, path):
        self.master = Image.open(path).convert("RGBA")
        self.size = self.master.size
        self.h_mask = self._h_mask()
        self.mono_alpha = self._mono_alpha()
        self.centre, self.radius = self._enclosing_circle()

    def _h_mask(self):
        """The white H inside the badge, as an L mask cropped around the badge."""
        cx, cy = BADGE_CENTRE
        r = int(math.ceil(BADGE_RADIUS))
        box = (int(cx - r), int(cy - r), int(cx + r) + 1, int(cy + r) + 1)
        crop = self.master.crop(box)
        green = luma(BADGE_GREEN)
        out = Image.new("L", crop.size, 0)
        src, dst = crop.load(), out.load()
        for y in range(crop.size[1]):
            for x in range(crop.size[0]):
                if math.hypot(box[0] + x + 0.5 - cx, box[1] + y + 0.5 - cy) > BADGE_RADIUS - 6:
                    continue
                v = (luma(src[x, y]) - green) / (255 - green)
                dst[x, y] = max(0, min(255, round(v * 255)))
        return out, box

    def _mono_alpha(self):
        """Alpha of the monochrome book: solid silhouette, text lines cut to 30%."""
        m = self.master
        out = Image.new("L", m.size, 0)
        src, dst = m.load(), out.load()
        for y in range(m.size[1]):
            for x in range(m.size[0]):
                r, g, b, a = src[x, y]
                if a == 0:
                    continue
                ink = r - b > 100 and 90 <= luma((r, g, b)) <= 175 and r > 150
                # Below y=360 only the ribbon bookmark is orange; keep it solid.
                dst[x, y] = round(a * 0.3) if ink and y < 360 else a
        return out

    def _enclosing_circle(self):
        """Smallest circle, in master pixels, around every visible art pixel."""
        pad = 128
        canvas = self.size[0] + 2 * pad
        layer = compose_colour(self, canvas, 1.0, (pad, pad))
        alpha = layer.getchannel("A").point(lambda v: 255 if v > ALPHA_FLOOR else 0)
        px = alpha.load()
        pts = []
        for y in range(canvas):
            row = [x for x in range(canvas) if px[x, y]]
            if row:
                for x in (row[0], row[-1]):
                    for dx in (0, 1):
                        for dy in (0, 1):
                            pts.append((x + dx - pad, y + dy - pad))
        hull = convex_hull(pts)

        def worst(c):
            return max(math.hypot(p[0] - c[0], p[1] - c[1]) for p in hull)

        xs = [p[0] for p in hull]
        ys = [p[1] for p in hull]
        best = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
        best_r = worst(best)
        for step in (8.0, 2.0, 0.5, 0.125):
            improved = True
            while improved:
                improved = False
                for dx in (-step, 0, step):
                    for dy in (-step, 0, step):
                        c = (best[0] + dx, best[1] + dy)
                        r = worst(c)
                        if r < best_r - 1e-9:
                            best, best_r, improved = c, r, True
        return best, best_r


def convex_hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _badge_geometry(scale, origin):
    cx = origin[0] + BADGE_CENTRE[0] * scale
    cy = origin[1] + BADGE_CENTRE[1] * scale
    disc = BADGE_RADIUS * BADGE_SCALE * scale
    ring = disc + BADGE_RING * scale
    return cx, cy, disc, ring


def _h_layer(art, canvas, scale, origin):
    """The H mask placed on a canvas-sized L image, enlarged with the badge."""
    mask, box = art.h_mask
    k = scale * BADGE_SCALE
    w, h = max(1, round(mask.size[0] * k)), max(1, round(mask.size[1] * k))
    resized = mask.resize((w, h), Image.LANCZOS)
    cx, cy, _, _ = _badge_geometry(scale, origin)
    # The crop's own centre maps onto the badge centre.
    ox = cx - (BADGE_CENTRE[0] - box[0]) * k
    oy = cy - (BADGE_CENTRE[1] - box[1]) * k
    out = Image.new("L", (canvas, canvas), 0)
    out.paste(resized, (round(ox), round(oy)))
    return out


def _disc(canvas, cx, cy, r):
    m = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(m).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    return m


def compose_colour(art, canvas, scale, origin):
    """Full-colour art (book, cream ring, badge, H) on a transparent canvas."""
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    w = round(art.size[0] * scale)
    book = art.master if w == art.size[0] else art.master.resize((w, w), Image.LANCZOS)
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    layer.paste(book, (round(origin[0]), round(origin[1])))
    out.alpha_composite(layer)
    cx, cy, disc, ring = _badge_geometry(scale, origin)
    for colour, mask in (
        (PAGE_CREAM, _disc(canvas, cx, cy, ring)),
        (BADGE_GREEN, _disc(canvas, cx, cy, disc)),
        (WHITE, _h_layer(art, canvas, scale, origin)),
    ):
        fill = Image.new("RGBA", (canvas, canvas), colour + (255,))
        fill.putalpha(mask)
        out.alpha_composite(fill)
    return out


def compose_mono_alpha(art, canvas, scale, origin):
    """Monochrome alpha: book silhouette, knockout gap, solid disc, knockout H."""
    w = round(art.size[0] * scale)
    book = art.mono_alpha.resize((w, w), Image.LANCZOS)
    out = Image.new("L", (canvas, canvas), 0)
    out.paste(book, (round(origin[0]), round(origin[1])))
    cx, cy, disc, ring = _badge_geometry(scale, origin)
    out = ImageChops.subtract(out, _disc(canvas, cx, cy, ring))
    out = ImageChops.lighter(out, _disc(canvas, cx, cy, disc))
    out = ImageChops.subtract(out, _h_layer(art, canvas, scale, origin))
    return out


def _placement(art, canvas, radius_px):
    scale = radius_px / art.radius
    origin = (canvas / 2 - art.centre[0] * scale, canvas / 2 - art.centre[1] * scale)
    return scale, origin


def foreground(art, size):
    canvas = size * SS
    scale, origin = _placement(art, canvas, ART_RADIUS_DP / ADAPTIVE_DP * canvas)
    return compose_colour(art, canvas, scale, origin).resize((size, size), Image.LANCZOS)


def monochrome(art, size):
    canvas = size * SS
    scale, origin = _placement(art, canvas, ART_RADIUS_DP / ADAPTIVE_DP * canvas)
    alpha = compose_mono_alpha(art, canvas, scale, origin).resize((size, size), Image.LANCZOS)
    white = Image.new("L", (size, size), 255)
    return Image.merge("RGBA", (white, white, white, alpha))


def legacy(art, size, round_plate):
    canvas = size * SS
    inset = LEGACY_INSET_DP / LEGACY_DP * canvas
    plate = Image.new("L", (canvas, canvas), 0)
    box = (inset, inset, canvas - inset, canvas - inset)
    if round_plate:
        ImageDraw.Draw(plate).ellipse(box, fill=255)
    else:
        radius = LEGACY_CORNER * (canvas - 2 * inset)
        ImageDraw.Draw(plate).rounded_rectangle(box, radius=radius, fill=255)
    out = Image.new("RGBA", (canvas, canvas), WHITE + (0,))
    out.putalpha(plate)
    scale, origin = _placement(art, canvas, LEGACY_ART_RADIUS_DP / LEGACY_DP * canvas)
    out.alpha_composite(compose_colour(art, canvas, scale, origin))
    return out.resize((size, size), Image.LANCZOS)


def targets():
    """Every output: (relative path, kind, pixel size)."""
    items = []
    for name, d in DENSITIES:
        a, l = round(ADAPTIVE_DP * d), round(LEGACY_DP * d)
        base = f"{RES}/mipmap-{name}"
        items += [
            (f"{base}/ic_launcher_foreground.png", "foreground", a),
            (f"{base}/ic_launcher_monochrome.png", "monochrome", a),
            (f"{base}/ic_launcher.png", "legacy", l),
            (f"{base}/ic_launcher_round.png", "round", l),
        ]
    items.append((f"{RES}/values/ic_launcher_background.xml", "xml", 0))
    return items


def render(art, kind, size):
    if kind == "foreground":
        return foreground(art, size)
    if kind == "monochrome":
        return monochrome(art, size)
    if kind == "legacy":
        return legacy(art, size, round_plate=False)
    if kind == "round":
        return legacy(art, size, round_plate=True)
    raise ValueError(kind)


def generate(root, art=None):
    art = art or Art(MASTER)
    for rel, kind, size in targets():
        path = Path(root) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if kind == "xml":
            path.write_text(BACKGROUND_XML)
        else:
            render(art, kind, size).save(path, format="PNG", optimize=False, compress_level=9)
    return art


# ---------------------------------------------------------------- checks


def visible_outside_safe(img):
    """Count of alpha > 16 pixels outside the centred 66/108 circle (+1 px)."""
    s = img.size[0]
    limit = s * SAFE_DP / ADAPTIVE_DP / 2 + 1
    c = s / 2
    a = img.getchannel("A").load()
    bad = 0
    for y in range(s):
        for x in range(s):
            if a[x, y] > ALPHA_FLOOR and math.hypot(x + 0.5 - c, y + 0.5 - c) > limit:
                bad += 1
    return bad


def bbox_radius(img):
    box = img.getchannel("A").point(lambda v: 255 if v > ALPHA_FLOOR else 0).getbbox()
    if not box:
        return 0.0
    return math.hypot(box[2] - box[0], box[3] - box[1]) / 2


def mono_non_white(img):
    visible = img.getchannel("A").point(lambda v: 255 if v > 0 else 0)
    off = Image.new("L", img.size, 0)
    for band in "RGB":
        off = ImageChops.lighter(off, img.getchannel(band).point(lambda v: 0 if v == 255 else 255))
    return ImageChops.multiply(visible, off).histogram()[255]


def check():
    failures = []
    for rel, kind, size in targets():
        path = REPO / rel
        if not path.exists():
            failures.append(f"(a) missing {rel}")
            continue
        if kind == "xml":
            if "#FFFFFF" not in path.read_text() or "ic_launcher_background" not in path.read_text():
                failures.append(f"(a) {rel} does not set ic_launcher_background #FFFFFF")
            continue
        img = Image.open(path)
        if img.size != (size, size):
            failures.append(f"(a) {rel} is {img.size[0]}x{img.size[1]}, want {size}x{size}")
            continue
        img = img.convert("RGBA")
        if kind in ("foreground", "monochrome"):
            bad = visible_outside_safe(img)
            if bad:
                failures.append(f"(b) {rel}: {bad} visible pixels outside the 66 dp safe circle")
        if kind == "foreground":
            r = bbox_radius(img)
            if r < size * 27 / ADAPTIVE_DP:
                failures.append(f"(c) {rel}: art radius {r:.1f}px < {size * 27 / ADAPTIVE_DP:.1f}px (27 dp)")
        if kind == "monochrome":
            n = mono_non_white(img)
            if n:
                failures.append(f"(d) {rel}: {n} pixels with alpha > 0 are not RGB 255,255,255")
    for rel, _, _ in targets():
        res = subprocess.run(
            ["git", "ls-files", "--error-unmatch", rel],
            cwd=REPO,
            capture_output=True,
        )
        if res.returncode != 0:
            failures.append(f"(e) {rel} is not tracked or staged")
    with tempfile.TemporaryDirectory() as tmp:
        generate(tmp)
        for rel, _, _ in targets():
            ours, fresh = REPO / rel, Path(tmp) / rel
            if ours.exists() and ours.read_bytes() != fresh.read_bytes():
                failures.append(f"(f) {rel} differs from a fresh regeneration")
    return failures


# -------------------------------------------------------------- previews


def _superellipse(size, n=4.0):
    m = Image.new("L", (size * SS, size * SS), 0)
    s = size * SS
    r = s / 2
    pts = []
    for i in range(720):
        t = 2 * math.pi * i / 720
        c, sn = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / n), c)
        y = r + r * math.copysign(abs(sn) ** (2 / n), sn)
        pts.append((x, y))
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def _mask(shape, size):
    s = size * SS
    m = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(m)
    if shape == "circle":
        d.ellipse((0, 0, s - 1, s - 1), fill=255)
    elif shape == "squircle":
        return _superellipse(size)
    elif shape == "rounded":
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=0.22 * s, fill=255)
    elif shape == "teardrop":
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s / 2, fill=255)
        d.rounded_rectangle((s / 2, s / 2, s - 1, s - 1), radius=0.12 * s, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def _viewport(img):
    """The central 72 of 108 dp that launchers show."""
    s = img.size[0]
    inner = s * 72 / ADAPTIVE_DP
    o = (s - inner) / 2
    return img.crop((round(o), round(o), round(o + inner), round(o + inner)))


def previews(out_dir, art):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    fg = foreground(art, 432)
    mono = monochrome(art, 432)
    composed = Image.new("RGBA", fg.size, WHITE + (255,))
    composed.alpha_composite(fg)
    view = _viewport(composed)
    mono_view = _viewport(mono)
    written = []
    sheet_tiles = []
    for size in (192, 48):
        v = view.resize((size, size), Image.LANCZOS)
        for shape in ("circle", "squircle", "rounded", "teardrop"):
            tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            tile.paste(v, (0, 0), _mask(shape, size))
            p = out / f"composed-{shape}-{size}.png"
            tile.save(p)
            written.append(p)
            sheet_tiles.append(tile)
            if shape in ("circle", "squircle"):
                g = tile.convert("LA").convert("RGBA")
                p = out / f"composed-{shape}-{size}-gray.png"
                g.save(p)
                written.append(p)
                sheet_tiles.append(g)
        mv = mono_view.resize((size, size), Image.LANCZOS).getchannel("A")
        for name, fgc, bgc in (("white-on-1b1b1b", WHITE, (0x1B,) * 3), ("black-on-f2f2f2", (0, 0, 0), (0xF2,) * 3)):
            tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            plate = Image.new("RGBA", (size, size), bgc + (255,))
            glyph = Image.new("RGBA", (size, size), fgc + (255,))
            plate.paste(glyph, (0, 0), mv)
            tile.paste(plate, (0, 0), _mask("circle", size))
            p = out / f"mono-{name}-{size}.png"
            tile.save(p)
            written.append(p)
            sheet_tiles.append(tile)
    for name, size in (("legacy", 192), ("round", 192), ("legacy", 48), ("round", 48)):
        img = render(art, name, size)
        p = out / f"{name}-{size}.png"
        img.save(p)
        written.append(p)
        sheet_tiles.append(img)
    # Contact sheets on a light and a dark launcher wallpaper.
    for label, bg in (("light", (236, 236, 232)), ("dark", (24, 24, 26))):
        cols, pad = 10, 16
        rows = math.ceil(len(sheet_tiles) / cols)
        sheet = Image.new("RGBA", (cols * (192 + pad) + pad, rows * (192 + pad) + pad), bg + (255,))
        for i, t in enumerate(sheet_tiles):
            x = pad + (i % cols) * (192 + pad) + (192 - t.size[0]) // 2
            y = pad + (i // cols) * (192 + pad) + (192 - t.size[1]) // 2
            sheet.alpha_composite(t.convert("RGBA"), (x, y))
        p = out / f"sheet-{label}.png"
        sheet.save(p)
        written.append(p)
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="verify the tracked set")
    ap.add_argument("--out", help="write the set under this directory instead of the repo")
    ap.add_argument("--preview", help="also write previews to this directory")
    args = ap.parse_args()
    if args.check:
        failures = check()
        for f in failures:
            print(f"FAIL {f}")
        if failures:
            sys.exit(1)
        print(f"OK {len(targets())} files: sizes, 66 dp safe circle, art radius, "
              "monochrome white, tracked, deterministic")
        return
    art = generate(args.out or REPO)
    print(f"wrote {len(targets())} files; art circle centre "
          f"({art.centre[0]:.2f}, {art.centre[1]:.2f}) r={art.radius:.2f} master px")
    if args.preview:
        for p in previews(args.preview, art):
            print(f"preview {p}")


if __name__ == "__main__":
    main()
