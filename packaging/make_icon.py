#!/usr/bin/env python3
import math
import sys


SIZE = 1024


def mix(a, b, t):
    return int(a + (b - a) * t)


def rgb_at(x, y):
    cx = x - SIZE / 2
    cy = y - SIZE / 2
    d = min(1, math.hypot(cx, cy) / (SIZE * 0.72))
    base = (24, 103, 75)
    edge = (10, 43, 35)
    color = tuple(mix(base[i], edge[i], d) for i in range(3))

    border_dist = abs(math.hypot(cx, cy) - 438)
    if border_dist < 30:
        return (229, 183, 83)

    sx = cx / 260
    sy = cy / 260
    left_lobe = (sx + 0.46) ** 2 + (sy + 0.1) ** 2 < 0.43
    right_lobe = (sx - 0.46) ** 2 + (sy + 0.1) ** 2 < 0.43
    point = abs(sx) < max(0, 1.0 + sy * 1.1) and -0.95 < sy < 0.72
    stem = abs(sx) < 0.16 and 0.45 < sy < 1.22
    foot = abs(sx) < 0.42 and 1.03 < sy < 1.25
    if left_lobe or right_lobe or point or stem or foot:
        return (245, 241, 229)

    highlight = ((x - 318) / 180) ** 2 + ((y - 286) / 100) ** 2 < 1
    if highlight:
        return tuple(min(255, c + 26) for c in color)

    return color


def main():
    output = sys.argv[1]
    with open(output, "wb") as handle:
        handle.write(f"P6\n{SIZE} {SIZE}\n255\n".encode("ascii"))
        for y in range(SIZE):
            row = bytearray()
            for x in range(SIZE):
                row.extend(rgb_at(x, y))
            handle.write(row)


if __name__ == "__main__":
    main()
