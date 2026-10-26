#!/usr/bin/env python3
"""memory_zero_hit.py — L1 三态报告（active / stale / superseded）+ 增益门

来源与演进：
  v0.1（2026-08-25）EDGE 启发：不是所有经验都值得长期保留，只有被验证带来正增益
    （被召回/被用到）的才值得留在 L1。机械观测「已采纳但从未召回」。
  v0.2（2026-10-18）修切分口径 + 前缀回退，消除「对所有条目恒报零命中」的假告警。
  v0.3（2026-10-21）P1 三态化（借鉴 MemT-1.0 的 write/erase/forget 三门分离）：
    原实现把「过期」和「被推翻」混成一个「陈旧」标签，出口无从区分。现按状态分流：
      active     → 常驻，参与召回
      stale      → 无常驻标签 + v 超过阈值 + 净召回不足 → 建议下沉 wiki 留指针
      superseded → conflict_merge 原位覆盖后标 state: superseded → 建议删除（DREAMS 留痕）
    本工具**只报不做**：任何淘汰动作都需人工确认（红线：不自动删条目）。

用法：
  python3 memory_zero_hit.py [--days 90] [--min-uses 3] [--json] [--top 5]
"""
import argparse
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

HOME = Path.home()
MEMORIES = HOME / ".dsh" / "memories"
USAGE_FILE = MEMORIES / ".usage.json"
L1_FILES = [("MEMORY.md", MEMORIES / "MEMORY.md"), ("USER.md", MEMORIES / "USER.md")]

# 常驻标签：规则/安全/边界/身份/红线类永不判 stale（与 rrf_recall._PERSISTENT_TAGS 一致）
PERSISTENT_TAGS = frozenset({"安全", "规则", "边界", "红线", "身份", "硬约束", "常驻"})

RE_ID = re.compile(r"<!--[^>]*?\bid:\s*([mu]\d+)")
RE_V = re.compile(r"<!--[^>]*?\bv:\s*(\d{4}-\d{2}-\d{2})")
RE_STATE = re.compile(r"<!--[^>]*?\bstate:\s*(\w+)")
RE_SUPERSEDED_BY = re.compile(r"<!--[^>]*?\bsuperseded_by:\s*([mu]\d+)")
# trigger 词（2026-10-21）：MEMORY 条目普遍无 #标签、只有 trigger，相邻度判定必须把它算进来
RE_TRIGGER = re.compile(r"<!--\s*trigger:\s*([^>]*?)-->")


def parse_l1_entries(path: Path):
    """把 L1 文件按 § 拆成条目（与 rrf_recall.split_entries 同口径）。"""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    out = []
    for chunk in text.split("§"):
        chunk = chunk.strip()
        if not chunk:
            continue
        m_id, m_v = RE_ID.search(chunk), RE_V.search(chunk)
        m_st, m_sb = RE_STATE.search(chunk), RE_SUPERSEDED_BY.search(chunk)
        m_trig = RE_TRIGGER.search(chunk)
        trig = [w.strip() for w in m_trig.group(1).split(",") if w.strip()] if m_trig else []
        tags = re.findall(r"#([^\s#]+)", chunk)
        out.append({
            "file": path.name,
            "head40": chunk[:40],
            "text": chunk,
            "tags": tags,
            "terms": sorted(set(tags) | set(trig)),   # 相邻度判定用：标签 + trigger 词
            "id": m_id.group(1) if m_id else None,
            "v": m_v.group(1) if m_v else None,
            "state_mark": m_st.group(1) if m_st else None,
            "superseded_by": m_sb.group(1) if m_sb else None,
        })
    return out


def load_usage():
    if not USAGE_FILE.exists():
        return {}
    try:
        return json.loads(USAGE_FILE.read_text(encoding="utf-8")).get("entries", {})
    except (json.JSONDecodeError, OSError):
        return {}


