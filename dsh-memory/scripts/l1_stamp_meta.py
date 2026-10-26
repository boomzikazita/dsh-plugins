#!/usr/bin/env python3
"""l1_stamp_meta.py — L1 条目元数据打标（P0）

给 ~/.dsh/memories/{MEMORY,USER}.md 的每条条目补 `<!-- id: m01 | v: YYYY-MM-DD -->`。

为什么要做：
  rrf_recall.decay_factor() 的衰减基准是条目 `<!-- v: -->`，实测两条文件 0 条带此标记
  → 全部 fallback 到文件 mtime → 所有条目同档位 → 时间衰减形同虚设。
  id 则给条目一个稳定标识（现 .usage.json 用「文件名:前40字」作键，改一个字即失联）。

v 取值规则（可溯源，不猜）：
  ① 条目内文含「出处」→ 取内文所有 YYYY-MM-DD 的最大值（写着的知识确立/复核日）
  ② 无出处 → 取 git blame 该行最后一次修改日（版本时间戳本义）
  ③ 两者皆无 → 不打 v，保留现有 mtime fallback 行为

安全性：
  - 只在行尾追加注释，不动前 40 字符 → 不破坏 .usage.json 现有键
  - 幂等：已有 `<!-- id:` 的行跳过
  - 默认 dry-run，--apply 才写盘

用法：python3 l1_stamp_meta.py [--apply]
"""
from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MEM = Path.home() / ".dsh" / "memories"
FILES = [("MEMORY.md", "m"), ("USER.md", "u")]
DATE_RE = re.compile(r"20\d{2}-\d{2}-\d{2}")


def blame_dates(path: Path) -> dict[int, str]:
    """返回 {行号(1-based): 该行最后修改日 YYYY-MM-DD}"""
    out: dict[int, str] = {}
    try:
        raw = subprocess.run(
            ["git", "-C", str(path.parent), "blame", "--line-porcelain", path.name],
            capture_output=True, text=True, timeout=30, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError) as e:
        print(f"  ! blame 失败（{path.name}）: {e}", file=sys.stderr)
        return out
    ts = None
    lineno = None
    for line in raw.splitlines():
        if line.startswith("\t"):
            if lineno is not None and ts is not None:
                out.setdefault(lineno, datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"))
            continue
        parts = line.split()
        # 头部行：<sha> <orig_lineno> <final_lineno> [<num_lines>]
        if len(parts) >= 3 and re.fullmatch(r"[0-9a-f]{7,40}", parts[0]) and parts[2].isdigit():
            lineno = int(parts[2])
            ts = None
        elif line.startswith("author-time "):
            try:
                ts = int(line.split()[1])
            except (IndexError, ValueError):
                ts = None
    return out


def entry_date(text: str, blame: dict[int, str], lineno: int) -> str | None:
    if "出处" in text:
        dates = DATE_RE.findall(text)
        if dates:
            return max(dates)
    return blame.get(lineno)


def main() -> int:
    apply = "--apply" in sys.argv
    for fname, prefix in FILES:
        path = MEM / fname
        if not path.exists():
            print(f"[{fname}] 不存在，跳过")
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        blame = blame_dates(path)
        n = 0
        out = []
        for i, line in enumerate(lines, 1):
            s = line.strip()
            if not s or s == "§" or "<!-- id:" in line:
                out.append(line)
                continue
            n += 1
            eid = f"{prefix}{n:02d}"
            v = entry_date(line, blame, i)
            if "<!-- v:" in line:
                # 已有 v 注释（conflict_merge 写的）→ 只补 id，追加成独立注释
                meta = f"<!-- id: {eid} -->"
            elif v:
                meta = f"<!-- id: {eid} | v: {v} -->"
            else:
                meta = f"<!-- id: {eid} -->"
            out.append(line.rstrip() + " " + meta)
        print(f"[{fname}] 条目 {n} 条（已有 id 跳过 {sum(1 for l in lines if '<!-- id:' in l)} 条）")
        for i, (old, new) in enumerate(zip(lines, out), 1):
            if old != new:
                print(f"  L{i}  - …{old[-46:]}")
                print(f"       + …{new[-62:]}")
        if apply:
            bak = path.with_suffix(path.suffix + ".bak-20261021-p0")
            if not bak.exists():
                bak.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
                print(f"  ✔ 备份 → {bak.name}")
            path.write_text("\n".join(out) + "\n", encoding="utf-8")
            print(f"  ✔ 已写入 {fname}")
    if not apply:
        print("\n（dry-run，未写盘；加 --apply 落盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
