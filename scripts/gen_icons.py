#!/usr/bin/env python3
"""生成扩展占位图标 icon16/48/128.png（纯 Python，无第三方依赖）。
图案：蓝色圆角底 + 白色思维导图小树（三节点）。
"""
import zlib, struct, os

S = 4  # 超采样倍数
SIZE = 128
SS = SIZE * S

def clamp(v, a=0.0, b=1.0):
    return max(a, min(b, v))

def render():
    px = [[0.0] * (SS * 4) for _ in range(SS)]  # r,g,b,a floats 0-255
    for y in range(SS):
        fy = y / SS
        # 背景垂直渐变 #4285F4 -> #1A56C8
        br = 0x42 + (0x1A - 0x42) * fy
        bg_ = 0x85 + (0x56 - 0x85) * fy
        bb = 0xF4 + (0xC8 - 0xF4) * fy
        for x in range(SS):
            fx = x / SS
            # 圆角矩形 alpha
            r = 0.18
            cx = clamp(fx, r, 1 - r); cy = clamp(fy, r, 1 - r)
            inside = ((fx - cx) ** 2 + (fy - cy) ** 2) <= r * r
            a = 255.0 if inside else 0.0
            # 前景：白色小树（线 + 三圆）
            cov = 0.0
            # 主干
            if abs(fx - 0.5) < 0.028 and 0.28 <= fy <= 0.74: cov = 1.0
            # 左右枝
            if 0.44 <= fy <= 0.475 and (0.28 <= fx <= 0.5 or 0.5 <= fx <= 0.72): cov = 1.0
            # 三节点圆
            for (nx, ny, nr) in ((0.5, 0.22, 0.085), (0.26, 0.52, 0.07), (0.74, 0.52, 0.07)):
                d2 = (fx - nx) ** 2 + (fy - ny) ** 2
                if d2 <= nr * nr: cov = 1.0
            rr = br + (255 - br) * cov
            gg = bg_ + (255 - bg_) * cov
            b2 = bb + (255 - bb) * cov
            row = px[y]
            i = x * 4
            row[i] = rr; row[i+1] = gg; row[i+2] = b2; row[i+3] = a
    # 盒式降采样 SS -> SIZE
    out = []
    for y in range(SIZE):
        row = [0] * (SIZE * 4)
        for x in range(SIZE):
            acc = [0.0] * 4
            for dy in range(S):
                src = px[y * S + dy]
                for dx in range(S):
                    i = (x * S + dx) * 4
                    acc[0] += src[i]; acc[1] += src[i+1]; acc[2] += src[i+2]; acc[3] += src[i+3]
            n = S * S
            for c in range(4):
                row[x * 4 + c] = int(clamp(acc[c] / n, 0, 255) + 0.5)
        out.append(row)
    return out

def write_png(path, rows):
    h = len(rows); w = len(rows[0]) // 4
    raw = b''.join(b'\x00' + bytes(bytes(r[i*4:i*4+4]) for i in range(w)) for r in rows) \
        if False else b''.join(b'\x00' + bytes(v for i in range(w) for v in rows[j][i*4:i*4+4]) for j in range(h))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
base = os.path.normpath(base)
os.makedirs(base, exist_ok=True)
full = render()
for size in (128, 48, 16):
    if size == 128:
        rows = full
    else:
        rows = []
        for y in range(size):
            sy = y * SIZE // size
            row = [0] * (size * 4)
            for x in range(size):
                sx = x * SIZE // size
                row[x*4:x*4+4] = full[sy][sx*4:sx*4+4]
            rows.append(row)
    write_png(os.path.join(base, f'icon{size}.png'), rows)
    print('written', f'icon{size}.png')
