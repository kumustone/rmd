#!/usr/bin/env python3
"""Mardo 端侧对照测试的像素度量库（口径见 docs/design/0063 §1.3、§2.8）。

本文件只做**离线像素度量**：读一张 PNG、按 ROI 统计墨迹，输出可复跑的确定性 JSON。
⛔ 不启动任何 app、不抓屏、不合成事件；输入只有 PNG 与 roi.json。

实现范围（严格照 §2.8 的量法目录）：

  M1  一维行带投影
      ROI = 正文内容列 = `.doc` 的 **content box**（left/right 已含 padding）。
      背景 bg = ROI 外框 10 px 的众数色（可用 --bg 覆盖）。
      墨迹   = max(|R-bgR|, |G-bgG|, |B-bgB|) >= threshold（默认 32）。
      墨迹行 = 该行 ROI 内墨迹像素数 >= 2。
      相邻墨迹行间隔 <= 1 px 时合并为同一带；带高 < 4 px 丢弃。
      输出每带 top/bottom/height/left/right/ink。
      B = **「连续 ≥3 行正文」子集**里相邻带中心差的中位数（§2.2 / L1538-1540）；
      全带中位数降级为 `pitch.B_all_bands`（bug 0148）。
      装饰性连续墨迹（引用条、表格线、代码底色边框）会把多行并成一带：
      确认能按列/行剔除时输出 `decorations` + `split_preview`（诊断用，⛔ 不改 M1 主口径，
      bug 0120 的数值修正待设计批准）。

  M2  垂直投影 / 列边界
      在给定水平切片内逐列统计墨迹数；连续 >= 2 px 零墨迹列算列间隙，
      间隙中点即边界；两边界之间的墨迹包围盒即单元格文字盒。
      只在**两侧都有墨迹**时把零列间隙记为列边界（页边空白不产生边界）。
      ⛔ 表格的 1 px 竖线不是「零墨迹列」，不能用本方法当表格线；线色按 M4 单独定位。

  M3  二维连通域 / 列表标记分割
      8 连通，最小面积 6 px；输出 bbox/area/solidity。
      每层用该层 `li` 的 getBoundingClientRect().left 作局部 x0，
      在 [x0, x0 + 3em] 内取连通域，最左连通域即标记，下一个即文字首字。
      ⛔ 不接受全局 x0：第 2 层起全局 x0 够不到标记。

  M4  颜色游程 / 众数色
      取样区 = 目标 bbox 向内腐蚀 2 px；排除墨迹像素后取众数色（背景填充），
      或沿 1 px 线取逐通道中位色；色差用 ΔE2000（公式见 delta_e_2000_lab）。
      面积 >= 3x3 容差 <= 3；1 px 线容差 <= 8 或仅登记。

ROI 语义（§2.8 U8）：
  roi.json 给的是 **content box**，不是 border box。接受以下写法：
    {"left":..,"top":..,"right":..,"bottom":..}
    {"x0":..,"y0":..,"x1":..,"y1":..}
    {"content_box":{"left":..,"top":..,"right":..,"bottom":..}, ...}
  若只出现 "border_box" 而没有 content box，本工具**明确报错**，不拿 border box 猜测。
  坐标单位是 PNG 设备像素；right/bottom 为半开区间（像素列 left..right-1）。
  padding_left/padding_right 只记录、不再次相减（content box 已含偏移）。
  ⛔ border box 会让文字左缘整体差一个 padding。

PNG 解码：
  只用标准库 zlib/struct。支持 8-bit、非隔行的：
    color type 0（灰度）、2（RGB）、3（调色板）、4（灰度+alpha）、6（RGBA）；
    PNG filter 0–4（None/Sub/Up/Average/Paeth）；多 IDAT；tRNS。
  16-bit、隔行、未知关键块等**明确报错**，不猜。
  alpha < 255 时按白底合成（截图通常不透明；合成只影响半透明边缘）。

确定性：
  不读随机数、不读系统字体、不依赖 Pillow；同一输入永远得到同一输出。
  众数色并列时取字典序最小的 RGB 三元组。

用法：
  # M1：行带
  python3 tools/visual-parity/bands.py --png frame.png --roi roi.json --json /tmp/bands.json

  # M1 负对照：把墨迹阈值从 32 改成 160（N2）
  python3 tools/visual-parity/bands.py --png frame.png --roi roi.json --threshold 160

  # M2：第 0 条带内的列分割
  python3 tools/visual-parity/bands.py --png frame.png --roi roi.json --columns --band 0

  # M3：第 0 条带内，各层 li 左缘的标记区
  python3 tools/visual-parity/bands.py --png frame.png --roi roi.json --marker \
      --band 0 --x0 678 --layer-left 678 734 790 --em 28

  # M4：取样区众数色 + 与 #007569 的 ΔE2000
  python3 tools/visual-parity/bands.py --png frame.png --roi roi.json \
      --sample-color 100,200,300,260 --ref '#007569'

  # M4：1 px 线取中位色
  python3 tools/visual-parity/bands.py --png frame.png --roi roi.json \
      --sample-color 100,199,300,200 --line --ref '#007569'

退出码：0 = 成功；2 = 用法/解码/ROI 错误（错误只写 stderr，不输出半成品 JSON）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys
import zlib
from collections import Counter
from dataclasses import dataclass
from statistics import median

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# PNG 颜色类型 -> 每像素通道数（本工具只收 8-bit，通道数即字节数）
_PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}

# §2.8 M1 默认值（--threshold 等可覆盖，但默认值必须与设计一致）
DEFAULT_THRESHOLD = 32
DEFAULT_MIN_ROW_INK = 2
DEFAULT_MAX_GAP = 1
DEFAULT_MIN_BAND_HEIGHT = 4
DEFAULT_BG_MARGIN = 10

# §2.8 M2/M3 默认值
DEFAULT_MIN_GAP_COLS = 2
DEFAULT_MIN_AREA = 6

# §2.8 M4 / §2.3 T4 默认值
DEFAULT_ERODE = 2
DEFAULT_DE_TOL_AREA = 3.0
DEFAULT_DE_TOL_LINE = 8.0

# §2.2 `B` 的取法（C2）：只取「连续 ≥3 行正文」的相邻带中心差（bug 0148）
DEFAULT_BODY_RUN_MIN_LINES = 3
DEFAULT_BODY_RUN_GAP_FACTOR = 1.5

# §2.8 M1 装饰墨迹检测（bug 0120；仅诊断，不改 M1 主口径）
DEFAULT_DECORATION_COVERAGE = 0.90   # 一列/一行在该带内 ≥90% 的行/列有墨迹
DEFAULT_DECORATION_MAX_WIDTH = 32    # 装饰竖列最多 32 设备 px（=16 CSS px @DPR2）
DEFAULT_DECORATION_ROW_COVERAGE = 0.95  # 横线类装饰：行长 ≥95% **带内**墨迹宽
DEFAULT_DECORATION_MAX_ROW_HEIGHT = 4   # 装饰横行最多 4 设备 px（=2 CSS px @DPR2）
DEFAULT_DECORATION_MIN_SUBBAND_HEIGHT = 12  # 剔除后每个子带至少 12 设备 px（6 CSS px @DPR2）

# sRGB -> CIELAB 的 D65 白点（CIE 标准值）
_D65_XN = 0.95047
_D65_YN = 1.00000
_D65_ZN = 1.08883


# ---------------------------------------------------------------------------
# 1. PNG 解码（标准库）
# ---------------------------------------------------------------------------

class PngError(ValueError):
    """PNG 格式/解码错误。调用方应把它变成明确的 stderr 报错。"""


class Image:
    """解码后的 8-bit RGB 图像。

    rgb 是长度为 width*height*3 的 bytes/bytearray，按行优先排列。
    半透明像素已在解码时按白底合成，因此下游只需处理 RGB 三元组。
    """

    __slots__ = ("width", "height", "rgb")

    def __init__(self, width: int, height: int, rgb: bytes) -> None:
        self.width = width
        self.height = height
        self.rgb = rgb

    def pixel(self, x: int, y: int) -> tuple[int, int, int]:
        i = (y * self.width + x) * 3
        return self.rgb[i], self.rgb[i + 1], self.rgb[i + 2]


def _over_white(channel: int, alpha: int) -> int:
    """把 8-bit 通道按 alpha 合成到白底；四舍五入用整数运算，确定性。"""
    if alpha == 255:
        return channel
    return (channel * alpha + 255 * (255 - alpha) + 127) // 255


def _unfilter(raw: bytes, height: int, stride: int, bpp: int) -> bytes:
    """还原 PNG scanline 的 filter（0–4）。bpp = 每像素字节数。"""
    out = bytearray(height * stride)
    prev = bytearray(stride)  # 第一行的上一行按全 0 处理
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        row = bytearray(raw[pos:pos + stride])
        pos += stride

        if ftype == 0:  # None
            pass
        elif ftype == 1:  # Sub
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa = abs(p - a)
                pb = abs(p - b)
                pc = abs(p - c)
                if pa <= pb and pa <= pc:
                    pr = a
                elif pb <= pc:
                    pr = b
                else:
                    pr = c
                row[i] = (row[i] + pr) & 0xFF
        else:
            raise PngError(f"不支持的 PNG filter 类型 {ftype}（行 {y}）")

        out[y * stride:(y + 1) * stride] = row
        prev = row

    return bytes(out)


def decode_png(path: str) -> Image:
    """解码 8-bit、非隔行 PNG。任何不确定的变体都明确报错。"""
    with open(path, "rb") as f:
        blob = f.read()

    if len(blob) < 8 or blob[:8] != PNG_SIGNATURE:
        raise PngError(f"{path}: 不是 PNG（签名不符）")

    pos = 8
    ihdr = None
    idat_parts: list[bytes] = []
    plte = None
    trns = None
    saw_iend = False

    while pos < len(blob):
        if pos + 8 > len(blob):
            raise PngError(f"{path}: PNG 在块头处截断")
        length, ctype = struct.unpack(">I4s", blob[pos:pos + 8])
        pos += 8
        if pos + length + 4 > len(blob):
            raise PngError(f"{path}: PNG 块 {ctype!r} 数据截断")
        data = blob[pos:pos + length]
        pos += length
        crc = struct.unpack(">I", blob[pos:pos + 4])[0]
        pos += 4

        actual_crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
        if actual_crc != crc:
            raise PngError(
                f"{path}: PNG 块 {ctype.decode('latin-1', 'replace')} CRC 不符"
            )

        if ctype == b"IHDR":
            if ihdr is not None:
                raise PngError(f"{path}: 出现多个 IHDR")
            if length != 13:
                raise PngError(f"{path}: IHDR 长度应为 13，实际 {length}")
            ihdr = struct.unpack(">IIBBBBB", data)
        elif ctype == b"PLTE":
            plte = data
        elif ctype == b"tRNS":
            trns = data
        elif ctype == b"IDAT":
            idat_parts.append(data)
        elif ctype == b"IEND":
            saw_iend = True
            break
        elif ctype[:1].isupper():
            # 首字母大写 = 关键块；不认识就不能继续，避免读出错像素。
            raise PngError(
                f"{path}: 未知关键块 {ctype.decode('latin-1', 'replace')}"
            )
        # 其余为辅助块（gAMA/sRGB/pHYs/iCCP/tEXt…），跳过即可。

    if ihdr is None:
        raise PngError(f"{path}: 缺少 IHDR")
    if not idat_parts:
        raise PngError(f"{path}: 缺少 IDAT")
    if not saw_iend:
        raise PngError(f"{path}: 缺少 IEND")

    width, height, bit_depth, color_type, compression, png_filter, interlace = ihdr
    if width <= 0 or height <= 0:
        raise PngError(f"{path}: 非法尺寸 {width}x{height}")
    if bit_depth != 8:
        raise PngError(
            f"{path}: 只支持 8-bit PNG，实际 {bit_depth}-bit；"
            "需要先无损转换成 8-bit（本工具不猜）"
        )
    if color_type not in _PNG_CHANNELS:
        raise PngError(f"{path}: 不支持的 PNG 颜色类型 {color_type}")
    if compression != 0 or png_filter != 0:
        raise PngError(
            f"{path}: 不支持的 PNG 压缩/滤波方法 "
            f"(compression={compression}, filter={png_filter})"
        )
    if interlace != 0:
        raise PngError(f"{path}: 不支持隔行 PNG（interlace={interlace}）")
    if color_type == 3 and plte is None:
        raise PngError(f"{path}: 调色板 PNG 缺少 PLTE")

    channels = _PNG_CHANNELS[color_type]
    bpp = channels
    stride = width * channels
    raw = b"".join(idat_parts)
    try:
        inflated = zlib.decompress(raw)
    except zlib.error as exc:
        raise PngError(f"{path}: IDAT zlib 解压失败：{exc}") from exc

    expected = height * (1 + stride)
    if len(inflated) != expected:
        raise PngError(
            f"{path}: 解压后长度 {len(inflated)} != 期望 {expected}"
            "（尺寸/颜色类型与数据不一致）"
        )

    scan = _unfilter(inflated, height, stride, bpp)
    npix = width * height
    rgb = bytearray(npix * 3)

    if color_type == 2:  # RGB
        if trns is not None and len(trns) >= 6:
            tr, tg, tb = struct.unpack(">HHH", trns[:6])
            for i in range(npix):
                j = i * 3
                r, g, b = scan[j], scan[j + 1], scan[j + 2]
                if r == tr and g == tg and b == tb:
                    r = g = b = 255  # tRNS 指定的透明像素按白底合成
                rgb[j], rgb[j + 1], rgb[j + 2] = r, g, b
        else:
            rgb[:] = scan
    elif color_type == 6:  # RGBA
        for i in range(npix):
            j = i * 4
            a = scan[j + 3]
            if a == 255:
                rgb[i * 3] = scan[j]
                rgb[i * 3 + 1] = scan[j + 1]
                rgb[i * 3 + 2] = scan[j + 2]
            else:
                rgb[i * 3] = _over_white(scan[j], a)
                rgb[i * 3 + 1] = _over_white(scan[j + 1], a)
                rgb[i * 3 + 2] = _over_white(scan[j + 2], a)
    elif color_type == 0:  # 灰度
        trns_gray = struct.unpack(">H", trns[:2])[0] if trns and len(trns) >= 2 else None
        for i, g in enumerate(scan):
            if trns_gray is not None and g == trns_gray:
                g = 255
            j = i * 3
            rgb[j] = rgb[j + 1] = rgb[j + 2] = g
    elif color_type == 4:  # 灰度 + alpha
        for i in range(npix):
            g = _over_white(scan[i * 2], scan[i * 2 + 1])
            j = i * 3
            rgb[j] = rgb[j + 1] = rgb[j + 2] = g
    else:  # color_type == 3，调色板
        if len(plte) % 3 != 0 or len(plte) < 3:
            raise PngError(f"{path}: PLTE 长度 {len(plte)} 不是 3 的倍数")
        ncolors = len(plte) // 3
        palette = [
            (plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2])
            for i in range(ncolors)
        ]
        alphas = [255] * ncolors
        if trns is not None:
            for i, a in enumerate(trns[:ncolors]):
                alphas[i] = a
        for i, idx in enumerate(scan):
            if idx >= ncolors:
                raise PngError(
                    f"{path}: 调色板索引 {idx} 越界（只有 {ncolors} 色）"
                )
            r, g, b = palette[idx]
            a = alphas[idx]
            if a != 255:
                r = _over_white(r, a)
                g = _over_white(g, a)
                b = _over_white(b, a)
            j = i * 3
            rgb[j], rgb[j + 1], rgb[j + 2] = r, g, b

    return Image(width, height, bytes(rgb))


# ---------------------------------------------------------------------------
# 2. 颜色工具：众数色、sRGB->Lab、ΔE2000
# ---------------------------------------------------------------------------

def mode_rgb(counts: Counter) -> tuple[tuple[int, int, int], int]:
    """取众数色；并列时取字典序最小的 RGB，保证确定性。"""
    best_color = None
    best_n = -1
    for color, n in counts.items():
        if n > best_n or (n == best_n and (best_color is None or color < best_color)):
            best_color = color
            best_n = n
    if best_color is None:
        raise ValueError("众数色：空集合")
    return best_color, best_n


def rgb_hex(rgb) -> str:
    return "#%02x%02x%02x" % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def parse_color(text: str) -> tuple[int, int, int]:
    """解析 #rgb / #rrggbb / "r,g,b" / "rgb(r,g,b)"。"""
    t = text.strip()
    if t.startswith("#"):
        h = t[1:]
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        if len(h) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", h):
            raise ValueError(f"颜色格式不对：{text!r}（需要 #rgb 或 #rrggbb）")
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)

    m = re.fullmatch(r"rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", t, re.I)
    if m:
        vals = tuple(int(v) for v in m.groups())
    else:
        parts = [p for p in re.split(r"[,\s]+", t) if p]
        if len(parts) != 3:
            raise ValueError(f"颜色格式不对：{text!r}（需要 #rrggbb 或 r,g,b）")
        vals = tuple(int(p) for p in parts)

    if any(v < 0 or v > 255 for v in vals):
        raise ValueError(f"颜色分量越界：{text!r}")
    return vals  # type: ignore[return-value]


