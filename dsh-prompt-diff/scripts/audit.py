#!/usr/bin/env python3
"""prompt-diff 上下文影响检测器（dsh-prompt-diff/scripts/audit.py）

回答一个问题：dsh-prompt-diff 的缩略注入，到底把上下文改成了什么样、
有没有缩掉不该缩的东西。

它只读会话记录（~/.dsh/sessions/**/session.v4.jsonl.zstd），不改任何状态。

用法：
    python3 audit.py                  # 近 7 天
    python3 audit.py --days 0         # 全量历史（慢）
    python3 audit.py --session <id前缀>
    python3 audit.py --json           # 结构化输出

判据说明：
    · 缩略行自带「共 N 字符」，所以原文体积可从缩略行反推，无需原文。
    · 风险判定对照插件当前 cordis.patch.yml 的 skipNames/minChars：
      HIGH  = 缩略了本该保留的块（策略/工具/技能/运行时块）
      MED   = 缩略行指路指向已退役工具（resource / check_assets，随 dsh-memory 退役）
    · 解析失败一律计数并报出，不静默。

退出码：0 = 无 HIGH；1 = 存在 HIGH（可挂到定时任务做告警）。
"""
import argparse
import collections
import datetime
import json
import os
import re
import subprocess
import sys

SESS_DIR = os.path.expanduser('~/.dsh/sessions')
PLUGIN_DIR = os.path.expanduser('~/dsh-plugins/dsh-prompt-diff')
PATCH = os.path.join(PLUGIN_DIR, 'cordis.patch.yml')

# 缩略行形如：
# [prompt-diff] 「tool:goal」内容未变（hash 1a2b3c4d，上次变更 2026-10-31 15:04，共 3120 字符）。需要时…
HINT_RE = re.compile(r'\[prompt-diff\] 「([^」]+)」内容未变（hash ([0-9a-f]{6,})，上次变更 ([^，]+)，共 (\d+) 字符）')
DEAD_RE = re.compile(r'resource|check_assets')

DEFAULT_SKIP = ['persona', 'harness:identity', 'instructions']


def load_plugin_config():
    """从插件 patch 读当前 skipNames / minChars；解析失败回落默认值并告警。"""
    cfg = {'skipNames': list(DEFAULT_SKIP), 'minChars': None, 'source': 'default'}
    try:
        raw = open(PATCH, encoding='utf-8').read()
    except OSError as e:
        return cfg, f'读不到 {PATCH}: {e}'
    try:
        import yaml
        d = yaml.safe_load(raw)
        c = d[0]['insert'][0]['config']
        cfg['skipNames'] = list(c.get('skipNames') or DEFAULT_SKIP)
        cfg['minChars'] = c.get('minChars')
        cfg['source'] = 'yaml'
    except Exception as e:
        # 无 pyyaml 或结构变化：退化为正则抓 skipNames 列表项
        m = re.search(r'skipNames:\s*(\[[^\]]*\]|(?:\n\s*-\s*.+)+)', raw)
        if m:
            items = re.findall(r"'([^']+)'|\"([^\"]+)\"|-\s*([^,\]\n]+)", m.group(1))
            flat = [(a or b or c).strip() for a, b, c in items]
            cfg['skipNames'] = [x for x in flat if x] or list(DEFAULT_SKIP)
            cfg['source'] = 'regex'
        else:
            return cfg, f'patch 解析失败({e})，回落默认 skipNames'
    return cfg, None


def sys_text(evt):
    """取 system/message 的正文。"""
    try:
        c = evt['data']['message']['content']
    except Exception:
        return ''
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ''.join(b.get('text', '') for b in c if isinstance(b, dict))
    return ''


