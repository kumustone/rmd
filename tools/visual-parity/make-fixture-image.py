#!/usr/bin/env python3
"""生成确定性图片夹具 pic.png，并把摘要/尺寸/生成参数落到清单。

图案（0063 §2.6 / §8.1）：
  64x64、RGB8、无 alpha 通道、纯白底 #ffffff，
  黑色 #000000 实心矩形从 (8,8) 到 (55,55)（48x48），四周各留 8 px 白边。

不依赖 Pillow / numpy：只用 zlib + struct 按 PNG 规范手写 IHDR / IDAT / IEND，
每行 filter type 0。同一 Python/zlib 版本下逐字节确定。

用法与退出码（bugs/0198）：
  make-fixture-image.py                       # 生成并核对清单
  make-fixture-image.py --out PATH            # 指定图片路径
  make-fixture-image.py --check               # 只核对，不写盘（消费侧入口）
  make-fixture-image.py --check --out PATH    # 核对指定图片
  make-fixture-image.py --force               # 摘要不符时允许重写图片与清单

  0 = 成功 / 核对一致
  1 = 写盘后回读或 PNG 自检失败
  2 = 参数错误
  3 = 摘要/尺寸不符，或图片缺失
  4 = 清单缺失/不可用（无法核对）

清单默认写入脚本同目录的 fixtures-media-expect.json（与 fixtures-expect.json 同级）。
⚠️ 清单按 basename 索引；`--check` 只比较「磁盘现有图片」与清单记录，
   不比较本次环境生成器的输出（zlib 版本不同不应误报已有夹具被改）。
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import zlib

WIDTH = 64
HEIGHT = 64
BLACK = (0x00, 0x00, 0x00)
WHITE = (0xFF, 0xFF, 0xFF)
RECT_X0, RECT_Y0, RECT_X1, RECT_Y1 = 8, 8, 55, 55  # 闭区间：48x48

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(SCRIPT_DIR, "fixtures", "pic.png")
DEFAULT_MANIFEST = os.path.join(SCRIPT_DIR, "fixtures-media-expect.json")
MANIFEST_SCHEMA = "l2-fixtures-media-expect/1"


class ManifestError(Exception):
    """清单缺失或结构不可用；调用方据此退 4（无法核对）。"""


def make_chunk(tag: bytes, body: bytes) -> bytes:
    """按 PNG 规范组装一个 chunk：长度 + 类型 + 数据 + CRC32(类型+数据)。"""
    return (
        struct.pack(">I", len(body))
        + tag
        + body
        + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    )


def build_png() -> bytes:
    raw = bytearray()
    for y in range(HEIGHT):
        raw.append(0)  # filter type 0 (None)
        for x in range(WIDTH):
            inside = RECT_X0 <= x <= RECT_X1 and RECT_Y0 <= y <= RECT_Y1
            raw.extend(BLACK if inside else WHITE)

    # IHDR: width, height, bit depth=8, color type=2 (truecolor RGB, no alpha),
    #       compression=0, filter=0, interlace=0
    ihdr = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)
    # level=9 固定，保证同一 zlib 版本下输出稳定。
    idat = zlib.compress(bytes(raw), 9)
    return (
        PNG_SIGNATURE
        + make_chunk(b"IHDR", ihdr)
        + make_chunk(b"IDAT", idat)
        + make_chunk(b"IEND", b"")
    )


def verify_png(data: bytes) -> dict:
    """自写解码回读：校验 chunk CRC、尺寸、色彩类型与逐像素图案。"""
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("PNG 签名不符")

    pos = len(PNG_SIGNATURE)
    ihdr = None
    idat = bytearray()
    tags = []

    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        crc = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])[0]
        if crc != (zlib.crc32(tag + body) & 0xFFFFFFFF):
            raise ValueError(f"chunk {tag!r} CRC 不符")
        tags.append(tag.decode("ascii"))
        if tag == b"IHDR":
            ihdr = body
        elif tag == b"IDAT":
            idat.extend(body)
        elif tag == b"IEND" and body:
            raise ValueError("IEND 不应带数据")
        pos += 12 + length

    if ihdr is None or len(ihdr) != 13:
        raise ValueError("缺少或非法的 IHDR")
    width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
        ">IIBBBBB", ihdr
    )
    if (width, height) != (WIDTH, HEIGHT):
        raise ValueError(f"尺寸不符: {width}x{height}")
    if bit_depth != 8 or color_type != 2:
        raise ValueError(f"色彩类型不符: bit_depth={bit_depth} color_type={color_type}")
    if compression != 0 or filter_method != 0 or interlace != 0:
        raise ValueError("压缩/过滤/隔行方式不符")

    raw = zlib.decompress(bytes(idat))
    stride = 1 + WIDTH * 3
    if len(raw) != stride * HEIGHT:
        raise ValueError(f"IDAT 解压长度不符: {len(raw)} != {stride * HEIGHT}")

    white = black = 0
    black_xs = []
    black_ys = []
    for y in range(HEIGHT):
        row = raw[y * stride:(y + 1) * stride]
        if row[0] != 0:
            raise ValueError(f"第 {y} 行 filter type 非 0: {row[0]}")
        for x in range(WIDTH):
            px = tuple(row[1 + x * 3:1 + x * 3 + 3])
            expected = BLACK if (RECT_X0 <= x <= RECT_X1 and RECT_Y0 <= y <= RECT_Y1) else WHITE
            if px != expected:
                raise ValueError(f"像素 ({x},{y}) 期望 {expected} 实得 {px}")
            if px == BLACK:
                black += 1
                black_xs.append(x)
                black_ys.append(y)
            else:
                white += 1

    if black != 48 * 48 or white != WIDTH * HEIGHT - 48 * 48:
        raise ValueError(f"像素计数不符: black={black} white={white}")

    return {
        "chunks": tags,
        "width": width,
        "height": height,
        "bit_depth": bit_depth,
        "color_type": color_type,
        "black": black,
        "white": white,
        "bbox": (min(black_xs), min(black_ys), max(black_xs), max(black_ys)),
    }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_disk(path: str):
    """返回 (bytes, sha256)；文件不存在返回 (None, None)。"""
    if not os.path.isfile(path):
        return None, None
    with open(path, "rb") as handle:
        data = handle.read()
    return data, sha256_bytes(data)


def png_pixel_size(data: bytes):
    """只读 IHDR 的前 24 字节，拿像素尺寸；不是 PNG 就返回 None。"""
    if not data or not data.startswith(PNG_SIGNATURE) or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


def asset_key(path: str) -> str:
    return os.path.basename(os.path.abspath(path))


def asset_file_label(path: str) -> str:
    """清单里记一个可读路径：优先相对脚本目录，越界则记绝对路径。"""
    absolute = os.path.abspath(path)
    relative = os.path.relpath(absolute, SCRIPT_DIR)
    if relative == ".." or relative.startswith(".." + os.sep):
        return absolute
    return relative


def build_asset_entry(png: bytes, stats: dict, out_path: str) -> dict:
    bx0, by0, bx1, by1 = stats["bbox"]
    return {
        "file": asset_file_label(out_path),
        "sha256": sha256_bytes(png),
        "size_bytes": len(png),
        "width": stats["width"],
        "height": stats["height"],
        "bit_depth": stats["bit_depth"],
        "color_type": stats["color_type"],
        "color_model": "RGB",
        "has_alpha": False,
        "interlace": 0,
        "chunks": list(stats["chunks"]),
        "pixels": {
            "white": stats["white"],
            "black": stats["black"],
            "black_bbox": [bx0, by0, bx1, by1],
        },
        "generator_params": {
            "width": WIDTH,
            "height": HEIGHT,
            "background": "#ffffff",
            "foreground": "#000000",
            "rect_x0": RECT_X0,
            "rect_y0": RECT_Y0,
            "rect_x1": RECT_X1,
            "rect_y1": RECT_Y1,
            "rect_size": [RECT_X1 - RECT_X0 + 1, RECT_Y1 - RECT_Y0 + 1],
            "bit_depth": 8,
            "color_type": 2,
            "compression": "zlib level 9",
            "filter": 0,
            "interlace": 0,
        },
    }


def load_manifest(path: str):
    """返回清单 dict；文件不存在返回 None；结构不可用抛 ManifestError。"""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as exc:
        raise ManifestError("读不出清单 %s：%s" % (path, exc)) from exc
    if not isinstance(manifest, dict):
        raise ManifestError("清单顶层不是对象：%s" % path)
    if not isinstance(manifest.get("assets"), dict):
        raise ManifestError("清单缺 assets 对象：%s" % path)
    return manifest


def write_manifest(path: str, manifest: dict) -> None:
    """原子写（同目录临时文件 + rename），避免半份 JSON 落盘。"""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)


def manifest_entry(manifest: dict, key: str):
    return manifest["assets"].get(key)


def describe_side(label: str, digest, size, dims) -> str:
    dims_text = "%dx%d" % dims if dims else "尺寸未知"
    digest_text = digest or "（不存在）"
    size_text = "%d" % size if size is not None else "?"
    return "   %s: sha256=%s size_bytes=%s %s" % (label, digest_text, size_text, dims_text)


def check_media(out_path: str, manifest_path: str) -> int:
    """消费侧入口：只核对磁盘现有图片与清单，不写盘。"""
    try:
        manifest = load_manifest(manifest_path)
    except ManifestError as exc:
        print("⛔ 图片夹具清单不可用（bugs/0198）：%s" % exc, file=sys.stderr)
        return 4
    if manifest is None:
        print("⛔ 找不到图片夹具清单：%s（bugs/0198）" % manifest_path, file=sys.stderr)
        print("   先运行 make-fixture-image.py 生成清单。", file=sys.stderr)
        return 4

    key = asset_key(out_path)
    entry = manifest_entry(manifest, key)
    if not isinstance(entry, dict):
        print("⛔ 清单里没有图片夹具 %r：%s（bugs/0198）" % (key, manifest_path),
              file=sys.stderr)
        return 4

    disk, disk_sha = read_disk(out_path)
    if disk is None:
        print("⛔ 图片夹具不存在：%s（bugs/0198）" % os.path.abspath(out_path),
              file=sys.stderr)
        print(describe_side("清单", entry.get("sha256"), entry.get("size_bytes"),
                            (entry.get("width"), entry.get("height"))),
              file=sys.stderr)
        return 3

    expected_sha = entry.get("sha256")
    expected_size = entry.get("size_bytes")
    expected_dims = (entry.get("width"), entry.get("height"))
    disk_dims = png_pixel_size(disk)
    problems = []
    if not isinstance(expected_sha, str) or disk_sha != expected_sha:
        problems.append("sha256")
    if expected_size is not None and len(disk) != expected_size:
        problems.append("size_bytes")
    if disk_dims is not None and None not in expected_dims and disk_dims != expected_dims:
        problems.append("像素尺寸")

    if problems:
        print("⛔ 图片夹具与清单不符：%s（不一致项：%s；bugs/0198）"
              % (os.path.abspath(out_path), "、".join(problems)), file=sys.stderr)
        print(describe_side("磁盘", disk_sha, len(disk), disk_dims), file=sys.stderr)
        print(describe_side("清单", expected_sha, expected_size, expected_dims),
              file=sys.stderr)
        print("   若这是预期的新夹具：make-fixture-image.py --force", file=sys.stderr)
        return 3

    print("fixtures-media-expect: OK %s sha256=%s size_bytes=%d %dx%d"
          % (key, disk_sha, len(disk), expected_dims[0], expected_dims[1]))
    return 0


def generate(out_path: str, manifest_path: str, force: bool) -> int:
    png = build_png()
    generated_sha = sha256_bytes(png)
    try:
        stats = verify_png(png)
    except ValueError as exc:
        print("make-fixture-image: 生成器自检失败：%s" % exc, file=sys.stderr)
        return 1

    key = asset_key(out_path)
    new_entry = build_asset_entry(png, stats, out_path)

    try:
        manifest = load_manifest(manifest_path)
    except ManifestError as exc:
        if not force:
            print("⛔ 图片夹具清单不可用（bugs/0198）：%s" % exc, file=sys.stderr)
            print("   确认要重建清单时加 --force。", file=sys.stderr)
            return 4
        print("⚠️ 清单不可用，--force 将重建：%s" % exc, file=sys.stderr)
        manifest = None

    entry = manifest_entry(manifest, key) if manifest is not None else None
    disk, disk_sha = read_disk(out_path)
    disk_dims = png_pixel_size(disk) if disk is not None else None

    # ── 1. 清单已有记录：磁盘与生成器输出都必须与记录一致（除 --force）──
    if isinstance(entry, dict):
        expected_sha = entry.get("sha256")
        expected_size = entry.get("size_bytes")
        expected_dims = (entry.get("width"), entry.get("height"))
        mismatches = []

        if disk is not None and disk_sha != expected_sha:
            mismatches.append(("磁盘现有图片", disk_sha, len(disk), disk_dims))
        if generated_sha != expected_sha:
            mismatches.append(("本次生成器输出", generated_sha, len(png), (WIDTH, HEIGHT)))
        if expected_size is not None and disk is not None and len(disk) != expected_size:
            if not any(m[0] == "磁盘现有图片" for m in mismatches):
                mismatches.append(("磁盘现有图片", disk_sha, len(disk), disk_dims))

        if mismatches:
            if not force:
                print("⛔ 图片夹具与清单记录不符（bugs/0198）：%s"
                      % os.path.abspath(out_path), file=sys.stderr)
                for label, sha, size, dims in mismatches:
                    print(describe_side(label, sha, size, dims), file=sys.stderr)
                print(describe_side("清单记录", expected_sha, expected_size,
                                    expected_dims), file=sys.stderr)
                print("   --force 才允许重写图片与清单。", file=sys.stderr)
                return 3
            print("⚠️ 图片夹具与清单记录不符，--force 重写：%s"
                  % os.path.abspath(out_path), file=sys.stderr)

    elif manifest is not None:
        # 清单存在但没有该资产 ⇒ 无法核对，而不是静默新增。
        if not force:
            print("⛔ 清单里没有图片夹具 %r：%s（bugs/0198）"
                  % (key, manifest_path), file=sys.stderr)
            print(describe_side("磁盘", disk_sha, len(disk) if disk is not None else None,
                                disk_dims), file=sys.stderr)
            print("   --force 才允许新增记录并重写清单。", file=sys.stderr)
            return 4
        print("⚠️ 清单缺 %r，--force 将新增记录。" % key, file=sys.stderr)

    # ── 2. 写图片（内容已一致则跳过，避免无谓改 mtime）──
    need_write = disk is None or disk_sha != generated_sha
    if need_write:
        out_dir = os.path.dirname(os.path.abspath(out_path))
        os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "wb") as handle:
            handle.write(png)

    # 回读落盘文件：既验证写入，也验证图案本身。
    on_disk, on_disk_sha = read_disk(out_path)
    if on_disk is None or on_disk_sha != generated_sha:
        print("make-fixture-image: 落盘后 SHA-256 不一致", file=sys.stderr)
        return 1
    try:
        on_disk_stats = verify_png(on_disk)
    except ValueError as exc:
        print("make-fixture-image: 落盘文件自检失败：%s" % exc, file=sys.stderr)
        return 1

    # ── 3. 清单：首次生成或 --force 时写入；内容未变则不重写 ──
    manifest_written = False
    if manifest is None:
        manifest = {
            "schema": MANIFEST_SCHEMA,
            "generator": "make-fixture-image.py",
            "assets": {},
        }
    previous = manifest["assets"].get(key)
    if force or previous != new_entry:
        manifest["assets"][key] = new_entry
        write_manifest(manifest_path, manifest)
        manifest_written = True

    bx0, by0, bx1, by1 = on_disk_stats["bbox"]
    print(f"wrote: {os.path.abspath(out_path)}" if need_write
          else f"unchanged: {os.path.abspath(out_path)}")
    print(f"sha256: {generated_sha}")
    print(f"size_bytes: {len(png)}")
    print(
        "png: {w}x{h}, bit_depth={bd}, color_type={ct} (RGB, no alpha), "
        "interlace=0, chunks={chunks}".format(
            w=on_disk_stats["width"], h=on_disk_stats["height"],
            bd=on_disk_stats["bit_depth"], ct=on_disk_stats["color_type"],
            chunks=",".join(on_disk_stats["chunks"]),
        )
    )
    print(
        f"pixels: white={on_disk_stats['white']} black={on_disk_stats['black']}; "
        f"black bbox=({bx0},{by0})-({bx1},{by1}) {bx1 - bx0 + 1}x{by1 - by0 + 1}"
    )
    print("verification: OK (CRC / IHDR / filter=0 / 逐像素)")
    print("manifest: %s%s" % (os.path.abspath(manifest_path),
                              "" if manifest_written else " (unchanged)"))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="生成确定性图片夹具 pic.png 并核对清单")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"输出路径（默认 {DEFAULT_OUT}）")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST,
                        help=f"摘要清单路径（默认 {DEFAULT_MANIFEST}）")
    parser.add_argument("--check", action="store_true",
                        help="只核对磁盘现有图片与清单，不写盘（消费侧入口）")
    parser.add_argument("--force", action="store_true",
                        help="摘要/尺寸不符时允许重写图片与清单")
    args = parser.parse_args()

    if args.check and args.force:
        parser.error("--check 与 --force 不能同时使用")

    if args.check:
        return check_media(args.out, args.manifest)
    return generate(args.out, args.manifest, args.force)


if __name__ == "__main__":
    sys.exit(main())
