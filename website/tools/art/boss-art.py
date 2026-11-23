"""Run from repo root with Pillow, ImageMagick and resvg; no face/image model."""
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from pathlib import Path
import base64, subprocess, tempfile, io

def cmd(*args): subprocess.run(args, check=True)

# Flood only the original six glyphs + i dot. No resampling of the suffix.
with tempfile.TemporaryDirectory() as tmp:
    file = Path(tmp)/'prefix.png'
    cmd('resvg','design/dax-prefix.svg',str(file))
    prefix = Image.open(file).convert('RGBA').getchannel('A').point(lambda x: 255 if x>127 else 0)
    raw = Image.open('design/lettering.png').convert('L')
    for xy in [(3760,315),(4210,398),(4625,481),(4960,550),(5310,550),(5780,540),(4950,155)]:
        assert raw.getpixel(xy)==255, xy
        ImageDraw.floodfill(raw,xy,128)
    suffix=raw.point(lambda x: 255 if x==128 else 0)
    suffix.paste(prefix,(0,0))
    suffix.crop(suffix.getbbox()).convert('1').save('design/daxscript.png')

# Polygon runs just inside the photographic contour, excluding the orange drop shadow and shirt.
photo=Image.open('design/dax-speaker.png').convert('L')
outline=[(169,146),(176,142),(182,146),(180,122),(181,96),(186,77),(198,55),(213,37),(231,23),(252,15),(271,11),(287,13),(309,20),(326,32),(341,46),(351,63),(358,80),(363,98),(365,122),(365,142),(370,138),(376,141),(376,156),(372,183),(368,203),(361,209),(355,233),(346,256),(334,274),(318,287),(297,298),(279,303),(258,301),(239,295),(223,284),(211,270),(202,246),(196,219),(193,208),(181,210),(175,205),(171,190),(169,165)]
mask=Image.new('L',photo.size); ImageDraw.Draw(mask).polygon(outline,fill=255)
stops=[(0,(19,14,28)),(30,(40,26,44)),(66,(77,43,59)),(107,(145,77,70)),(157,(216,127,85)),(210,(253,185,113)),(255,(255,227,164))]
def col(k):
    for (a,l),(b,r) in zip(stops,stops[1:]):
        if k<=b:return tuple(round(x+(y-x)*(k-a)/(b-a)) for x,y in zip(l,r))
inked=Image.merge('RGB',tuple(photo.point([col(k)[ch] for k in range(256)]) for ch in range(3)))
inked=Image.composite(inked,Image.new('RGB',photo.size,(56,35,47)),mask)
inked=inked.crop((158,0,390,314)); inked.save('site/art/boss.jpg',quality=95,subsampling=0)
avatar=Image.new('RGB',(88,88),'#efbe55'); head=inked.resize((56,76),Image.Resampling.LANCZOS)
avatar.paste(head,(16,6),mask.crop((158,0,390,314)).resize(head.size,Image.Resampling.LANCZOS))
bio=io.BytesIO(); avatar.save(bio,format='PNG'); data=base64.b64encode(bio.getvalue()).decode()
lines=[("you don't know how","to write code"),("nobody knows how","to write code"),("i can't write code",),('that is more code','than we needed'),('i made it worse',),('why is there','another loop'),('we could just','return the value'),('my fix needs a fix',),('who named this',),('the bug is mine',),('i wrote this twice',),('fewer brackets','next time')]
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="720" height="{256*len(lines)}" viewBox="0 0 360 {128*len(lines)}"><defs><clipPath id="coin"><circle cx="41" cy="39" r="20"/></clipPath><image id="avatar" x="21" y="19" width="40" height="40" xlink:href="data:image/png;base64,{data}"/></defs>']
for i,copy in enumerate(lines):
    svg.append(f'''<g transform="translate(0 {i*128})">
    <path d="M26 7 Q13 7 12 21 L9 101 Q9 115 23 116 L328 121 Q346 121 346 105 L351 30 Q351 16 335 15 Z" fill="#cf4c28" stroke="#241626" stroke-width="6"/>
    <path d="M24 5 Q10 5 9 20 L6 96 Q6 110 22 111 L327 115 Q340 116 341 102 L347 26 Q348 12 332 12 Z" fill="#ffedbf" stroke="#271b29" stroke-width="5"/>
    <circle cx="41" cy="39" r="22" fill="#302332"/><use xlink:href="#avatar" clip-path="url(#coin)"/>
    <g fill="none" stroke="#60364c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M73 29 l5 -9 v9 l6 -5 m5 5 l5 -9 l5 5 l-7 4 m12 0 v-9 l7 9 l4 -7 m8 6 l5 -7 l5 2 -7 5"/><path d="M299 26 l8 0 -4 5 M313 26 l8 0 -4 5"/></g>''')
    for j,line in enumerate(copy):svg.append(f'<text x="72" y="{68+(1-len(copy))*4+j*31}" font-family="Arial" font-size="26" font-weight="bold" fill="#281726">{line}</text>')
    svg.append('</g>')
svg.append('</svg>'); Path('tools/art/comets.svg').write_text('\n'.join(svg))
cmd('resvg','tools/art/comets.svg','site/art/comets.png')
cmd('magick','site/art/comets.png','-dither','None','-colors','128','PNG8:site/art/comets.png')