def scan(days, session_filter=None):
    cutoff = 0 if not days else (datetime.datetime.now().timestamp() - days * 86400)
    files = []
    for root, _, fs in os.walk(SESS_DIR):
        for f in fs:
            if not f.endswith('.zstd'):
                continue
            p = os.path.join(root, f)
            if cutoff and os.path.getmtime(p) < cutoff:
                continue
            if session_filter and session_filter not in p:
                continue
            files.append(p)
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=7, help='扫描近 N 天（0=全部）')
    ap.add_argument('--session', default=None, help='只扫会话 id/目录名含该串的')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--top', type=int, default=12)
    args = ap.parse_args()

    cfg, warn = load_plugin_config()
    skip = cfg['skipNames']
    files = scan(args.days, args.session)

    blocks = collections.Counter()        # 块名 -> 缩略次数
    chars = collections.Counter()         # 块名 -> 缩略时原文总字符
    by_day = collections.Counter()        # 日期 -> 缩略行数
    sessions = []                         # 每会话摘要
    high = []                             # 缩了不该缩的
    med = set()                           # 死链指路会话（按会话去重）
    parse_fail = 0
    zstd_fail = 0

    for p in files:
        try:
            raw = subprocess.run(['zstdcat', p], capture_output=True, timeout=120).stdout.decode('utf-8', 'replace')
        except Exception:
            zstd_fail += 1
            continue
        if '[prompt-diff]' not in raw:
            continue
        created = None
        cwd = ''
        for line in raw.split('\n')[:2]:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get('type') == 'session':
                created = d.get('createdAt')
                cwd = d.get('cwd', '') or ''
        day = datetime.datetime.fromtimestamp(created / 1000).strftime('%Y-%m-%d') if created else '未知'
        n_hint = 0
        saved = 0
        for line in raw.split('\n'):
            if '[prompt-diff]' not in line:
                continue
            for m in HINT_RE.finditer(line):
                name, _h, _ts, n = m.group(1), m.group(2), m.group(3), int(m.group(4))
                blocks[name] += 1
                chars[name] += n
                n_hint += 1
                saved += n
                by_day[day] += 1
            if '[prompt-diff]' in line and not HINT_RE.search(line) and '"system/message"' in line:
                parse_fail += 1
            if DEAD_RE.search(line) and '[prompt-diff]' in line:
                med.add(p.split('/')[-2][:18])
        # system prompt 体积曲线（step 级）
        curve = []
        for line in raw.split('\n'):
            if '"system/message"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get('type') != 'system/message':
                continue
            t = sys_text(d)
            if not t:
                continue
            curve.append((d['data'].get('step'), len(t), '[prompt-diff]' in t))
        if n_hint:
            sessions.append({'id': p.split('/')[-2][:18], 'day': day, 'cwd': os.path.basename(cwd),
                             'hints': n_hint, 'orig_chars': saved, 'curve': curve})

    for name in blocks:
        if any(kw in name for kw in skip):
            high.append(name)

    summary = {
        'scan_days': args.days,
        'files': len(files),
        'sessions_with_hints': len(sessions),
        'hint_lines': sum(blocks.values()),
        'orig_chars_shortened': sum(chars.values()),
        'skipNames': skip,
        'minChars': cfg['minChars'],
        'config_source': cfg['source'],
        'parse_fail': parse_fail,
        'zstd_fail': zstd_fail,
        'high_risk_blocks': sorted(high),
        'dead_ref_sessions': len(med),
    }

    if args.json:
        out = dict(summary)
        out['blocks'] = [{'name': k, 'hints': v, 'orig_chars': chars[k]} for k, v in blocks.most_common(args.top)]
        out['by_day'] = dict(sorted(by_day.items()))
        out['sessions'] = [{k: v for k, v in s.items() if k != 'curve'} for s in sessions[:args.top]]
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 1 if high else 0

    # ---- Markdown 报告 ----
    print('# prompt-diff 上下文影响检测报告')
    print(f"\n扫描：近 {args.days or '全部'} 天，命中文件 {len(files)} 个"
          f"（zstd 读取失败 {zstd_fail}，缩略行解析失败 {parse_fail}）")
    print(f"当前配置：minChars={cfg['minChars']}，skipNames={skip}（来源 {cfg['source']}）")
    if warn:
        print(f"⚠️ {warn}")
    print(f"\n- 有缩略的会话：**{len(sessions)}**")
    print(f"- 缩略行总数：**{sum(blocks.values())}**")
    print(f"- 累计跳过注入：**{sum(chars.values()):,} 字符**（同一块每步各计一次；≈{sum(chars.values())//3:,} 汉字当量）")
    print(f"- 死链指路会话（含 resource/check_assets）：**{len(med)}**")

    print(f"\n## 被缩略的块（top {args.top}）\n")
    print('| 块名 | 次数 | 原文合计字符 | 当前是否该保留 |')
    print('|---|---:|---:|---|')
    for name, cnt in blocks.most_common(args.top):
        flag = '⚠️ 应保留' if name in high else '可缩'
        print(f'| `{name}` | {cnt} | {chars[name]:,} | {flag} |')

    print('\n## 按日期\n')
    for d, c in sorted(by_day.items()):
        print(f'- {d}: {c}')

    if sessions:
        print(f"\n## 会话明细（top {args.top}）\n")
        print('说明：累计跳过量 = 该会话内每次缩略所省字符的累加（同一块每步各算一次）；现值 = 该会话最后一条 system prompt 的字符数。\n')
        print('| 会话 | 日期 | 工作区 | 缩略行 | 累计跳过字符 | 平均每行 | 现值 |')
        print('|---|---|---|---:|---:|---:|---:|')
        for s in sorted(sessions, key=lambda x: -x['hints'])[:args.top]:
            cur = s['curve']
            last = cur[-1][1] if cur else 0
            per = s['orig_chars'] // max(s['hints'], 1)
            print(f"| `{s['id']}` | {s['day']} | {s['cwd'][:18]} | {s['hints']} | {s['orig_chars']:,} | "
                  f"{per:,} | {last} |")

    print('\n## 结论\n')
    if high:
        print(f'**存在高危：{len(high)} 个块本该保留却被缩略** → ' + '、'.join(f'`{x}`' for x in high))
        print('处置：把对应关键词并入 `skipNames`，或提高 `minChars`。')
    else:
        print('**无高危**：当前 skipNames 已覆盖实际发生的缩略块。')
    if med:
        print(f'\n另有 {len(med)} 个会话的缩略行带死链指路（`resource`/`check_assets` 已随 dsh-memory 退役）——'
              '这些是改动前的历史记录，改动后的新会话应不再出现。')
    return 1 if high else 0


if __name__ == '__main__':
    sys.exit(main())
