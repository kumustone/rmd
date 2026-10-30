#!/bin/bash
# 判定 `$(PREFIX)/rmd` 当前是什么。⛔ **只读**——不建目录、不删、不写。
#
# 用法：scripts/install-guard.sh <path>
#
# stdout 只出一个词（`make install` / `make uninstall` 按它分支）：
#   absent   不存在
#   link     符号链接（⭐ **悬空的也算**）
#   file     普通文件
#   other    其它（目录 / fifo / 设备 …）
#
# ⚠️⚠️ **`-L` 必须排在 `-e` 前面**：悬空符号链接 `test -e` 是**假**、`test -L` 是真。
# 用 `-e` 判存在 ⇒ "看起来什么都没有" ⇒ 后续步骤会把那条链接**当成空地**处理。
#
# ⚠️ **已取代**（2026-10-22 实测，`design/0033` §10）：这里原来写的是
# "`install(1)` 会**顺着链接**把它指向的路径创建出来"。**不准确**——
# macOS 上 `/usr/bin/install` 先写临时文件再 rename ⇒ 它**替换掉链接本身**
# （悬空与不悬空都实测过：链接没了、指向的目标一个字节没变）。
# ⇒ 真正的代价不是"写坏 `.app`"，而是**那条托管链接被静默换成一份拷贝**：
# 用户从此拿着会过期的旧二进制，菜单里那份托管关系也就断了。
# 判据因此落在 **C2（链接还在）** 上；`C3`（目标处没多出文件）是**反向保险**，不是主判据。
#
# ⭐ 为什么 `make install` 要认这个区别（`design/0033`）：
# 应用内「安装命令行工具」建的是一份**符号链接**，指着运行中的那个 `.app` 里的二进制
# ⇒ 换新版 `.app` 之后它**自己就跟着变**。`make install` 装的是一份**拷贝**
# ⇒ 若它默默盖掉那条链接，用户会在下一次升级 `.app` 之后**拿着旧二进制**，
# 而应用菜单里那份托管关系也就此断掉（`INV-CLI-06` 的同一条精神：不许悄悄换掉真相）。
set -u

P=${1:-}
if [ -z "$P" ]; then
  echo "用法: scripts/install-guard.sh <path>" >&2
  exit 2
fi

if [ -L "$P" ]; then
  echo link
elif [ -e "$P" ]; then
  if [ -f "$P" ]; then echo file; else echo other; fi
else
  echo absent
fi
