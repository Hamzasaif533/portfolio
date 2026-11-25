"""Make a .webp copy next to each poster, cover and small frame (the site uses the .webp when there is one).
Run after new posters arrive:  python tools/webp.py   (needs Pillow: pip install pillow)"""
import os
from PIL import Image

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dirs = ["assets/posters", "assets/posters/film", "assets/posters/game", "assets/posters/book", "assets/frames-sm"]
before = after = made = 0
for d in dirs:
    full = os.path.join(root, d)
    if not os.path.isdir(full):
        continue
    for f in sorted(os.listdir(full)):
        src = os.path.join(full, f)
        if not os.path.isfile(src) or not f.lower().endswith((".jpg", ".jpeg", ".png")):
            continue
        dst = os.path.splitext(src)[0] + ".webp"
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        im = Image.open(src)
        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
        im.save(dst, "WEBP", quality=80, method=4)
        before += os.path.getsize(src)
        after += os.path.getsize(dst)
        made += 1
print(f"webp: {made} made, {before // 1024} KB as jpg -> {after // 1024} KB as webp")