def _max_channel_diff(a, b) -> int:
    """max(|R-bgR|, |G-bgG|, |B-bgB|)，与 §2.8 M1 的墨迹定义一致。"""
    d = abs(a[0] - b[0])
    d2 = abs(a[1] - b[1])
    if d2 > d:
        d = d2
    d3 = abs(a[2] - b[2])
    if d3 > d:
        d = d3
    return d


def _srgb_to_linear(v: int) -> float:
    c = v / 255.0
    # IEC 61966-2-1 的 sRGB 传输函数反变换
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb) -> tuple[float, float, float]:
    """sRGB(8-bit) -> CIELAB(D65)。公式与常数写死在注释里，便于复核。"""
    r = _srgb_to_linear(rgb[0])
    g = _srgb_to_linear(rgb[1])
    b = _srgb_to_linear(rgb[2])

    # sRGB -> XYZ（D65，IEC 61966-2-1 矩阵）
    x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b

    def f(t: float) -> float:
        # CIELAB 的 f(t)：t > (6/29)^3 用立方根，否则线性段
        if t > 0.008856451679035631:
            return t ** (1.0 / 3.0)
        return 7.787037037037035 * t + 16.0 / 116.0

    fx = f(x / _D65_XN)
    fy = f(y / _D65_YN)
    fz = f(z / _D65_ZN)

    # L* = 116 f(Y/Yn) - 16；a* = 500 (f(X/Xn) - f(Y/Yn))；b* = 200 (f(Y/Yn) - f(Z/Zn))
    return 116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)


def delta_e_2000_lab(lab1, lab2) -> float:
    """CIEDE2000 色差（Sharma, Wu & Dalal 2005 的公式与常数）。

    记号：L' = L；a' = (1+G)a；C' = sqrt(a'^2+b^2)；h' = atan2(b,a')。
    色差：
      ΔE00 = sqrt( (ΔL'/kL·SL)^2 + (ΔC'/kC·SC)^2 + (ΔH'/kH·SH)^2
                   + RT (ΔC'/SC)(ΔH'/SH) )
    其中 kL=kC=kH=1（本仓口径不调权重）。
    """
    L1, a1, b1 = lab1
    L2, a2, b2 = lab2

    C1 = math.hypot(a1, b1)
    C2 = math.hypot(a2, b2)
    Cbar = (C1 + C2) / 2.0
    Cbar7 = Cbar ** 7
    # G = 0.5 (1 - sqrt(Cbar^7 / (Cbar^7 + 25^7)))
    G = 0.5 * (1.0 - math.sqrt(Cbar7 / (Cbar7 + 25.0 ** 7)))

    a1p = (1.0 + G) * a1
    a2p = (1.0 + G) * a2
    C1p = math.hypot(a1p, b1)
    C2p = math.hypot(a2p, b2)

    # h' 是 atan2 的度数形式，归一到 [0,360)；a'=b=0 时无色相，按 0 处理。
    h1p = math.degrees(math.atan2(b1, a1p)) % 360.0 if (a1p != 0.0 or b1 != 0.0) else 0.0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360.0 if (a2p != 0.0 or b2 != 0.0) else 0.0

    dLp = L2 - L1
    dCp = C2p - C1p

    # Δh' 归一到 (-180,180]；任一 C'=0 时色相差无定义，取 0。
    if C1p * C2p == 0.0:
        dhp = 0.0
    else:
        dhp = h2p - h1p
        if dhp > 180.0:
            dhp -= 360.0
        elif dhp < -180.0:
            dhp += 360.0
    dHp = 2.0 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2.0))

    Lbarp = (L1 + L2) / 2.0
    Cbarp = (C1p + C2p) / 2.0

    # h̄'：C'=0 时取 h1'+h2'；否则按两色相是否跨 0/360 取平均
    if C1p * C2p == 0.0:
        hbarp = h1p + h2p
    elif abs(h1p - h2p) <= 180.0:
        hbarp = (h1p + h2p) / 2.0
    elif h1p + h2p < 360.0:
        hbarp = (h1p + h2p + 360.0) / 2.0
    else:
        hbarp = (h1p + h2p - 360.0) / 2.0

    # T = 1 - 0.17 cos(h̄'-30) + 0.24 cos(2h̄') + 0.32 cos(3h̄'+6) - 0.20 cos(4h̄'-63)
    T = (
        1.0
        - 0.17 * math.cos(math.radians(hbarp - 30.0))
        + 0.24 * math.cos(math.radians(2.0 * hbarp))
        + 0.32 * math.cos(math.radians(3.0 * hbarp + 6.0))
        - 0.20 * math.cos(math.radians(4.0 * hbarp - 63.0))
    )

    # Δθ = 30 exp(-((h̄'-275)/25)^2)；RC = 2 sqrt(C̄'^7/(C̄'^7+25^7))
    dtheta = 30.0 * math.exp(-(((hbarp - 275.0) / 25.0) ** 2))
    Cbarp7 = Cbarp ** 7
    RC = 2.0 * math.sqrt(Cbarp7 / (Cbarp7 + 25.0 ** 7))

    # SL = 1 + 0.015 (L̄'-50)^2 / sqrt(20 + (L̄'-50)^2)
    SL = 1.0 + (0.015 * ((Lbarp - 50.0) ** 2)) / math.sqrt(
        20.0 + ((Lbarp - 50.0) ** 2)
    )
    SC = 1.0 + 0.045 * Cbarp
    SH = 1.0 + 0.015 * Cbarp * T
    RT = -math.sin(math.radians(2.0 * dtheta)) * RC

    tL = dLp / SL
    tC = dCp / SC
    tH = dHp / SH
    return math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH)


