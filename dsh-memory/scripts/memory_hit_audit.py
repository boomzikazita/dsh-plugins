#!/usr/bin/env python3
"""memory_hit_audit.py — 记忆命中审计（存了不用要有度量）

2026-10-18 重写：原实现读 hits.sqlite 的 L1 lane，而该 lane 只落了 5 条且文本是
200 字快照——条目一旦编辑（哪怕改一个字）就再也匹配不上，于是对 17 条 L1 恒报
「从未命中 100%」，把每天都被召回的规则（如公文写作总纲）报成零增益淘汰候选。

真实情况：rrf_recall 同时写两套统计——
  · `.usage.json`  ← _record_usage，L1 专用、覆盖全（34 条），本审计的正确数据源
  · `hits.sqlite`  ← record_hits，各层通用，L1 只有 5 条历史快照
现改为复用 memory_zero_hit 的解析与宽松匹配（同一条目编辑前后都能对上），
hits.sqlite 仅用于末尾的各层命中总量汇总。

用法:
  memory_hit_audit.py           全部输出
  memory_hit_audit.py --never   仅从未命中清单（供周审 prompt 引用）
  memory_hit_audit.py --top 10  TOP N 命中
"""
import argparse
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from memory_zero_hit import L1_FILES, find_usage, load_usage, parse_l1_entries  # noqa: E402

MEMORIES = pathlib.Path.home() / ".dsh" / "memories"
HITS_DB = MEMORIES / "hits.sqlite"


def load_lane_totals() -> dict:
    """各层命中总量（hits.sqlite，仅供汇总展示；缺失时返回空）。"""
    if not HITS_DB.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{HITS_DB}?mode=ro", uri=True)
    except Exception:
        return {}
    out = {}
    try:
        for lane, n, total in con.execute(
            "SELECT lane, count(*), coalesce(sum(count),0) FROM hits GROUP BY lane"
        ):
            out[lane] = {"entries": n, "total": total}
    except Exception:
        pass
    finally:
        con.close()
    return out


def collect_entries():
    """[{file, idx, text, uses, last_use}]，统计来自 .usage.json。"""
    usage = load_usage()
    out = []
    for fname, path in L1_FILES:
        for i, ent in enumerate(parse_l1_entries(path)):
            u = find_usage(usage, ent["file"], ent["head40"]) or {}
            out.append({
                "file": fname, "idx": i, "text": ent["text"],
                "uses": u.get("uses", 0), "last_use": u.get("last_use"),
            })
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--never", action="store_true", help="仅输出 L1 从未命中清单")
    ap.add_argument("--top", type=int, default=10, help="TOP N 命中（默认 10）")
    args = ap.parse_args()

    entries = collect_entries()
    hit_stats = [e for e in entries if e["uses"] > 0]
    never = [e for e in entries if e["uses"] == 0]

    if args.never:
        total = len(entries)
        print(f"# L1 从未命中条目（共 {len(never)}/{total}，"
              f"{100 * len(never) // max(total, 1)}%）")
        for e in never:
            print(f"- [{e['file']}:{e['idx']}] {e['text'][:120]}")
        return

    print(f"# 记忆命中审计  L1 总量 {len(entries)} · 已命中 {len(hit_stats)} "
          f"· 从未命中 {len(never)}")
    print()
    print(f"## 命中 TOP {args.top}")
    for e in sorted(hit_stats, key=lambda x: -x["uses"])[: args.top]:
        print(f"- ({e['uses']} 次) [{e['file']}:{e['idx']}] {e['text'][:100]}")
    print()
    print(f"## 从未命中（{len(never)} 条——L1 预算淘汰/蒸馏候选）")
    for e in never:
        print(f"- [{e['file']}:{e['idx']}] {e['text'][:120]}")
    print()
    print("# 各层命中总量（hits.sqlite）")
    lanes = load_lane_totals()
    if not lanes:
        print("- （hits.sqlite 不存在或无记录）")
    for lane in sorted(lanes):
        v = lanes[lane]
        print(f"- {lane}: {v['entries']} 条 / 累计 {v['total']} 次")


if __name__ == "__main__":
    main()