def find_usage(usage: dict, fname: str, head40: str):
    """精确键优先，失败按公共前缀回退 ≥12 字（2026-10-18 加，防条目编辑后统计失联）。"""
    exact = f"{fname}:{head40}"
    if exact in usage:
        return usage[exact]
    prefix = f"{fname}:"
    best, best_len = None, 0
    for k, v in usage.items():
        if not k.startswith(prefix):
            continue
        other = k[len(prefix):]
        n = 0
        for a, b in zip(head40, other):
            if a != b:
                break
            n += 1
        if n > best_len:
            best, best_len = v, n
    return best if best_len >= 12 else None


def decay_of(entry: dict, today: date):
    """与 rrf_recall.decay_factor 同档位（仅用于展示与判据，不写回）。"""
    if any(t in PERSISTENT_TAGS for t in entry["tags"]):
        return 1.0
    if not entry["v"]:
        return None
    try:
        age = (today - date.fromisoformat(entry["v"])).days
    except ValueError:
        return None
    for limit, f in ((30, 1.0), (90, 0.7), (180, 0.5)):
        if age <= limit:
            return f
    return 0.3


def classify(entry: dict, uses: int, today: date, days: int, min_uses: int) -> str:
    if entry["state_mark"] == "superseded" or entry["superseded_by"]:
        return "superseded"
    if any(t in PERSISTENT_TAGS for t in entry["tags"]):
        return "active"
    if not entry["v"]:
        return "active"          # 无基准不判死（宁留不误伤），单独计「未标 v」
    try:
        age = (today - date.fromisoformat(entry["v"])).days
    except ValueError:
        return "active"
    if age > days and uses < min_uses:
        return "stale"
    return "active"


EXIT_HINT = {
    "stale": "下沉 wiki 对应域，L1 只留一行指针（不自动执行，需人工确认）",
    "superseded": "必须删除以彻底移除（抑制表达会被后续写入/绕过过滤的通道复活，2026-10-21 REX 论证）；改动前先 git 备份",
    "active": "保持在召回层",
}

# ---------- 领域特异性（2026-10-21，借鉴 REX 的差分激活 Δᵢ = f_target − f_general） ----------
# 只按绝对召回次数评价记忆会误判：一条到处被扫到的条目 uses 很高，其实是背景噪音。
# 特异性 = 1 − 命中该条目的查询数 / 总查询数：接近 1 = 只在少数查询出现（真触发式知识），
# 接近 0 = 几乎所有查询都命中（背景噪音）。样本不足时不报（避免拿小样本下判断）。
HITLOG = MEMORIES / ".hitlog.jsonl"
MIN_QUERIES = 20


def load_specificity():
    """返回 (总查询数, {条目id: 命中查询数})"""
    total, per = 0, {}
    if not HITLOG.exists():
        return 0, per
    try:
        lines = HITLOG.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0, per
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        # 与写入侧同口径：>500 字符的多为系统注入文本，命中面过宽会污染分母
        if len(rec.get("q") or "") > 500:
            continue
        total += 1
        for eid in rec.get("ids") or []:
            per[eid] = per.get(eid, 0) + 1
    return total, per


