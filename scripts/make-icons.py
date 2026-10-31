# Generates the DFR Preflight app icons and favicon. Run from the repo root: python3 scripts/make-icons.py (needs Pillow and the Inter font).
import sys, math
from PIL import Image, ImageDraw, ImageFont
BG=(11,26,46,255); FG=(255,255,255,255); AMB=(255,196,0,255)
N=2048  # supersample
INTER='/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf'

def drone(d, cx, cy, reach, rr, w):
    for dx, dy in ((-1,-1),(1,-1),(-1,1),(1,1)):
        x, y = cx+dx*reach, cy+dy*reach
        d.line([(cx,cy),(x,y)], fill=FG, width=int(w))
        d.ellipse([x-rr,y-rr,x+rr,y+rr], outline=FG, width=int(w*0.8))
        d.ellipse([x-w*0.9,y-w*0.9,x+w*0.9,y+w*0.9], fill=FG)
    b=reach*0.42
    d.rounded_rectangle([cx-b,cy-b,cx+b,cy+b], radius=b*0.35, fill=FG)
    c=b*0.42
    d.ellipse([cx-c,cy-c,cx+c,cy+c], fill=AMB)   # camera / status light

def content(text=True):
    im=Image.new('RGBA',(N,N),(0,0,0,0)); d=ImageDraw.Draw(im)
    if not text:
        drone(d, N/2, N/2, N*0.27, N*0.17, N*0.05); return im
    drone(d, N/2, N*0.32, N*0.125, N*0.08, N*0.026)
    f=ImageFont.truetype(INTER, int(N*0.24))
    d.text((N/2, N*0.745), 'DFR', font=f, fill=FG, anchor='ms')
    f2=ImageFont.truetype(INTER, int(N*0.085))
    t='PREFLIGHT'; sp=N*0.012
    ws=[d.textlength(ch,font=f2) for ch in t]; tot=sum(ws)+sp*(len(t)-1); x=N/2-tot/2
    for ch,w in zip(t,ws):
        d.text((x, N*0.865), ch, font=f2, fill=AMB, anchor='ls'); x+=w+sp
    return im

def make(size, frac, text=True, path=None):
    bg=Image.new('RGBA',(N,N),BG)
    c=content(text); k=int(N*frac); c=c.resize((k,k),Image.LANCZOS)
    bg.alpha_composite(c,((N-k)//2,(N-k)//2))
    out=bg.resize((size,size),Image.LANCZOS)
    if path: out.save(path, optimize=True)
    return out

make(512,1.0,path='assets/icon-512.png')
make(192,1.0,path='assets/icon-192.png')
make(180,1.0,path='assets/apple-touch-icon.png')
make(512,0.80,path='assets/icon-maskable-512.png')
make(192,0.80,path='assets/icon-maskable-192.png')
fav=[make(s,1.0,text=False) for s in (16,32,48)]
fav[1].save('assets/favicon-32.png', optimize=True)
make(48,1.0,text=False).save('favicon.ico', sizes=[(16,16),(32,32),(48,48)])
