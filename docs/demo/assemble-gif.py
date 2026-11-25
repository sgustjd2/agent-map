"""Assemble the frames recorded by capture-gif.mjs into one GIF.  python assemble-gif.py <frames-dir> <out.gif>  (needs Pillow)"""
import json, sys
from pathlib import Path
from PIL import Image

src, dst = Path(sys.argv[1]), sys.argv[2]
meta = json.loads((src / "frames.json").read_text())
W = 960
imgs, durs = [], []
for m in meta:
    im = Image.open(src / m["file"]).convert("RGB")
    im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
    imgs.append(im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
    durs.append(m["ms"])
imgs[0].save(dst, save_all=True, append_images=imgs[1:], duration=durs, loop=0, optimize=True, disposal=1)
print(dst, sum(durs) / 1000, "s")
