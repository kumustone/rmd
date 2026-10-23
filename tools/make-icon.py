#!/usr/bin/env python3
"""生成 `src-tauri/icons/icon.png` —— **一个明确的占位图标**。

# 为什么需要它

Tauri 的代码生成**硬性要求**一个窗口图标。`tauri-codegen-2.7.2/src/context.rs:211-222`：

```rust
let icon_path = find_icon(&config, &config_parent, |i| i.ends_with(".png"), "icons/icon.png");
let icon = CachedIcon::new(&root, &icon_path)?;   // ← 文件不存在就直接 panic
```

非 Windows 目标**没有回退路径**——`find_icon` 在 `bundle.icon` 里找一个 `.png`，
找不到就用默认的 `icons/icon.png`，再找不到就 panic（第一次构建的实际报错。
见 `docs/design/0002` §10.4 批 1 的实施记录）。

# ⚠️ 这不是产品图标

`vision/0001` 与任何 design 都**没有**定过应用图标。这里生成的只是一个
**能让窗口起来的纯色方块**——⛔ 不要把它当成设计决定，也不要花时间美化它。
真要做图标时，替换 `src-tauri/icons/` 下的文件并重跑本脚本的替代品即可。

# 用法

    python3 tools/make-icon.py            # 写 src-tauri/icons/icon.png
    python3 tools/make-icon.py --size 512

只用 Python 标准库（zlib + struct），不引入 Pillow。
"""

import argparse
import struct
import zlib
from pathlib import Path


def png_bytes(size: int, rgba: tuple[int, int, int, int]) -> bytes:
    """手搓一个纯色 RGBA PNG。

    ⚠️ 用 `-I` 跑本脚本时它不读任何外部文件，所以不受"解释器从脚本目录
    加载模块"那条隐患影响；这里仍写成不 import 第三方、不读 CWD 的形式。
    """
    r, g, b, a = rgba

    # 每行：1 个 filter 字节（0 = None）+ size 个 4 字节像素
    row = b"\x00" + bytes((r, g, b, a)) * size
    raw = row * size

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(
        ">IIBBBBB",
        size, size,
        8,     # bit depth
        6,     # color type: RGBA
        0, 0, 0,
    )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 rmd 的占位应用图标")
    ap.add_argument("--size", type=int, default=256, help="边长（像素），默认 256")
    ap.add_argument("--out", type=Path, default=None, help="输出路径")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    out = args.out or (root / "src-tauri" / "icons" / "icon.png")
    out.parent.mkdir(parents=True, exist_ok=True)

    # 中性灰，不透明。选它是为了**一眼看出是占位**，不像任何品牌色。
    data = png_bytes(args.size, (0x6B, 0x72, 0x80, 0xFF))
    out.write_bytes(data)
    print(f"✓ {out}（{args.size}×{args.size}，{len(data)} B，占位）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