# ---------------------------------------------------------------------------
# 3. ROI（content box）与背景色
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Rect:
    """半开区间 [left,right) x [top,bottom)，单位是 PNG 设备像素。"""

    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    def to_dict(self) -> dict:
        return {
            "left": self.left,
            "top": self.top,
            "right": self.right,
            "bottom": self.bottom,
            "width": self.width,
            "height": self.height,
        }


def _pick_field(obj: dict, names: tuple[str, ...], label: str) -> tuple[object, str]:
    for name in names:
        if name in obj and obj[name] is not None:
            return obj[name], name
    raise PngError(f"roi.json 缺少 {label}（可用字段：{', '.join(names)}）")


def _to_pixel(value, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PngError(f"roi.json 的 {label} 不是数字：{value!r}")
    return int(math.floor(float(value) + 0.5))  # 四舍五入，避免银行家舍入


def load_roi(path: str, image: Image) -> dict:
    """读 roi.json，返回 content box 与来源说明。

    ⛔ 只认 content box；只有 border_box 时明确报错，不替调用方减 padding。
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except json.JSONDecodeError as exc:
        raise PngError(f"{path}: 不是合法 JSON：{exc}") from exc
    if not isinstance(obj, dict):
        raise PngError(f"{path}: roi.json 顶层必须是对象")

    source = None
    src: dict
    if isinstance(obj.get("content_box"), dict):
        src = obj["content_box"]
        source = "content_box"
    elif any(k in obj for k in ("left", "right", "x0", "x1", "x", "y0", "y1", "top", "bottom")):
        src = obj
        source = "flat"
    elif isinstance(obj.get("border_box"), dict):
        raise PngError(
            f"{path}: 只找到 border_box，没有 content box。§2.8 U8 要求 ROI 是 "
            "`.doc` 的 content box（left+paddingLeft 到 right−paddingRight）；"
            "⛔ 本工具不会拿 border box 猜测"
        )
    else:
        raise PngError(f"{path}: 找不到 ROI 四边（left/top/right/bottom 或 content_box）")

    left_v, left_k = _pick_field(src, ("left", "x0", "x"), "left")
    right_v, right_k = _pick_field(src, ("right", "x1"), "right")
    top_v, top_k = _pick_field(src, ("top", "y0", "y"), "top")
    bottom_v, bottom_k = _pick_field(src, ("bottom", "y1"), "bottom")

    left = _to_pixel(left_v, left_k)
    right = _to_pixel(right_v, right_k)
    top = _to_pixel(top_v, top_k)
    bottom = _to_pixel(bottom_v, bottom_k)

    raw = {
        "left": left_v,
        "top": top_v,
        "right": right_v,
        "bottom": bottom_v,
    }
    warnings: list[str] = []

    if left >= right or top >= bottom:
        raise PngError(
            f"{path}: ROI 非法 [{left},{right}) x [{top},{bottom})；"
            "right 必须大于 left，bottom 必须大于 top"
        )

    clipped_left = max(0, left)
    clipped_top = max(0, top)
    clipped_right = min(image.width, right)
    clipped_bottom = min(image.height, bottom)
    if clipped_left >= clipped_right or clipped_top >= clipped_bottom:
        raise PngError(
            f"{path}: ROI [{left},{right}) x [{top},{bottom}) 完全落在 "
            f"{image.width}x{image.height} 图像之外"
        )
    clipped = (
        clipped_left != left
        or clipped_top != top
        or clipped_right != right
        or clipped_bottom != bottom
    )
    if clipped:
        warnings.append(
            f"ROI 超出图像范围，已裁到 [{clipped_left},{clipped_right}) x "
            f"[{clipped_top},{clipped_bottom})"
        )

    rect = Rect(clipped_left, clipped_top, clipped_right, clipped_bottom)
    # bug 0165：`l2-run.sh` 曾把 ROI 纵向写成 `top=0 … 视口高`，画布上方的应用界面
    # （标题/工具条文字）被当作正文行带。这里不替调用方猜内容盒，只把「纵向覆盖整幅画布」
    # 这个可疑形态显式报出来；真正的取法由调用方从 `.doc` content box 的 top/bottom 写入。
    if source == "content_box" and top == 0 and bottom >= image.height:
        warnings.append(
            "ROI 纵向覆盖整幅画布（top=0、bottom>=图像高）：疑似未取 `.doc` content box 的"
            "纵向边界，画布上方的界面文字会被并进行带（bug 0165）"
        )
    dpr = obj.get("dpr")
    return {
        "rect": rect,
        "source": source,
        "raw": raw,
        "clipped": clipped,
        "warnings": warnings,
        # 只记录，不再次相减：content box 已经含过 padding 偏移。
        "padding_left": obj.get("padding_left"),
        "padding_right": obj.get("padding_right"),
        "border_box_present": isinstance(obj.get("border_box"), dict),
        # bug 0164：M4 容差按「1 CSS px 线」判形态时需要 DPR；缺省不猜，交给调用方。
        "dpr": dpr if isinstance(dpr, (int, float)) and not isinstance(dpr, bool) else None,
    }


def estimate_background(image: Image, rect: Rect, margin: int = DEFAULT_BG_MARGIN):
    """§2.8 M1：bg = ROI 外框 10 px 的众数色。

    外框 = 把 ROI 四边各向外扩 margin 后的矩形减去 ROI 本身；超出图像的部分裁掉。
    若 ROI 占满整图（外框为空），退回 ROI 内部的众数色并如实记录来源。
    """
    counts: Counter = Counter()
    x0 = max(0, rect.left - margin)
    x1 = min(image.width, rect.right + margin)
    y0 = max(0, rect.top - margin)
    y1 = min(image.height, rect.bottom + margin)

    for y in range(y0, y1):
        base = y * image.width * 3
        for x in range(x0, x1):
            if rect.left <= x < rect.right and rect.top <= y < rect.bottom:
                continue  # 只要外框，不要 ROI 内部
            i = base + x * 3
            counts[(image.rgb[i], image.rgb[i + 1], image.rgb[i + 2])] += 1

    if counts:
        color, n = mode_rgb(counts)
        return color, n, sum(counts.values()), "roi_outer_10px"

    # 退化路径：ROI 贴着图像四边，外框为空。
    for y in range(rect.top, rect.bottom):
        base = y * image.width * 3
        for x in range(rect.left, rect.right):
            i = base + x * 3
            counts[(image.rgb[i], image.rgb[i + 1], image.rgb[i + 2])] += 1
    color, n = mode_rgb(counts)
    return color, n, sum(counts.values()), "roi_interior_fallback"


# ---------------------------------------------------------------------------
# 4. M1：一维行带投影
# ---------------------------------------------------------------------------

def _row_ink_profile(image: Image, rect: Rect, bg, threshold: int):
    """逐行统计 ROI 内墨迹像素数，同时记下该行墨迹的 min/max x。

    返回 (row_count, row_min, row_max)，数组下标是 y - rect.top；
    没有墨迹的行 min/max 记为 -1。
    """
    nrows = rect.height
    row_count = [0] * nrows
    row_min = [-1] * nrows
    row_max = [-1] * nrows

    bgr, bgg, bgb = bg
    left, right = rect.left, rect.right

    for ridx, y in enumerate(range(rect.top, rect.bottom)):
        base = y * image.width * 3
        count = 0
        mn = -1
        mx = -1
        for x in range(left, right):
            i = base + x * 3
            d = abs(image.rgb[i] - bgr)
            d2 = abs(image.rgb[i + 1] - bgg)
            if d2 > d:
                d = d2
            d3 = abs(image.rgb[i + 2] - bgb)
            if d3 > d:
                d = d3
            if d >= threshold:
                count += 1
                if mn < 0:
                    mn = x
                mx = x
        row_count[ridx] = count
        row_min[ridx] = mn
        row_max[ridx] = mx

    return row_count, row_min, row_max


def detect_bands(
    rect: Rect,
    row_count: list[int],
    row_min: list[int],
    row_max: list[int],
    min_row_ink: int = DEFAULT_MIN_ROW_INK,
    max_gap: int = DEFAULT_MAX_GAP,
    min_band_height: int = DEFAULT_MIN_BAND_HEIGHT,
) -> list[dict]:
    """把墨迹行合并成带。

    - 墨迹行：row_count >= min_row_ink（默认 2）
    - 相邻墨迹行间隔 <= max_gap（默认 1）合并
    - 带高 < min_band_height（默认 4）丢弃
    返回的 top/bottom 是**闭区间**的 PNG y 坐标；left/right 也是闭区间 x 坐标。
    """
    bands: list[dict] = []
    current_top = None
    last_ink_row = None

    def flush(top: int, bottom: int) -> None:
        height = bottom - top + 1
        if height < min_band_height:
            return
        ridx0 = top - rect.top
        ridx1 = bottom - rect.top
        ink = 0
        band_left = -1
        band_right = -1
        for ridx in range(ridx0, ridx1 + 1):
            if row_min[ridx] >= 0:
                ink += row_count[ridx]
                if band_left < 0 or row_min[ridx] < band_left:
                    band_left = row_min[ridx]
                if row_max[ridx] > band_right:
                    band_right = row_max[ridx]
        bands.append(
            {
                "index": len(bands),
                "top": top,
                "bottom": bottom,
                "height": height,
                # 带中心用连续坐标 (top+bottom)/2；行距 = 相邻带中心差
                "center": (top + bottom) / 2.0,
                "left": band_left if band_left >= 0 else None,
                "right": band_right if band_right >= 0 else None,
                "width": (band_right - band_left + 1) if band_left >= 0 else None,
                "ink": ink,
            }
        )

    for ridx, y in enumerate(range(rect.top, rect.bottom)):
        if row_count[ridx] < min_row_ink:
            continue
        if current_top is None:
            current_top = y
        elif y - last_ink_row - 1 > max_gap:
            flush(current_top, last_ink_row)
            current_top = y
        last_ink_row = y

    if current_top is not None:
        flush(current_top, last_ink_row)

    return bands


def _median_or_none(values: list[float]):
    return float(median(values)) if values else None


# ---------------------------------------------------------------------------
# 4b. M1 装饰墨迹诊断（bug 0120；⛔ 不改 M1 主口径）
# ---------------------------------------------------------------------------

def _index_runs(flags: list[bool]) -> list[tuple[int, int]]:
    """把布尔序列切成连续 True 的下标区间 [start, end]（闭区间）。"""
    runs: list[tuple[int, int]] = []
    start = None
    for i, flag in enumerate(flags):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(flags) - 1))
    return runs


def _band_column_ink(image: Image, rect: Rect, band: dict, bg, threshold: int):
    """统计带内每一列「有墨迹的行数」；返回 (col_counts, nrows)。"""
    top = band["top"]
    bottom = band["bottom"] + 1
    nrows = bottom - top
    counts = [0] * rect.width
    bgr, bgg, bgb = bg
    for y in range(top, bottom):
        base = y * image.width * 3
        for cidx, x in enumerate(range(rect.left, rect.right)):
            i = base + x * 3
            d = abs(image.rgb[i] - bgr)
            d2 = abs(image.rgb[i + 1] - bgg)
            if d2 > d:
                d = d2
            d3 = abs(image.rgb[i + 2] - bgb)
            if d3 > d:
                d = d3
            if d >= threshold:
                counts[cidx] += 1
    return counts, nrows


def _row_counts_excluding(
    image: Image,
    rect: Rect,
    top: int,
    bottom: int,
    bg,
    threshold: int,
    excluded_columns: list[bool],
    excluded_rows,
):
    """在 [top,bottom) 内重算逐行墨迹数，跳过 `excluded_columns` 的列。

    参数与 `_row_ink_profile` 同形，另接受一个「已判定为装饰」的行下标集合；
    这些行会被置为 0 墨迹，从而不再充当「把上下两行连起来」的桥。
    """
    nrows = bottom - top
    counts = [0] * nrows
    mins = [-1] * nrows
    maxs = [-1] * nrows
    bgr, bgg, bgb = bg
    for ridx, y in enumerate(range(top, bottom)):
        if y in excluded_rows:
            continue
        base = y * image.width * 3
        count = 0
        mn = -1
        mx = -1
        for cidx, x in enumerate(range(rect.left, rect.right)):
            if excluded_columns[cidx]:
                continue
            i = base + x * 3
            d = abs(image.rgb[i] - bgr)
            d2 = abs(image.rgb[i + 1] - bgg)
            if d2 > d:
                d = d2
            d3 = abs(image.rgb[i + 2] - bgb)
            if d3 > d:
                d = d3
            if d >= threshold:
                count += 1
                if mn < 0:
                    mn = x
                mx = x
        counts[ridx] = count
        mins[ridx] = mn
        maxs[ridx] = mx
    return counts, mins, maxs


def analyze_decorations(
    image: Image,
    rect: Rect,
    bands: list[dict],
    row_count: list[int],
    bg,
    threshold: int,
    min_row_ink: int = DEFAULT_MIN_ROW_INK,
    max_gap: int = DEFAULT_MAX_GAP,
    min_band_height: int = DEFAULT_MIN_BAND_HEIGHT,
) -> tuple[dict[int, dict], list[str], dict]:
    """找出「被装饰墨迹把多行并成一带」的带，并给出剔除后的分行预览（诊断用）。

    判定**必须**同时满足：
      1. 带内存在连续列，其在 ≥`coverage` 的行上有墨迹，且列宽 ≤ `max_width`；
         或存在连续行，其墨迹横跨 ≥`row_coverage` 的带内墨迹宽（横线类）；
      2. 把这些列/行剔除后重新按 M1 规则分行，**行数 > 1** 且每个子带高
         ≥ `DEFAULT_DECORATION_MIN_SUBBAND_HEIGHT`（12 设备 px = 6 CSS px @DPR2）。

    ⛔ 不改变 `bands` 本身：M1 的 ROI/口径写在 `design/0063` §2.8，改它属设计变更
    （bug 0120 的数值修正待设计批准）。这里只把「已静默合并」变成可见的 `decorations`
    ＋ `warnings`，并给出可复核的分行预览。

    ⚠️ 只对**确认能分开**的带发 `warnings`。单行带里的 CJK 竖笔画同样会让列投影
    出现「贯穿整带」的列（带内覆盖率可达 1.0），剔除后也可能剩下上下两片笔画尖；
    这类片段高 8 px 左右，低于子带下限 ⇒ `confirmed_split = false` 且
    `reject_reason = "subband-too-short"`，不上浮成告警，但候选留在逐带的
    `bands[].decoration` 里供审计。
    """
    detail: dict[int, dict] = {}
    warnings: list[str] = []

    heights = [b["height"] for b in bands if b.get("height")]
    if not heights:
        return detail, warnings, {
            "band_count": 0,
            "confirmed_band_count": 0,
            "coverage": DEFAULT_DECORATION_COVERAGE,
            "max_column_width_px": DEFAULT_DECORATION_MAX_WIDTH,
            "row_coverage": DEFAULT_DECORATION_ROW_COVERAGE,
            "max_row_height_px": DEFAULT_DECORATION_MAX_ROW_HEIGHT,
            "min_subband_height_px": DEFAULT_DECORATION_MIN_SUBBAND_HEIGHT,
            "median_band_height_px": None,
            "unconfirmed_band_count": 0,
            "rejected_band_count": 0,
            "note": "诊断项：本帧没有可用带（bug 0120）",
        }
    median_height = _median_or_none(heights) or heights[0]

    for band in bands:
        top = band["top"]
        bottom = band["bottom"] + 1
        # 少于 2 行的带没有可分的行，直接跳过。
        if bottom - top < 2:
            continue
        col_counts, nrows = _band_column_ink(image, rect, band, bg, threshold)
        need = max(1, math.ceil(DEFAULT_DECORATION_COVERAGE * nrows))
        col_flags = [c >= need for c in col_counts]
        col_runs = [
            (a, b)
            for a, b in _index_runs(col_flags)
            if 1 <= (b - a + 1) <= DEFAULT_DECORATION_MAX_WIDTH
        ]

        # 横线类装饰按**带内墨迹宽**判（表格/分隔线比 ROI 窄），且只认薄行；
        # 否则整块深色表头会被当成一根粗横线。
        band_width = max(1, band["right"] - band["left"] + 1)
        row_need = math.ceil(DEFAULT_DECORATION_ROW_COVERAGE * band_width)
        row_flags = []
        for y in range(top, bottom):
            ridx = y - rect.top
            row_flags.append(row_count[ridx] >= row_need)
        row_runs = [
            (a, b)
            for a, b in _index_runs(row_flags)
            if 1 <= (b - a + 1) <= DEFAULT_DECORATION_MAX_ROW_HEIGHT
        ]

        if not col_runs and not row_runs:
            continue

        excluded_columns = [False] * rect.width
        for a, b in col_runs:
            for cidx in range(a, b + 1):
                excluded_columns[cidx] = True
        excluded_rows = set()
        for a, b in row_runs:
            for ridx in range(a, b + 1):
                excluded_rows.add(top + ridx)

        counts, mins, maxs = _row_counts_excluding(
            image, rect, top, bottom, bg, threshold, excluded_columns, excluded_rows
        )
        sub_rect = Rect(rect.left, top, rect.right, bottom)
        sub_bands = detect_bands(
            sub_rect,
            counts,
            mins,
            maxs,
            min_row_ink=min_row_ink,
            max_gap=max_gap,
            min_band_height=min_band_height,
        )
        # 确认条件：剔除装饰后能分出 >1 个子带，且每个子带都够高（是文字行而不是笔画碎片）。
        # 反例（2026-11-08 实测）：单行只剩 2 个汉字时，CJK 竖笔画在带内覆盖率可达 1.0，
        # 剔除后剩下上下两片 8 px 的笔画尖 ⇒ 会被误报成「装饰把多行并成一带」。
        # 8 px（4 CSS px @DPR2）不可能是文字行，`subband-too-short` 即拒绝确认。
        sub_heights = [s["height"] for s in sub_bands]
        too_short = [h for h in sub_heights if h < DEFAULT_DECORATION_MIN_SUBBAND_HEIGHT]
        confirmed = len(sub_bands) > 1 and not too_short
        reject_reason = None
        if len(sub_bands) > 1 and too_short:
            reject_reason = "subband-too-short"

        # 剔除装饰列后带内最左墨迹列 = 「引用内容左缘」的像素量（`IND_quote`，bug 0163/0166）。
        # 含装饰时 `band.left` 会被引用条/表格竖线占住，不是内容左缘。
        content_left = None
        for cidx in range(rect.width):
            if excluded_columns[cidx]:
                continue
            if col_counts[cidx] > 0:
                content_left = rect.left + cidx
                break

        # 横线间距 = 像素口径的行高候选（表格行高 `H_table` 的像素来源，
        # bug 0169）。仍是诊断项：表头行/数据行的区分要靠 DOM，⛔ 不在这里猜。
        row_tops = [top + a for a, _ in row_runs]
        row_pitches = [
            round(float(row_tops[i + 1] - row_tops[i]), 3)
            for i in range(len(row_tops) - 1)
        ]

        entry = {
            "columns": [
                {
                    "left": rect.left + a,
                    "right": rect.left + b,
                    "width": b - a + 1,
                    "coverage": round(col_counts[a] / nrows, 4),
                }
                for a, b in col_runs
            ],
            "rows": [
                {
                    "top": top + a,
                    "bottom": top + b,
                    "height": b - a + 1,
                    "coverage": round(
                        row_count[top + a - rect.top] / band_width, 4
                    )
                    if band_width
                    else None,
                }
                for a, b in row_runs
            ],
            "confirmed_split": confirmed,
            "reject_reason": reject_reason,
            "subband_heights_px": sub_heights,
            "content_left_px": content_left,
            "content_left_source": (
                "剔除装饰列后带内最左墨迹列（像素）；`IND_quote` 的分子候选"
                if content_left is not None
                else None
            ),
            "row_pitches_px": row_pitches if row_pitches else None,
            "split_preview": {
                "line_count": len(sub_bands),
                "lines": [
                    {
                        "top": b["top"],
                        "bottom": b["bottom"],
                        "height": b["height"],
                    }
                    for b in sub_bands
                ],
                "diagnostic_only": True,
                "not_a_judged_quantity": (
                    "M1 主口径（§2.8）未改；剔除装饰列/行属 ROI 与量法变更，"
                    "bug 0120 待设计批准"
                ),
            },
        }
        detail[band["index"]] = entry
        if confirmed:
            cols = ", ".join(
                "[%d,%d]" % (c["left"], c["right"]) for c in entry["columns"]
            ) or "—"
            warnings.append(
                "band %d 被装饰墨迹合并（列 %s）：按 M1 规则剔除后 %d 行；"
                "M1 主口径未改，数值修正待设计批准（bug 0120）"
                % (band["index"], cols, len(sub_bands))
            )

    summary = {
        "band_count": len(detail),
        "confirmed_band_count": sum(
            1 for v in detail.values() if v["confirmed_split"]
        ),
        "coverage": DEFAULT_DECORATION_COVERAGE,
        "max_column_width_px": DEFAULT_DECORATION_MAX_WIDTH,
        "row_coverage": DEFAULT_DECORATION_ROW_COVERAGE,
        "max_row_height_px": DEFAULT_DECORATION_MAX_ROW_HEIGHT,
        "min_subband_height_px": DEFAULT_DECORATION_MIN_SUBBAND_HEIGHT,
        "median_band_height_px": round(median_height, 3),
        "unconfirmed_band_count": sum(
            1 for v in detail.values() if not v["confirmed_split"]
        ),
        "rejected_band_count": sum(
            1 for v in detail.values() if v.get("reject_reason")
        ),
        "note": (
            "诊断项：不改变 M1 的 bands/pitch；`split_preview` 仅用于说明"
            "「这一带其实有多少行」，⛔ 不作为 §2.8 M1 的判据量（bug 0120 待设计批准）"
        ),
    }
    return detail, warnings, summary


def _cv(values: list[float]):
    """变异系数 CV = 总体标准差 / 均值（ddof=0）。

    §2.2 的『帧内行距变异系数 ≤1%』用它；这里固定总体标准差，
    避免样本量小时 ddof=1 把 CV 放大。样本不足 2 个时返回 None。
    """
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    if mean == 0:
        return None
    var = sum((v - mean) ** 2 for v in values) / len(values)
    return math.sqrt(var) / mean


def _parse_b_range(text: str) -> tuple[int, int]:
    m = re.fullmatch(r"\s*(\d+)\s*:\s*(\d+)\s*", text)
    if not m:
        raise ValueError("--b-range 需要 A:B（左闭右开，单位是带下标）")
    a, b = int(m.group(1)), int(m.group(2))
    if a >= b:
        raise ValueError("--b-range 需要 A < B")
    return a, b


def split_body_runs(
    bands: list[dict],
    min_lines: int = DEFAULT_BODY_RUN_MIN_LINES,
    gap_factor: float = DEFAULT_BODY_RUN_GAP_FACTOR,
):
    """把相邻带按「正文行段」切段，供 `B` 的抽取（§2.2 / L1538-1540）。

    规则（确定性、可复跑）：
      1. 取全部相邻带中心差；
      2. 切段阈值 = `max(median(正间距) × gap_factor, 1.0)` 设备 px；
      3. 相邻带间距 > 阈值处断开；每段记录行数与该段内的相邻中心差；
      4. `line_count >= min_lines`（默认 3）的段才是「连续 ≥3 行正文」。

    ⚠️ 这不是「视觉上认得出正文」的分类器：标题/代码块/列表只要彼此间距落在
    同一段内，仍会随段进入样本。它只保证**段间距（空档）不进入 `B`**，
    这正是 bug 0148 的根因。段的元数据一并输出，供评审复核。
    """
    pitches = [
        bands[i + 1]["center"] - bands[i]["center"] for i in range(len(bands) - 1)
    ]
    positive = [p for p in pitches if p > 0]
    base = float(median(positive)) if positive else 0.0
    threshold = max(base * gap_factor, 1.0) if base else 1.0

    groups: list[list[int]] = []
    current = [0] if bands else []
    for i, gap in enumerate(pitches):
        if gap > threshold:
            groups.append(current)
            current = [i + 1]
        else:
            current.append(i + 1)
    if current:
        groups.append(current)

    runs = []
    for group in groups:
        run_pitches = [
            bands[i + 1]["center"] - bands[i]["center"] for i in group[:-1]
        ]
        rights = [bands[i].get("right") for i in group if bands[i].get("right") is not None]
        runs.append(
            {
                "start_band": group[0],
                "end_band": group[-1],
                "line_count": len(group),
                "pitches": [round(p, 6) for p in run_pitches],
                "center_first_px": round(bands[group[0]]["center"], 6),
                "center_last_px": round(bands[group[-1]]["center"], 6),
                # 同段各带右缘极差 = 该段的像素 RAG（bug 0138：像素派生量）
                "rag_px": (
                    round(max(rights) - min(rights), 6) if len(rights) >= 2 else None
                ),
            }
        )
    rule = {
        "rule": "相邻带中心差 > max(median(正间距) × gap_factor, 1 px) 处切段；"
                "line_count >= min_lines 的段才算「连续正文行」",
        "gap_factor": gap_factor,
        "threshold_px": round(threshold, 6),
        "base_pitch_px": round(base, 6) if base else None,
    }
    return runs, pitches, rule


def compute_pitch(
    bands: list[dict],
    b_range: tuple[int, int] | None,
    min_lines: int = DEFAULT_BODY_RUN_MIN_LINES,
    gap_factor: float = DEFAULT_BODY_RUN_GAP_FACTOR,
) -> dict:
    """§2.2：`B` = 「连续 ≥3 行正文」子集的相邻带中心差中位数（bug 0148）。

    产物同时保留：
      · `B`：设计口径（只取 body_runs 内的间距）；
      · `B_all_bands`：旧实现的「全部相邻带中位数」，仅供审计与前后对照，⛔ 不再作为 `B`；
      · `body_runs` / `pitches_body` / `n_body_pitch` / `n_body_runs`：`B` 的样本与来源；
      · `spacing_cv_body`：像素域的帧内行距 CV（bug 0127 的量具真值；阈值判定不在本文件）；
      · `cv` / `cv_percent`：旧口径（含段间距），保留给 N7 等既有调用方。
    """
    if b_range is None:
        selected = bands
    else:
        a, b = b_range
        if b < 0 or a < 0 or b > len(bands):
            raise ValueError(
                f"--b-range {a}:{b} 越界（当轮共 {len(bands)} 条带）"
            )
        selected = bands[a:b]

    runs, pitches, rule = split_body_runs(selected, min_lines, gap_factor)
    body_runs = [r for r in runs if r["line_count"] >= min_lines]
    body_pitches = [p for r in body_runs for p in r["pitches"]]

    heights = [float(b["height"]) for b in selected]
    cv_all = _cv(pitches)
    cv_body = _cv(body_pitches)
    body_mean = (sum(body_pitches) / len(body_pitches)) if body_pitches else None

    return {
        # ── 设计口径 ──────────────────────────────────────────────────
        "B": _median_or_none(body_pitches),
        "B_source": "body_runs_median" if body_pitches else "unavailable",
        "n_body_pitch": len(body_pitches),
        "n_body_runs": len(body_runs),
        "pitches_body": [round(p, 6) for p in body_pitches],
        "body_runs": body_runs,
        "body_run_rule": rule,
        # ── 旧口径（审计/对照；⛔ 不是 B）──────────────────────────────
        "B_all_bands": _median_or_none(pitches),
        "n_pitch": len(pitches),
        "pitches": [round(p, 6) for p in pitches],
        "spread": (max(pitches) - min(pitches)) if pitches else None,
        "cv": cv_all,
        "cv_percent": (cv_all * 100.0) if cv_all is not None else None,
        # ── 像素域帧内行距 CV（bug 0127 的量具真值）────────────────────
        "spacing_cv_body": cv_body,
        "spacing_cv_body_percent": (cv_body * 100.0) if cv_body is not None else None,
        "pitch_resolution_px": 1.0,
        "quantization_floor_percent": (
            round(100.0 / body_mean, 6) if body_mean else None
        ),
        "band_height": {
            "median": _median_or_none(heights),
            "min": min(heights) if heights else None,
            "max": max(heights) if heights else None,
            "n": len(heights),
        },
        "b_range": list(b_range) if b_range is not None else None,
    }


# ---------------------------------------------------------------------------
# 5. M2：垂直投影 / 列边界
# ---------------------------------------------------------------------------

def column_profile(
    image: Image, rect: Rect, top: int, bottom_exclusive: int, bg, threshold: int
) -> list[int]:
    """逐列统计 [top,bottom_exclusive) 行内的墨迹像素数。"""
    counts = [0] * rect.width
    bgr, bgg, bgb = bg

    for y in range(top, bottom_exclusive):
        base = y * image.width * 3
        for cidx, x in enumerate(range(rect.left, rect.right)):
            i = base + x * 3
            d = abs(image.rgb[i] - bgr)
            d2 = abs(image.rgb[i + 1] - bgg)
            if d2 > d:
                d = d2
            d3 = abs(image.rgb[i + 2] - bgb)
            if d3 > d:
                d = d3
            if d >= threshold:
                counts[cidx] += 1
    return counts


def split_columns(
    image: Image,
    rect: Rect,
    top: int,
    bottom_exclusive: int,
    bg,
    threshold: int,
    min_gap_cols: int = DEFAULT_MIN_GAP_COLS,
) -> dict:
    """M2：在水平切片内找列间隙、边界与每列文字盒。"""
    counts = column_profile(image, rect, top, bottom_exclusive, bg, threshold)

    # 找连续零墨迹列；只有两侧都有墨迹的间隙才算列边界（忽略页边空白）。
    gaps: list[dict] = []
    seen_ink = False
    x = 0
    while x < rect.width:
        if counts[x] == 0:
            start = x
            while x < rect.width and counts[x] == 0:
                x += 1
            end = x  # 半开 [start,end)
            has_ink_after = any(c > 0 for c in counts[end:])
            if seen_ink and has_ink_after and (end - start) >= min_gap_cols:
                gaps.append(
                    {
                        "left": rect.left + start,
                        "right_exclusive": rect.left + end,
                        "width": end - start,
                        # 间隙中点 = 两条相邻列的分界；用连续坐标，保留 .5
                        "midpoint": (rect.left + start + rect.left + end) / 2.0,
                    }
                )
        else:
            seen_ink = True
            x += 1

    boundaries = [g["midpoint"] for g in gaps]

    # 列的像素区间：第一列从 rect.left 起，最后一列到 rect.right 止；
    # 中间用 ceil(boundary) 切分，保证整数列不重不漏。
    edges: list[float] = [float(rect.left)] + boundaries + [float(rect.right)]
    columns: list[dict] = []
    for i in range(len(edges) - 1):
        seg_left_f = edges[i]
        seg_right_f = edges[i + 1]
        seg_left = rect.left if i == 0 else int(math.ceil(seg_left_f))
        seg_right = rect.right if i == len(edges) - 2 else int(math.ceil(seg_right_f))
        seg_width = seg_right_f - seg_left_f

        text_left = -1
        text_right = -1
        ink = 0
        for y in range(top, bottom_exclusive):
            base = y * image.width * 3
            for xx in range(seg_left, seg_right):
                j = base + xx * 3
                d = abs(image.rgb[j] - bg[0])
                d2 = abs(image.rgb[j + 1] - bg[1])
                if d2 > d:
                    d = d2
                d3 = abs(image.rgb[j + 2] - bg[2])
                if d3 > d:
                    d = d3
                if d >= threshold:
                    ink += 1
                    if text_left < 0 or xx < text_left:
                        text_left = xx
                    if xx > text_right:
                        text_right = xx

        text_width = (text_right - text_left + 1) if text_left >= 0 else 0
        columns.append(
            {
                "index": i,
                "left": seg_left_f,
                "right_exclusive": seg_right_f,
                "width": round(seg_width, 6),
                "width_ratio": round(seg_width / rect.width, 9) if rect.width else None,
                "text_left": text_left if text_left >= 0 else None,
                "text_right": text_right if text_right >= 0 else None,
                "text_width": text_width,
                "text_width_ratio": (
                    round(text_width / rect.width, 9) if rect.width else None
                ),
                "ink": ink,
            }
        )

    return {
        "slice": {"top": top, "bottom_exclusive": bottom_exclusive},
        "column_count": len(columns),
        "gaps": gaps,
        "boundaries": boundaries,
        "columns": columns,
        "profile_min": min(counts) if counts else None,
        "profile_max": max(counts) if counts else None,
    }


# ---------------------------------------------------------------------------
# 6. M3：二维连通域 / 列表标记分割
# ---------------------------------------------------------------------------

def connected_components(
    image: Image,
    left: int,
    right: int,
    top: int,
    bottom_exclusive: int,
    bg,
    threshold: int,
    min_area: int = DEFAULT_MIN_AREA,
) -> list[dict]:
    """8 连通域。窗口是 [left,right) x [top,bottom_exclusive)。

    solidity = area / bbox 面积；方框判据由调用方按 §2.8 M3 自行组合
    （solidity >= 0.85 且宽高比 0.9–1.1）。
    """
    w = right - left
    h = bottom_exclusive - top
    if w <= 0 or h <= 0:
        return []

    # 先把窗口二值化，再做 8 连通 BFS。
    grid = bytearray(w * h)
    for yy in range(h):
        base = (top + yy) * image.width * 3
        for xx in range(w):
            i = base + (left + xx) * 3
            d = abs(image.rgb[i] - bg[0])
            d2 = abs(image.rgb[i + 1] - bg[1])
            if d2 > d:
                d = d2
            d3 = abs(image.rgb[i + 2] - bg[2])
            if d3 > d:
                d = d3
            if d >= threshold:
                grid[yy * w + xx] = 1

    visited = bytearray(w * h)
    components: list[dict] = []

    for start in range(w * h):
        if not grid[start] or visited[start]:
            continue
        visited[start] = 1
        stack = [start]
        area = 0
        minx = w
        maxx = -1
        miny = h
        maxy = -1

        while stack:
            idx = stack.pop()
            cy, cx = divmod(idx, w)
            area += 1
            if cx < minx:
                minx = cx
            if cx > maxx:
                maxx = cx
            if cy < miny:
                miny = cy
            if cy > maxy:
                maxy = cy

            y_lo = cy - 1 if cy > 0 else 0
            y_hi = cy + 1 if cy + 1 < h else cy
            x_lo = cx - 1 if cx > 0 else 0
            x_hi = cx + 1 if cx + 1 < w else cx
            for ny in range(y_lo, y_hi + 1):
                row_base = ny * w
                for nx in range(x_lo, x_hi + 1):
                    nidx = row_base + nx
                    if grid[nidx] and not visited[nidx]:
                        visited[nidx] = 1
                        stack.append(nidx)

        if area < min_area:
            continue

        bbox_w = maxx - minx + 1
        bbox_h = maxy - miny + 1
        components.append(
            {
                "left": left + minx,
                "top": top + miny,
                "right": left + maxx,  # 闭区间
                "bottom": top + maxy,  # 闭区间
                "width": bbox_w,
                "height": bbox_h,
                "area": area,
                "bbox_area": bbox_w * bbox_h,
                "solidity": round(area / (bbox_w * bbox_h), 6),
                "aspect": round(bbox_w / bbox_h, 6) if bbox_h else None,
                "is_square": (
                    (area / (bbox_w * bbox_h)) >= 0.85
                    and bbox_h > 0
                    and 0.9 <= (bbox_w / bbox_h) <= 1.1
                ),
            }
        )

    components.sort(key=lambda c: (c["left"], c["top"]))
    return components


def marker_layers(
    image: Image,
    row_top: int,
    row_bottom_exclusive: int,
    x0: float,
    layer_lefts: list[float] | None,
    scan_width: float,
    bg,
    threshold: int,
    min_area: int,
) -> dict:
    """M3：逐层在 [layer_left, layer_left+scan_width) 内找标记区。

    scan_width 由调用方按 3em（设备 px）或显式 --scan-width 给出；
    ⛔ 本函数不按字号猜测 em。
    """
    layers = layer_lefts if layer_lefts else [x0]
    results = []
    warnings: list[str] = []

    for li, layer_left in enumerate(layers):
        win_left = int(math.floor(layer_left))
        win_right = int(math.ceil(layer_left + scan_width))
        clipped_left = max(0, win_left)
        clipped_right = min(image.width, win_right)
        if clipped_left >= clipped_right:
            results.append(
                {
                    "layer_index": li,
                    "layer_left": layer_left,
                    "window": {"left": win_left, "right": win_right},
                    "components": [],
                    "marker": None,
                    "first_text": None,
                    "marker_ink_extent": None,
                }
            )
            warnings.append(f"第 {li} 层扫描窗 [{win_left},{win_right}) 完全在图像外")
            continue

        if (clipped_left, clipped_right) != (win_left, win_right):
            warnings.append(
                f"第 {li} 层扫描窗 [{win_left},{win_right}) 超出图像，"
                f"已裁到 [{clipped_left},{clipped_right})"
            )

        comps = connected_components(
            image,
            clipped_left,
            clipped_right,
            row_top,
            row_bottom_exclusive,
            bg,
            threshold,
            min_area,
        )
        marker = comps[0] if comps else None
        first_text = comps[1] if len(comps) > 1 else None
        results.append(
            {
                "layer_index": li,
                "layer_left": layer_left,
                "window": {
                    "left": clipped_left,
                    "right": clipped_right,
                    "top": row_top,
                    "bottom_exclusive": row_bottom_exclusive,
                },
                "components": comps,
                "marker": marker,
                "first_text": first_text,
                # 『标记区墨迹范围』就是最左连通域的 bbox（闭区间）
                "marker_ink_extent": (
                    {
                        "left": marker["left"],
                        "top": marker["top"],
                        "right": marker["right"],
                        "bottom": marker["bottom"],
                        "width": marker["width"],
                        "height": marker["height"],
                        "ink": marker["area"],
                    }
                    if marker
                    else None
                ),
            }
        )

    return {"layers": results, "warnings": warnings}


# ---------------------------------------------------------------------------
# 7. M4：颜色取样
# ---------------------------------------------------------------------------

def _iter_rect_pixels(image: Image, rect: Rect):
    for y in range(rect.top, rect.bottom):
        base = y * image.width * 3
        for x in range(rect.left, rect.right):
            i = base + x * 3
            yield image.rgb[i], image.rgb[i + 1], image.rgb[i + 2]


def sample_mode_color(image: Image, rect: Rect, threshold: int, erode: int):
    """M4：向内腐蚀 erode px，排除墨迹后取众数色（背景填充）。

    做法（确定性）：
      1. 先对取样区整体取众数；
      2. 把与当前众数色差 >= threshold 的像素视为墨迹剔除，重新取众数；
      3. 最多迭代 4 轮，众数稳定即停。
    这样既不依赖页面背景色（代码块/表头底色本身可能不是白），
    也不会让少量文字像素把填充色挤掉。
    """
    eroded = False
    inner = rect
    erode_reason = None
    if erode > 0:
        if rect.width > 2 * erode and rect.height > 2 * erode:
            inner = Rect(
                rect.left + erode,
                rect.top + erode,
                rect.right - erode,
                rect.bottom - erode,
            )
            eroded = True
        else:
            # bug 0164：窄目标（1 px 线、3.5 px 引用条）无法腐蚀时必须留下原因，
            # 不能只写 `eroded: false` 让报告读起来和「正常腐蚀过」一样。
            erode_reason = (
                "取样区 %dx%d 不大于 2×erode(%d)：%dx%d"
                % (rect.width, rect.height, erode, 2 * erode, 2 * erode)
            )

    counts: Counter = Counter()
    total = 0
    for color in _iter_rect_pixels(image, inner):
        counts[color] += 1
        total += 1
    if total == 0:
        raise ValueError("取样区为空")

    mode, _ = mode_rgb(counts)
    current = counts
    excluded_total = 0

    for _ in range(4):
        kept: Counter = Counter()
        excluded = 0
        for color, n in current.items():
            if _max_channel_diff(color, mode) >= threshold:
                excluded += n
            else:
                kept[color] = n
        if not kept:
            break
        new_mode, _ = mode_rgb(kept)
        excluded_total += excluded
        current = kept
        if new_mode == mode:
            break
        mode = new_mode

    kept_total = sum(current.values())
    mode_count = current.get(mode, 0)
    return {
        "color": mode,
        "method": "mode",
        "eroded": eroded,
        "erode": erode,
        "erode_reason": erode_reason,
        "sample_rect": inner.to_dict(),
        "pixels_total": total,
        "pixels_kept": kept_total,
        "pixels_excluded": excluded_total,
        "mode_count": mode_count,
        "coverage": (mode_count / kept_total) if kept_total else None,
        "distinct_kept_colors": len(current),
        "warnings": (
            [{
                "code": "erode-skipped",
                "reason": "bbox<=2*erode",
                "detail": erode_reason,
                "rect": rect.to_dict(),
                "erode": erode,
            }]
            if erode_reason
            else []
        ),
    }


def sample_line_median(image: Image, rect: Rect):
    """M4：沿 1 px 线取逐通道中位色（不做腐蚀、不排除墨迹）。"""
    rs: list[int] = []
    gs: list[int] = []
    bs: list[int] = []
    for r, g, b in _iter_rect_pixels(image, rect):
        rs.append(r)
        gs.append(g)
        bs.append(b)
    if not rs:
        raise ValueError("取样线为空")

    def med(vals: list[int]) -> int:
        # statistics.median 在偶数个样本时返回两数均值；四舍五入成 8-bit 整数
        return int(math.floor(median(vals) + 0.5))

    return {
        "color": (med(rs), med(gs), med(bs)),
        "method": "median_line",
        "eroded": False,
        "erode": 0,
        "erode_reason": None,
        "sample_rect": rect.to_dict(),
        "pixels_total": len(rs),
        "pixels_kept": len(rs),
        "pixels_excluded": 0,
        "mode_count": len(rs),
        "coverage": 1.0,
        "distinct_kept_colors": None,
        "warnings": [],
    }


def _parse_rect_arg(text: str) -> Rect:
    parts = [p for p in re.split(r"[,\s]+", text.strip()) if p]
    if len(parts) != 4:
        raise ValueError("--sample-color 需要 X0,Y0,X1,Y1（半开区间）")
    try:
        x0, y0, x1, y1 = (int(math.floor(float(p) + 0.5)) for p in parts)
    except ValueError as exc:
        raise ValueError(f"--sample-color 不是四个整数：{text!r}") from exc
    if x0 >= x1 or y0 >= y1:
        raise ValueError("--sample-color 要求 X0 < X1 且 Y0 < Y1")
    return Rect(x0, y0, x1, y1)


# ---------------------------------------------------------------------------
# 8. 结果组装与 CLI
# ---------------------------------------------------------------------------

def _image_meta(path: str, image: Image) -> dict:
    with open(path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    return {
        "path": path,
        "sha256": sha,
        "width": image.width,
        "height": image.height,
    }


def _roi_meta(roi: dict | None) -> dict | None:
    if roi is None:
        return None
    rect: Rect = roi["rect"]
    return {
        "rect": rect.to_dict(),
        "source": roi["source"],
        "raw": roi["raw"],
        "clipped": roi["clipped"],
        "padding_left": roi.get("padding_left"),
        "padding_right": roi.get("padding_right"),
        "border_box_present": roi.get("border_box_present", False),
        "dpr": roi.get("dpr"),
        "note": "content box：left/right 已含 padding，⛔ 不再按 border box 处理",
    }


def _background_meta(bg, n, total, source) -> dict:
    return {
        "rgb": [bg[0], bg[1], bg[2]],
        "hex": rgb_hex(bg),
        "source": source,
        "mode_count": n,
        "frame_pixels": total,
    }


def _resolve_rows(args, bands: list[dict], rect: Rect) -> tuple[int, int, dict]:
    """把 --band / --slice 解析成半开行区间 [top, bottom_exclusive)。"""
    if args.band is not None and args.slice is not None:
        raise ValueError("--band 与 --slice 只能给一个")
    if args.band is not None:
        if args.band < 0 or args.band >= len(bands):
            raise ValueError(
                f"--band {args.band} 越界（当轮共 {len(bands)} 条带）"
            )
        band = bands[args.band]
        return band["top"], band["bottom"] + 1, {
            "band": args.band,
            "top": band["top"],
            "bottom_exclusive": band["bottom"] + 1,
        }
    if args.slice is not None:
        m = re.fullmatch(r"\s*(\d+)\s*:\s*(\d+)\s*", args.slice)
        if not m:
            raise ValueError("--slice 需要 TOP:BOTTOM（半开区间）")
        top, bottom = int(m.group(1)), int(m.group(2))
        if top >= bottom:
            raise ValueError("--slice 需要 TOP < BOTTOM")
        if top < rect.top or bottom > rect.bottom:
            raise ValueError(
                f"--slice [{top},{bottom}) 超出 ROI 行范围 "
                f"[{rect.top},{rect.bottom})"
            )
        return top, bottom, {"band": None, "top": top, "bottom_exclusive": bottom}
    return rect.top, rect.bottom, {"band": None, "top": rect.top, "bottom_exclusive": rect.bottom}


def run_m1(args, image: Image, roi: dict) -> dict:
    rect: Rect = roi["rect"]
    if args.bg is not None:
        bg = parse_color(args.bg)
        bg_n, bg_total, bg_source = None, None, "explicit"
    else:
        bg, bg_n, bg_total, bg_source = estimate_background(image, rect)

    row_count, row_min, row_max = _row_ink_profile(image, rect, bg, args.threshold)
    bands = detect_bands(
        rect,
        row_count,
        row_min,
        row_max,
        min_row_ink=args.min_row_ink,
        max_gap=args.max_gap,
        min_band_height=args.min_band_height,
    )

    b_range = _parse_b_range(args.b_range) if args.b_range else None
    pitch = compute_pitch(
        bands,
        b_range,
        min_lines=args.body_run_min_lines,
        gap_factor=args.body_run_gap_factor,
    )

    # bug 0120：装饰墨迹诊断（⛔ 不改 bands/pitch 主口径）
    decoration_detail, decoration_warnings, decoration_summary = analyze_decorations(
        image,
        rect,
        bands,
        row_count,
        bg,
        args.threshold,
        min_row_ink=args.min_row_ink,
        max_gap=args.max_gap,
        min_band_height=args.min_band_height,
    )
    for band in bands:
        if band["index"] in decoration_detail:
            band["decoration"] = decoration_detail[band["index"]]

    # bug 0137 / 0163：相邻带之间的实际空隙（像素量），供 SP_head/SP_after/SP_para 等
    # 由「DOM margin」切换到「带间实测」；只给原始量，映射到具体判据由消费侧完成。
    # `gap_px` = 空白高；`pitch_px` = 相邻带中心差（= 本对带的实测行距），
    # ⛔ 原名 `center_px` 易被误读为坐标，2026-11-08 改名（该字段无既存消费者）。
    gaps = [
        {
            "after_band": bands[i]["index"],
            "before_band": bands[i + 1]["index"],
            "gap_px": bands[i + 1]["top"] - bands[i]["bottom"] - 1,
            "pitch_px": round(bands[i + 1]["center"] - bands[i]["center"], 6),
        }
        for i in range(len(bands) - 1)
    ]

    B = pitch.get("B")
    band_h = pitch.get("band_height") or {}
    BAND = band_h.get("median")
    # bug 0138 / 0166：已经能从像素带拿到、只差上浮到 metrics 的量。
    derived = {
        "BAND_px": BAND,
        "BAND_over_B": (BAND / B) if (BAND is not None and B) else None,
        "roi_width_px": rect.width,
        "W_col_over_B": (rect.width / B) if (B and rect.width) else None,
        "source": {
            "BAND_px": "bands[].height 中位数（M1 像素带）",
            "BAND_over_B": "BAND_px / pitch.B",
            "roi_width_px": "roi.rect.width（content box 宽，设备 px）",
            "W_col_over_B": "roi_width_px / pitch.B",
        },
        "note": "登记族（BAND/B、W_col）即使不进 pass/fail 也可见；"
                "映射到 measured.metrics 由 l2-run 负责（契约见 .agent/l2-contract-requests.md）",
    }

    return {
        "tool": "bands.py",
        "mode": "M1",
        "spec": "docs/design/0063 §2.8 M1 / §1.3 / §2.2 B",
        "png": _image_meta(args.png, image),
        "roi": _roi_meta(roi),
        "threshold": args.threshold,
        "rules": {
            "min_row_ink": args.min_row_ink,
            "max_gap": args.max_gap,
            "min_band_height": args.min_band_height,
            "body_run_min_lines": args.body_run_min_lines,
            "body_run_gap_factor": args.body_run_gap_factor,
        },
        "background": _background_meta(bg, bg_n, bg_total, bg_source),
        "band_count": len(bands),
        "bands": bands,
        "pitch": pitch,
        "gaps": gaps,
        "derived": derived,
        "decorations": decoration_summary,
        "warnings": list(roi["warnings"]) + decoration_warnings,
    }


def run_m2(args, image: Image, roi: dict, bands: list[dict]) -> dict:
    rect: Rect = roi["rect"]
    if args.band is None and args.slice is None:
        raise ValueError("M2 需要 --band N 或 --slice TOP:BOTTOM 指定水平切片")

    top, bottom_exclusive, rows_meta = _resolve_rows(args, bands, rect)

    if args.bg is not None:
        bg = parse_color(args.bg)
        bg_n, bg_total, bg_source = None, None, "explicit"
    else:
        bg, bg_n, bg_total, bg_source = estimate_background(image, rect)

    split = split_columns(
        image,
        rect,
        top,
        bottom_exclusive,
        bg,
        args.threshold,
        min_gap_cols=args.min_gap_cols,
    )

    return {
        "tool": "bands.py",
        "mode": "M2",
        "spec": "docs/design/0063 §2.8 M2",
        "png": _image_meta(args.png, image),
        "roi": _roi_meta(roi),
        "threshold": args.threshold,
        "min_gap_cols": args.min_gap_cols,
        "background": _background_meta(bg, bg_n, bg_total, bg_source),
        "rows": rows_meta,
        **split,
        "warnings": list(roi["warnings"]),
    }


def _flatten_layer_lefts(values) -> list[float] | None:
    if not values:
        return None
    out: list[float] = []
    for value in values:
        for part in str(value).replace("，", ",").split(","):
            part = part.strip()
            if part:
                out.append(float(part))
    return out


def run_m3(args, image: Image, roi: dict, bands: list[dict]) -> dict:
    rect: Rect = roi["rect"]

    if args.x0 is None:
        raise ValueError("M3 需要 --x0（该层 li 的 getBoundingClientRect().left）")
    if args.scan_width is not None:
        scan_width = float(args.scan_width)
    elif args.em is not None:
        scan_width = 3.0 * float(args.em)  # §2.8：扫描带 = 3em
    else:
        raise ValueError(
            "M3 需要 --em（每 em 的设备像素数，扫描带 = 3em）"
            "或 --scan-width（直接给扫描窗宽，px）；不按字号猜 em"
        )
    if scan_width <= 0:
        raise ValueError("--em / --scan-width 必须为正数")

    top, bottom_exclusive, rows_meta = _resolve_rows(args, bands, rect)

    if args.bg is not None:
        bg = parse_color(args.bg)
        bg_n, bg_total, bg_source = None, None, "explicit"
    else:
        bg, bg_n, bg_total, bg_source = estimate_background(image, rect)

    layer_lefts = _flatten_layer_lefts(args.layer_left)
    marker = marker_layers(
        image,
        top,
        bottom_exclusive,
        float(args.x0),
        layer_lefts,
        scan_width,
        bg,
        args.threshold,
        args.min_area,
    )

    return {
        "tool": "bands.py",
        "mode": "M3",
        "spec": "docs/design/0063 §2.8 M3",
        "png": _image_meta(args.png, image),
        "roi": _roi_meta(roi),
        "threshold": args.threshold,
        "min_area": args.min_area,
        "em": args.em,
        "scan_width": scan_width,
        "x0": float(args.x0),
        "layer_left": layer_lefts if layer_lefts is not None else [float(args.x0)],
        "background": _background_meta(bg, bg_n, bg_total, bg_source),
        "rows": rows_meta,
        **marker,
        # marker_layers 自己也可能报「扫描窗被裁」等警告；与 ROI 警告合并，
        # 不能因为字典里后写的 warnings 把前者覆盖掉。
        "warnings": list(roi["warnings"]) + list(marker.get("warnings", [])),
    }


def classify_sample_geometry(rect: Rect, dpr=None) -> tuple[str, int]:
    """§2.3 T4：按**被测对象**的几何形态判定容差档（bug 0164）。

    返回 (geometry, line_max_device_px)：
      · `1px_line`     —— 短边 ≤ 1 CSS px（= DPR 设备 px）⇒ ΔE ≤ 8
      · `area_ge_3x3`  —— 宽高都 ≥ 3 设备 px ⇒ ΔE ≤ 3
      · `too_small`    —— 既不是 1 px 线、也不到 3×3；设计未定义，⛔ 不猜容差
    """
    ratio = 1.0
    if isinstance(dpr, (int, float)) and not isinstance(dpr, bool) and dpr > 0:
        ratio = float(dpr)
    line_max = max(1, int(round(ratio)))
    short = min(rect.width, rect.height)
    if short <= line_max:
        return "1px_line", line_max
    if rect.width >= 3 and rect.height >= 3:
        return "area_ge_3x3", line_max
    return "too_small", line_max


def run_m4(args, image: Image, roi: dict | None) -> dict:
    rect = _parse_rect_arg(args.sample_color)
    # 允许取样区超出图像时明确报错，避免静默裁切导致颜色统计口径变化
    if (
        rect.left < 0
        or rect.top < 0
        or rect.right > image.width
        or rect.bottom > image.height
    ):
        raise ValueError(
            f"--sample-color [{rect.left},{rect.right}) x [{rect.top},{rect.bottom}) "
            f"超出图像 {image.width}x{image.height}"
        )

    dpr = (roi or {}).get("dpr")
    geometry, line_max = classify_sample_geometry(rect, dpr)
    warnings: list[dict] = []

    # 1 px 线用「沿中线取逐通道中位色」；面积样本用「腐蚀后取众数色」。
    # `--line` 仍可强制取样算法，但**容差只由几何决定**（bug 0164）。
    use_line = bool(args.line) or geometry == "1px_line"
    if use_line:
        sampled = sample_line_median(image, rect)
    else:
        sampled = sample_mode_color(image, rect, args.threshold, args.erode)
    sampled_warnings = sampled.pop("warnings", [])
    warnings.extend(sampled_warnings)

    if args.line and geometry != "1px_line":
        warnings.append({
            "code": "line-flag-not-tolerance",
            "reason": "explicit --line 只影响取样算法，不参与容差选择",
            "geometry": geometry,
            "rect": rect.to_dict(),
        })

    if args.de_tol is not None:
        default_tol = args.de_tol
        tolerance_source = "explicit"
    elif geometry == "1px_line":
        default_tol = DEFAULT_DE_TOL_LINE
        tolerance_source = "geometry:1px_line"
    elif geometry == "area_ge_3x3":
        default_tol = DEFAULT_DE_TOL_AREA
        tolerance_source = "geometry:area_ge_3x3"
    else:
        default_tol = None
        tolerance_source = "geometry:too_small"
        warnings.append({
            "code": "sample-too-small",
            "reason": "短边 > 1 CSS px 且尺寸 < 3x3；设计未定义容差，⛔ 不猜",
            "geometry": geometry,
            "rect": rect.to_dict(),
        })

    ref = parse_color(args.ref)
    lab_sample = rgb_to_lab(sampled["color"])
    lab_ref = rgb_to_lab(ref)
    de = delta_e_2000_lab(lab_sample, lab_ref)
    tol = args.de_tol if args.de_tol is not None else default_tol

    sample_color = sampled.pop("color")
    sample_rect = sampled.pop("sample_rect")
    roi_warnings = list(roi["warnings"]) if roi else []
    return {
        "tool": "bands.py",
        "mode": "M4",
        "spec": "docs/design/0063 §2.8 M4 / §2.3 T4",
        "png": _image_meta(args.png, image),
        "roi": _roi_meta(roi),
        "threshold": args.threshold,
        "sample": {
            **sampled,
            "rect": sample_rect,
            "color": list(sample_color),
            "hex": rgb_hex(sample_color),
            "lab": [round(v, 6) for v in lab_sample],
            "geometry": geometry,
            "line_max_device_px": line_max,
            "dpr": dpr,
        },
        "reference": {
            "rgb": list(ref),
            "hex": rgb_hex(ref),
            "lab": [round(v, 6) for v in lab_ref],
            "tolerance": tol,
            "tolerance_source": tolerance_source,
        },
        "delta_e_2000": round(de, 6),
        "pass": (de <= tol) if tol is not None else None,
        # 字符串警告与结构化 warning 并列：既有消费方读 `warnings`（字符串），
        # 新的容差/腐蚀问题用 `warning_details` 结构化输出，二者不互相覆盖。
        "warnings": roi_warnings + [
            w.get("reason", w.get("code", "warning")) for w in warnings
        ],
        "warning_details": warnings,
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Mardo 端侧对照测试的像素度量（M1 行带 / M2 列边界 / M3 连通域标记 / "
            "M4 颜色）。口径见 docs/design/0063 §2.8。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    p.add_argument("--png", required=True, help="输入 PNG（8-bit、非隔行）")
    p.add_argument(
        "--roi",
        help=(
            "roi.json；必须是 `.doc` 的 content box（left/right 已含 padding）。"
            "M4 可省略。"
        ),
    )
    p.add_argument("--json", dest="json_out", help="把结果 JSON 另写到该路径")

    p.add_argument(
        "--bg",
        help="覆盖背景色（#rrggbb 或 r,g,b）；默认取 ROI 外框 10 px 的众数色",
    )
    p.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD,
        help=f"墨迹阈值 0–255（默认 {DEFAULT_THRESHOLD}，§2.8 M1）",
    )
    p.add_argument(
        "--min-row-ink",
        type=int,
        default=DEFAULT_MIN_ROW_INK,
        help=f"一行至少多少墨迹像素才算墨迹行（默认 {DEFAULT_MIN_ROW_INK}）",
    )
    p.add_argument(
        "--max-gap",
        type=int,
        default=DEFAULT_MAX_GAP,
        help=f"相邻墨迹行间隔 <= 该值则合并（默认 {DEFAULT_MAX_GAP} px）",
    )
    p.add_argument(
        "--min-band-height",
        type=int,
        default=DEFAULT_MIN_BAND_HEIGHT,
        help=f"带高低于该值丢弃（默认 {DEFAULT_MIN_BAND_HEIGHT} px）",
    )
    p.add_argument(
        "--b-range",
        help=(
            "只取带下标 A:B（左闭右开）参与 B 计算；默认在全部带里识别"
            "「连续 ≥3 行正文」后只用这段（§2.2 B 取法，bug 0148）"
        ),
    )
    p.add_argument(
        "--body-run-min-lines",
        type=int,
        default=DEFAULT_BODY_RUN_MIN_LINES,
        help=(
            "「连续 ≥3 行正文」的最少行数（默认 %d）；只有这段内的相邻带中心差进入 B"
            % DEFAULT_BODY_RUN_MIN_LINES
        ),
    )
    p.add_argument(
        "--body-run-gap-factor",
        type=float,
        default=DEFAULT_BODY_RUN_GAP_FACTOR,
        help=(
            "切段阈值系数：相邻带中心差 > 中位间距 × 该值处断开（默认 %.1f）"
            % DEFAULT_BODY_RUN_GAP_FACTOR
        ),
    )

    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--columns", action="store_true", help="执行 M2 列分割")
    mode.add_argument("--marker", action="store_true", help="执行 M3 标记分割")
    mode.add_argument(
        "--sample-color",
        metavar="X0,Y0,X1,Y1",
        help="执行 M4 颜色取样（半开区间）",
    )

    p.add_argument("--band", type=int, help="M2/M3 使用的带下标（0 起）")
    p.add_argument(
        "--slice",
        help="M2/M3 使用的行区间 TOP:BOTTOM（半开，PNG 像素坐标）",
    )
    p.add_argument("--min-gap-cols", type=int, default=DEFAULT_MIN_GAP_COLS,
                   help=f"M2 列间隙最少零墨迹列数（默认 {DEFAULT_MIN_GAP_COLS}）")

    p.add_argument("--x0", type=float, help="M3：该层 li 的局部左缘（设备 px）")
    p.add_argument(
        "--layer-left",
        nargs="+",
        help="M3：各层 li 左缘列表，逗号或空格分隔（设备 px）",
    )
    p.add_argument("--em", type=float, help="M3：1 em 的设备像素数；扫描带宽 = 3em")
    p.add_argument("--scan-width", type=float, help="M3：直接给扫描窗宽（设备 px）")
    p.add_argument("--min-area", type=int, default=DEFAULT_MIN_AREA,
                   help=f"M3 连通域最小面积（默认 {DEFAULT_MIN_AREA} px）")

    p.add_argument("--line", action="store_true",
                   help=(
                       "M4：强制按 1 px 线取逐通道中位色（不腐蚀、不排墨迹）。"
                       "⚠️ 只影响取样算法，**不参与容差选择**；容差按对象几何定"
                       "（bug 0164）"
                   ))
    p.add_argument("--ref", help="M4：参照色（#rrggbb 或 r,g,b），用于 ΔE2000")
    p.add_argument("--erode", type=int, default=DEFAULT_ERODE,
                   help=f"M4 取样区向内腐蚀像素数（默认 {DEFAULT_ERODE}）")
    p.add_argument(
        "--de-tol",
        type=float,
        help=(
            "M4：显式覆盖 ΔE2000 容差；默认按对象几何："
            "1 px 线（短边 ≤ 1 CSS px）8.0、面积 ≥3×3 为 3.0（§2.3 T4，bug 0164）"
        ),
    )

    return p


def _bands_for_args(args, image: Image, roi: dict) -> list[dict]:
    """按当前阈值/规则先跑一遍 M1，供 --columns/--marker 的 --band 选用。

    只在真的需要按带下标取行时才扫描；--slice 与默认全 ROI 不需要。
    """
    if args.band is None:
        return []
    rect: Rect = roi["rect"]
    if args.bg is not None:
        bg = parse_color(args.bg)
    else:
        bg = estimate_background(image, rect)[0]
    rc, rmn, rmx = _row_ink_profile(image, rect, bg, args.threshold)
    return detect_bands(
        rect,
        rc,
        rmn,
        rmx,
        min_row_ink=args.min_row_ink,
        max_gap=args.max_gap,
        min_band_height=args.min_band_height,
    )


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not (0 <= args.threshold <= 255):
        parser.error(f"--threshold 必须在 0–255，实际 {args.threshold}")
    if args.min_row_ink < 1:
        parser.error("--min-row-ink 必须 >= 1")
    if args.max_gap < 0:
        parser.error("--max-gap 必须 >= 0")
    if args.min_band_height < 1:
        parser.error("--min-band-height 必须 >= 1")
    if args.min_gap_cols < 1:
        parser.error("--min-gap-cols 必须 >= 1")
    if args.min_area < 1:
        parser.error("--min-area 必须 >= 1")
    if args.erode < 0:
        parser.error("--erode 必须 >= 0")
    if args.body_run_min_lines < 2:
        parser.error("--body-run-min-lines 必须 >= 2（1 行构不成相邻间距）")
    if not (args.body_run_gap_factor > 1.0):
        parser.error("--body-run-gap-factor 必须 > 1.0（否则会把同一段正文切断）")

    is_m4 = args.sample_color is not None
    if is_m4 and not args.ref:
        parser.error("M4 需要 --ref（参照色）才能算 ΔE2000")
    if not is_m4 and not args.roi:
        parser.error("M1/M2/M3 需要 --roi")
    if args.columns and args.band is None and args.slice is None:
        parser.error("--columns 需要 --band N 或 --slice TOP:BOTTOM")
    if args.marker and args.x0 is None:
        parser.error("--marker 需要 --x0")

    try:
        image = decode_png(args.png)
        roi = load_roi(args.roi, image) if args.roi else None

        if is_m4:
            result = run_m4(args, image, roi)
        elif args.marker:
            bands = _bands_for_args(args, image, roi)
            result = run_m3(args, image, roi, bands)
        elif args.columns:
            bands = _bands_for_args(args, image, roi)
            result = run_m2(args, image, roi, bands)
        else:
            assert roi is not None
            result = run_m1(args, image, roi)

        text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.json_out:
            with open(args.json_out, "w", encoding="utf-8") as f:
                f.write(text)
                f.write("\n")
        sys.stdout.write(text + "\n")
        return 0

    except (PngError, ValueError, OSError) as exc:
        sys.stderr.write(f"bands.py: error: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