def adjacency(row: dict, actives: list):
    """stale 条目与 active 条目的相邻度：共享标签 ≥2 → 建议合并而非下沉。

    依据 REX（2610.25791）的「相邻领域连带损失」：删目标知识会连带带走相邻知识，
    实测 MMLU 掉的分数 57–75% 集中在相邻学科。记忆同理，整条删会误伤共享上下文的活条目。
    """
    best = None
    for a in actives:
        shared = set(row["terms"]) & set(a["terms"])
        if len(shared) >= 2 and (best is None or len(shared) > len(best[1])):
            best = (a, shared)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90, help="stale 阈值天数（默认 90，与衰减档位对齐）")
    ap.add_argument("--min-uses", type=int, default=3, help="stale 的净召回上限（默认 <3 次即算未验证）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--top", type=int, default=0, help="同时输出高复用 TOP N")
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date()
    usage = load_usage()
    total_q, spec_hits = load_specificity()
    rows = []
    for fname, path in L1_FILES:
        for ent in parse_l1_entries(path):
            u = find_usage(usage, ent["file"], ent["head40"])
            uses = u.get("uses", 0) if u else 0
            last_use = u.get("last_use") if u else None
            state = classify(ent, uses, today, args.days, args.min_uses)
            spec = None
            if ent["id"] and total_q >= MIN_QUERIES:
                spec = round(1 - spec_hits.get(ent["id"], 0) / total_q, 3)
            rows.append({**ent, "uses": uses, "last_use": last_use,
                         "state": state, "decay": decay_of(ent, today), "spec": spec})

    actives = [r for r in rows if r["state"] == "active"]

    if args.json:
        print(json.dumps([{k: r[k] for k in ("file", "id", "v", "state", "uses", "last_use",
                                             "decay", "spec", "tags", "head40")}
                          for r in rows], ensure_ascii=False, indent=2))
        return 0

    counts = {s: sum(1 for r in rows if r["state"] == s) for s in ("active", "stale", "superseded")}
    no_v = [r for r in rows if not r["v"]]
    never = [r for r in rows if r["uses"] == 0]
    spec_note = (f"｜特异性样本 {total_q} 次查询" if total_q >= MIN_QUERIES
                 else f"｜特异性样本不足（{total_q}/{MIN_QUERIES}）")

    print(f"# L1 三态报告（stale 阈值 {args.days} 天 / 净召回 <{args.min_uses} 次）")
    _sup_txt = f" / superseded {counts['superseded']}" if counts["superseded"] else ""
    print(f"# 合计 {len(rows)} 条：active {counts['active']} / stale {counts['stale']}{_sup_txt}"
          f"｜未标 v {len(no_v)} 条｜从未召回 {len(never)} 条{spec_note}")

    for state in ("stale", "superseded"):
        group = [r for r in rows if r["state"] == state]
        # 2026-10-21 决定：覆盖即删除，superseded 不再产生 → 0 条不输出该段
        # （识别能力保留：万一历史文件或手工标记里出现，静默忽略会让旧事实重回召回）
        if state == "superseded" and not group:
            continue
        print(f"\n## {state}（{len(group)} 条）— 默认出口：{EXIT_HINT[state]}")
        if not group:
            print("  无")
        for r in group:
            ident = r["id"] or "(无 id)"
            extra = f" ← 被 {r['superseded_by']} 覆盖" if r["superseded_by"] else ""
            spec_txt = f" 特异={r['spec']}" if r["spec"] is not None else ""
            print(f"  - {ident} [{r['file']}] v={r['v']} uses={r['uses']} decay={r['decay']}{spec_txt}{extra}")
            print(f"    {r['head40']}…")
            if state == "stale":
                adj = adjacency(r, actives)
                if adj:
                    a, shared = adj
                    print(f"    → 建议**合并**（非下沉）：与 {a['id'] or a['head40'][:16]} 共享标签 "
                          f"{'、'.join(sorted(shared))}——整条删会连带误伤活跃条目")
                else:
                    print("    → 建议下沉 wiki（无相邻活跃条目，独立性高）")

    if never:
        print(f"\n## 参考：从未被召回（{len(never)} 条）")
        for r in never:
            print(f"  - {r['id'] or '(无 id)'} [{r['file']}] {r['head40'][:44]}…")
    if no_v:
        print(f"\n## 参考：未标 v（{len(no_v)} 条，衰减走 mtime 兜底）")
        for r in no_v:
            print(f"  - {r['id'] or '(无 id)'} [{r['file']}] {r['head40'][:44]}…")

    if args.top > 0:
        top = sorted(rows, key=lambda x: -x["uses"])[: args.top]
        print(f"\n## 高复用 TOP {len(top)}（uses 降序）")
        for i, r in enumerate(top, 1):
            print(f"{i}. ({r['uses']} 次) {r['id'] or '-'} [{r['file']}] {r['head40'][:40]}…")

    if counts["stale"] or counts["superseded"]:
        print("\n⚠ 本工具只报不做：淘汰/下沉需人工确认后再动，禁止自动删除。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
