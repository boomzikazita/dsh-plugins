#!/usr/bin/env python3
"""honcho_sync.py — dsh 会话 → Honcho L3 写入钩子（任务 A：Deriver 落地）

背景：Honcho（L3 语义层）在 hermes→dsh 迁移后无写入方，search 只剩 8/16 前旧数据。
本脚本从 dsh 会话 JSONL 提取有信息量的 user 消息 → 批量写入 Honcho conclusions
（observer=dsh-agent, observed=laozheng），供 honcho_search/chat 召回。

用法：
  honcho_sync.py sync [--days N]   增量同步最近 N 天 user 消息（默认 2）
  honcho_sync.py dry-run [--days N] 只打印将写入的消息（不写）
  honcho_sync.py check              显示 Honcho 中 dsh 结论数量

幂等：state 文件记录已处理 (session, seq)，重复运行不重写。
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harvest  # 复用 unzstd / iter_session_files / extract_text_blocks

HONCHO_BASE = "http://127.0.0.1:8000"
# 2026-10-14：写入从 workspace=dsh 迁到 workspace=hermes。
# 原因：桥（L3 唯一读取入口）的口径是 hermes 工作区的 hermes→laozheng，写进 dsh 工作区的内容
# L3 永远看不到。现写 hermes/dsh-agent→laozheng，桥侧以 HONCHO_EXTRA_OBSERVERS=dsh-agent 并查，
# 既保住来源标识（observer=dsh-agent，与 dsh 工作区 370 条历史同身份）又能被召回。
WS = "life"
OBSERVER = "dsh-agent"
OBSERVED = "laozheng"
SESSION_PREFIX = "dsh-sync"   # 按天建会话，deriver 在会话内提炼
STATE_FILE = Path.home() / ".dsh" / "memories" / "honcho-sync-state.json"
MIN_LEN = 15  # 过滤超短指令/单字回复
MAX_MSG_PER_RUN = 50  # 单次上限，防止灌爆
MAX_TEXT_LEN = 8000   # 单条上限：超长文档转储会让整批 422（2026-10-18 实证）
SKIP_PREFIXES = ("> ##", "## ", "```")  # 文档转储/代码块，不是记忆

# ── 出站脱敏（2026-10-27，移植自 plastic-labs/dsh-honcho src/redact.ts，MIT）──
# 背景：本脚本把 user 消息原文直灌 Honcho，guard 钩子只拦写文件工具、管不到这条
# 出站链——粘贴过的 .env / token 会原样进 L3。"capture without scrubbing is an
# exfiltration path"。规则与 dsh-honcho/claude-honcho 保持一致，均为 best-effort。
_REDACT_RULES = [
    # KEY=value 赋值（PGPASSWORD=..., AWS_SECRET_ACCESS_KEY=...）
    (re.compile(r"\b(\w*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|CREDENTIALS?)\w*)"
                r"\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s;|&\"']+)", re.I), r"\1=***"),
    # --password / --token 风格 CLI 参数
    (re.compile(r"(--(?:password|passwd|pwd|token|api-?key|secret|auth)[= ])"
                r"(?:\"[^\"]*\"|'[^']*'|[^\s;|&\"']+)", re.I), r"\1***"),
    # Authorization 头
    (re.compile(r"(authorization:\s*(?:bearer|basic|token)\s+)[^\s\"']+", re.I), r"\1***"),
    # URL 内嵌凭据（scheme://user:pass@host）
    (re.compile(r"([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s]+@", re.I), r"\1***@"),
    # 知名 token 形状：Honcho/AWS/sk-/GitHub/Slack/GitLab/npm
    (re.compile(r"\b(?:hch[_-]?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}"
                r"|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
                r"|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b"),
     "***"),
]


def redact_secrets(text: str) -> str:
    for pat, rep in _REDACT_RULES:
        text = pat.sub(rep, text)
    return text


# telemetry：服务端可区分写入来源（借鉴 dsh-honcho 的 X-Honcho-Plugin 头）
try:
    _PKG_VER = json.loads((Path(__file__).parent.parent / "package.json").read_text())["version"]
except Exception:
    _PKG_VER = "unknown"
_PLUGIN_HEADER = f"dsh-memory/{_PKG_VER}"

import urllib.request


def _req(method, path, body=None, timeout=60):
    url = HONCHO_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "X-Honcho-Plugin": _PLUGIN_HEADER})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"processed": {}}


def save_state(st: dict) -> None:
    STATE_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=1))


def collect_user_messages(days: int) -> list:
    """最近 days 天内有 mtime 的 session，提取 user 文本消息（含 seq 标识）。"""
    now = time.time()
    cutoff = now - days * 86400
    msgs = []
    for ws_name, sess_name, log in harvest.iter_session_files():
        if log.stat().st_mtime < cutoff:
            continue
        text = harvest.unzstd(log)
        if not text:
            continue
        for i, line in enumerate(text.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            seq = ev.get("seq", 0)
            if ev.get("type") != "user/message":
                continue
            data = ev.get("data") or {}
            src = data.get("source") or {}
            if src.get("kind") != "user":
                continue  # 只收真实用户消息，跳过插件/系统注入
            content = harvest.extract_text_blocks(data.get("content"))
            if not content or len(content) < MIN_LEN:
                continue
            # 跳过明显的纯工具结果回显（含长代码块/路径列表）
            if content.startswith(("```", "Error", "Traceback")):
                continue
            msgs.append({"key": f"{ws_name}/{sess_name}:{seq}", "text": redact_secrets(content)})
    return msgs


def ensure_session(name: str):
    """创建会话并挂 peers（幂等）。deriver 需要 peers 才知道该提炼谁。"""
    try:
        _req("POST", f"/v3/workspaces/{WS}/sessions",
             {"id": name, "peer_names": {OBSERVED: {}, OBSERVER: {}}}, timeout=60)
    except Exception as e:
        # 已存在会报冲突，属正常
        if "exist" not in str(e).lower() and "409" not in str(e):
            raise


def sync(days: int, dry: bool) -> int:
    st = load_state()
    processed = st.setdefault("processed", {})
    msgs = collect_user_messages(days)
    to_write = [m for m in msgs if m["key"] not in processed]
    # 过滤：超长文档转储、代码块——这类内容进 conclusions/messages 只会污染召回
    before = len(to_write)
    to_write = [m for m in to_write
                if len(m["text"]) <= MAX_TEXT_LEN
                and not m["text"].lstrip().startswith(SKIP_PREFIXES)]
    if before != len(to_write):
        print(f"过滤超长/文档转储 {before - len(to_write)} 条")
    to_write = to_write[:MAX_MSG_PER_RUN]
    print(f"扫描到 {len(msgs)} 条 user 消息，未处理 {len(to_write)} 条")
    if dry:
        for m in to_write[:10]:
            print(f"  [dry-run] {m['text'][:60]}")
        return 0
    if not to_write:
        return 0
    # 2026-10-18：改写入 messages 而非 conclusions。
    # 原实现直灌结论表，绕过了 Honcho 的 deriver——产出全是 level=explicit 的消息原文
    # （"帮我查一下…"这类指令碎片），可召回但没信息量。改走 messages 后由 deriver
    # 后台提炼成 inductive/deductive 结论（实测：1 条消息 → 3 条提炼结论）。
    # 按天分会话，避免单会话无限增长。
    by_day = {}
    for m in to_write:
        day = (m.get("ts") or datetime.now(timezone.utc).isoformat())[:10].replace("-", "")
        by_day.setdefault(day, []).append(m)

    for day, batch in sorted(by_day.items()):
        sname = f"{SESSION_PREFIX}-{day}"
        try:
            ensure_session(sname)
        except Exception as e:
            print(f"建会话 {sname} 失败: {e}")
            save_state(st)
            return -1
        for i in range(0, len(batch), 20):
            chunk = batch[i:i + 20]
            messages = [{"peer_id": OBSERVED, "content": m["text"]} for m in chunk]
            try:
                _req("POST", f"/v3/workspaces/{WS}/sessions/{sname}/messages",
                     {"messages": messages}, timeout=120)
            except Exception as e:
                print(f"写入 {sname} 批次 {i // 20} 失败: {e}")
                save_state(st)
                return -1
            for m in chunk:
                processed[m["key"]] = datetime.now(timezone.utc).isoformat()
            print(f"{sname} 批次 {i // 20 + 1} 写入 {len(chunk)} 条")
            time.sleep(1)
    save_state(st)
    return len(to_write)


def check():
    """自检：统计 dsh 会话已写入 Honcho 的结论数。

    2026-10-14 修：原实现 GET /v3/workspaces/{ws}/conclusions?observer_id=... 撞 405——
    该路径只挂 POST（/conclusions/list 与 /conclusions/query）。改用 /conclusions/list，
    filters 传 peer 名，返回 {items,total,page,size,pages}。
    """
    try:
        r = _req("POST", f"/v3/workspaces/{WS}/conclusions/list",
                 {"filters": {"observer": OBSERVER, "observed": OBSERVED}, "size": 3}, timeout=30)
        total = r.get("total") if isinstance(r, dict) else len(r)
        print(f"Honcho workspace[{WS}] {OBSERVER}→{OBSERVED} 结论数: {total}")
        for it in (r.get("items", []) if isinstance(r, dict) else r)[:3]:
            print(f"  - {str(it.get('content', ''))[:60]}")
    except Exception as e:
        print(f"查询失败: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sync", "dry-run", "check"])
    ap.add_argument("--days", type=int, default=2)
    args = ap.parse_args()
    if args.cmd == "sync":
        n = sync(args.days, dry=False)
        print(f"同步完成，写入 {n} 条")
    elif args.cmd == "dry-run":
        sync(args.days, dry=True)
    else:
        check()


if __name__ == "__main__":
    main()
