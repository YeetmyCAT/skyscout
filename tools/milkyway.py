# Builds data/milkyway.jpg from ESO's all-sky Milky Way panorama (ESO/S. Brunier, CC BY 4.0, eso0932a):
# galactic plate carree, galactic centre in the middle. Stars are removed with a median filter (the app draws
# stars itself), the sky background is subtracted, and values are stored sqrt-encoded in linear light.
# Run: PYTHONPATH=<pillow dir> python tools/milkyway.py <raw dir> <out dir>
import sys, os
from PIL import Image, ImageFilter, ImageChops

raw, out = sys.argv[1], sys.argv[2]
im = Image.open(os.path.join(raw, 'eso0932a.jpg')).convert('RGB')
print('source', im.size)
W, H = 2048, 1024
im = im.resize((W, H), Image.LANCZOS)
# remove stars: median, then a gentle opening (min then max) to knock out bright star halos
med = im.filter(ImageFilter.MedianFilter(7)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
# per-channel background (2nd percentile) and normalisation (99.8th percentile of the brightest channel)
def pct(ch, p):
    h = ch.histogram(); n = sum(h); acc = 0
    for i, c in enumerate(h):
        acc += c
        if acc >= n * p: return i
    return 255
chs = med.split()
lin = []
for ch in chs:
    lo = pct(ch, 0.02)
    # sRGB -> linear via lookup, minus background
    lut = [max(0.0, ((v / 255.0) ** 2.2) - ((lo / 255.0) ** 2.2)) for v in range(256)]
    lin.append([lut[v] for v in ch.getdata()])
peak = sorted(max(lin[0][i], lin[1][i], lin[2][i]) for i in range(0, W * H, 7))[int(0.998 * (W * H // 7))]
print('peak linear', peak)
enc = []
for c in lin:
    enc.append(Image.new('L', (W, H)))
    enc[-1].putdata([int(255 * min(1.0, (v / peak)) ** 0.5) for v in c])
res = Image.merge('RGB', enc)
res.save(os.path.join(out, 'milkyway.jpg'), quality=90, optimize=True)
res.resize((512, 256)).save(os.path.join(raw, 'mw_preview.png'))
print('saved', os.path.getsize(os.path.join(out, 'milkyway.jpg')))
