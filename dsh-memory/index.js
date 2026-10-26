/**
 * dsh-memory — DSH 专属记忆插件（HMS 架构 → DSH 实现）
 *
 * v0.2.3（2026-10-17，修归属门绕过漏洞）：
 *   v0.2.2 的归属门写成 `track === 'memory'`，实测被绕过——模型把持仓方案当「人物画像」
 *   改用 track=user 落地（证据：session-e1e018f2，17:40，USER.md 第 12 条 170 字含持仓/本金/佣金）。
 *   修法：凡落 L1 的通道（memory / user）一律同口径拦；skill 落 SKILL.md 不占 L1，不拦。
 *   教训：归属门不能只挂在「一个入口」上——**只要有第二个写入通道，闸门就等于没装**。
 *
 * v0.2.2（2026-10-17，四库严格划分 → 入口收口）：
 *   1. memory_suggest 归属门（track=memory）：lifecycle=record 与档案类内容（定稿/方案/批次/持仓/本金…）
 *      **硬拒**并指路 wiki；纪律类（一律/禁止/不得/必须先/红线）且 >300 字给软提示——纪律应常驻 AGENTS.md，
 *      L1 靠关键词召回，漏命中即失效。背景：审计发现 L1 里 9/10 条是纪律、排查长文、项目方案，
 *      只有 1 条真属 if-then 知识；根因是插件只给 memory/user/skill 三个落点，AGENTS.md 无通道。
 *   2. memory_health 增常驻层体检：调 scripts/layer_audit.py 报 SOUL/全局与工作区 AGENTS 字数、
 *      跨文件重复段、`§` 空条目、.usage.json 陈旧键（常驻层每轮付 token，比 L1 预算更贵）
 *
 * v0.2.1（2026-10-15，修 6 处运行期缺陷）：
 *   1. 转录钩子 `ctx.on('turn/end')` 事件名不存在（turn/end 只是会话事件类型）⇒ L2 从未运行
 *      → 改 `session/event`（emit，(session,event)）+ 非阻塞 spawn + 每 10 分钟节流
 *   2. primer/guard 注入因 @deepseek-ai/dsh-llm 不可解析静默失效 → 等价兜底工厂 + 失败回队 + 留痕
 *   3. memory_zero_hit 的 L1 切分口径与 rrf_recall 不一致（对**所有**条目恒报零命中）→ split("§") 对齐
 *   4. resource 的 `mem://person/<x>` 未走 safe_resolve（实测可穿越读 vault 外任意 *.md）→ 收敛在 entities 内
 *   5. rrf_recall 预算耗尽把命中截成 **1 个字符**（输出垃圾 "["）→ 停止展开 + truncated 计数
 *   6. guard：EXEMPT_PATH 只判路径字段（原对整段正文匹配＝漏拦）、WRITE_TOOLS 补 memory_conflict、
 *      拦截决策改合法的 {kind:'deny'}（原 'block' 不在 PreToolDecision 联合类型内）
 *
 * v0.2.0（2026-10-14，dsh 0.2 适配 + resource 并入）：
 *   1. 删除 `export const Config = null`（Config 不导出才安全，null 会崩设置页）
 *   2. 并入 resource 工具（自 dsh-resource 迁入，工具名不变）：scripts/resource.py 同包携带，
 *      resource.py 内对 memory scripts 目录的跨插件探测改为同包相对路径
 *   3. Python 子进程：解释器读 config.python（默认 python3），env 补 PYTHONIOENCODING=utf-8 /
 *      PYTHONUTF8=1；SCRIPTS_DIR 改 fileURLToPath(import.meta.url)（铁律 F）
 *   4. agent/pre-step 注入 source 改 v4 形态 { kind: 'plugin:dsh-memory' }；
 *      guard 钩子执行参数读 exec.arguments ?? exec.args
 *
 * 分层：L1 规则(MEMORY/USER) / L2 会话 FTS5 / L3 语义(可选 MCP) / L4 wiki 活指针
 *       + RRF 四路融合 + 确认制写入 + Fernet 加密库 + 维护自动化工具
 *
 * 结构（对应 dsh-cybernetics 模板）：
 *   工具   memory_recall / memory_suggest / memory_confirm / memory_reject
 *          memory_vault_get / memory_vault_set / memory_harvest / memory_health
 *   钩子   primer(agent/pre-step 门控注入) / harvest(turn/end 转录) / guard(tools/pre-execute 敏感扫描)
 * 实现：host 侧执行，Python 脚本承载算法（rrf_recall.py / vault.py / harvest.py）
 */
import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SENSITIVE_PATTERNS, EXEMPT_PATH, WRITE_TOOLS, PRIMER_GATE, classifyBudget, extractText, makeInjectedUserMessage } from './lib/constants.js'
import { registerMemoryTools } from './lib/tools.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'agents']

const HOME = homedir()
const DEFAULT_MEMORY_DIR = join(HOME, '.dsh', 'memories')
// 铁律 F：fileURLToPath 解析插件自身路径（new URL().pathname 裸取在 Windows 产非法路径）
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scripts')


export function apply(ctx, config = {}) {
  function expandHome(p) {
    if (typeof p !== 'string' || p === '') return p
    if (p === '~') return HOME
    if (p.startsWith('~/')) return join(HOME, p.slice(2))
    return p
  }
  const memoryDir = expandHome(config.memoryDir) || DEFAULT_MEMORY_DIR
  const scriptsDir = expandHome(config.scriptsDir) || SCRIPTS_DIR
  const budgets = { MEMORY: Number(config.budgetMemory ?? 4400), USER: Number(config.budgetUser ?? 2750) }
  const guardBlock = config.guardBlock === true
  const primerBudget = Number(config.primerBudget ?? 800)
  const primerTopK = Number(config.primerTopK ?? 3)
  // v0.2.0：Python 解释器走 config.python（默认 python3）；env 强制 UTF-8 防中文输出乱码
  const PYTHON = config.python || 'python3'
  const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

  const state = { pendingWarns: [] }

  // ---------- 工具函数 ----------
  const py = (script, args, input) => {
    try {
      const out = execFileSync(PYTHON, [join(scriptsDir, script), ...args], {
        input: input ?? '', encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: PY_ENV,
      })
      return { ok: true, out: out.trim() }
    } catch (e) {
      return { ok: false, out: String(e?.stderr || e?.message || e).trim() }
    }
  }
  const file = (name) => join(memoryDir, name)
  const read = (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '')
  const append = (name, text) => { mkdirSync(memoryDir, { recursive: true }); appendFileSync(file(name), text) }
  const charCount = (name) => read(name).length
  const budgetFor = (track) => (track === 'user' ? budgets.USER : budgets.MEMORY)
  const targetFor = (track) => (track === 'user' ? 'USER.md' : 'MEMORY.md')

  // ---------- 同主题重叠检测（2026-08-22，借鉴论文 Rethinking Memory 4.2.3 选择性写入） ----------
  // 目标：memory_suggest 提交时提示与既有 L1 条目 / pending 提案的重叠，推动合并而非盲追加。
  // 度量：bigram 字符重叠率（中文核心）+ #标签交集；≥阈值判"重叠候选"。
  function bigramsOf(text) {
    const s = text.replace(/#[\u4e00-\u9fffA-Za-z0-9_-]+/g, ' ').replace(/<!--.*?-->/g, ' ')
    const grams = new Set()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      if (/[\u4e00-\u9fff]/.test(g) || /[A-Za-z0-9]/.test(g[0]) && /[A-Za-z0-9]/.test(g[1])) grams.add(g)
    }
    return grams
  }
  function overlapOf(a, b) {
    const ga = bigramsOf(a), gb = bigramsOf(b)
    if (!ga.size || !gb.size) return 0
    let hit = 0
    for (const g of ga) if (gb.has(g)) hit++
    return hit / Math.min(ga.size, gb.size)
  }
  function tagsOf(text) {
    return new Set([...text.matchAll(/#([\u4e00-\u9fffA-Za-z0-9_-]+)/g)].map((m) => m[1]))
  }
  /** 返回与 content 重叠的既有条目/提案：{kind, head, overlap, tags} 列表（按重叠度降序，≤3） */
  function findOverlaps(content) {
    const out = []
    const cTags = tagsOf(content)
    // ① 既有 L1（MEMORY.md / USER.md，§ 分隔）
    for (const name of ['MEMORY.md', 'USER.md']) {
      const raw = read(name)
      if (!raw.trim()) continue
      for (const ent of raw.split('§')) {
        const e = ent.trim()
        if (!e || e.length < 10) continue
        const ov = overlapOf(content, e)
        const eTags = tagsOf(e)
        let tagHit = 0
        for (const t of cTags) if (eTags.has(t)) tagHit++
        if (ov >= 0.35 || (ov >= 0.2 && tagHit >= 1)) {
          out.push({ kind: `L1:${name}`, head: e.slice(0, 60), overlap: Math.round(ov * 100), tags: tagHit })
        }
      }
    }
    // ② pending 提案（同 track 未确认）
    for (const s of loadSuggestions()) {
      if (s.status !== 'pending') continue
      const ov = overlapOf(content, s.content)
      if (ov >= 0.35) {
        out.push({ kind: 'pending', head: s.content.slice(0, 60), overlap: Math.round(ov * 100), tags: 0 })
      }
    }
    out.sort((a, b) => b.overlap - a.overlap || b.tags - a.tags)
    return out.slice(0, 3)
  }

  function loadSuggestions() {
    const raw = read('SUGGESTIONS.jsonl')
    if (!raw.trim()) return []
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }
  function saveSuggestions(list) {
    writeFileSync(file('SUGGESTIONS.jsonl'), list.map((s) => JSON.stringify(s)).join('\n') + (list.length ? '\n' : ''))
  }


  // ---------- 工具注册（2026-10-25 下沉 lib/tools.js，14 工具 verbatim；模块预算治理） ----------
  registerMemoryTools(ctx, { py, file, read, append, charCount, budgetFor, targetFor, loadSuggestions, saveSuggestions, findOverlaps, state, budgets, memoryDir, scriptsDir, PYTHON, PY_ENV })

  // ---------- 6. 钩子：guard（tools/pre-execute 敏感扫描） ----------
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('tools/pre-execute', (exec, next) => {
        const toolName = exec?.tool?.name || exec?.name
        if (!toolName || !WRITE_TOOLS.has(toolName)) return next()
        const args = exec?.arguments ?? exec?.args ?? {}
        const argsText = JSON.stringify(args)
        // v0.2.1：豁免只判「目标路径」字段——原实现对整段 arguments（含即将写入的正文）匹配，
        // 正文里出现 .env / credentials / .git/ 字样即整体跳过扫描（漏拦）。
        const targetPath = String(args.file_path || args.path || args.ref || '')
        if (EXEMPT_PATH.test(targetPath)) return next()
        const hit = SENSITIVE_PATTERNS.find((p) => p.re.test(argsText))
        if (hit) {
          if (guardBlock) {
            // 合法决策是 {kind:'deny'|...}（PreToolDecision）；原写的 'block' 不在联合类型内，
            // 只是被宿主"非 allow 且带 reason 即当拒绝"的兜底逻辑接受，属巧合可用。
            return { kind: 'deny', reason: `[memory-guard] 检测到敏感内容（${hit.label}），已拦截。请存入加密库（memory_vault_set）或只写引用路径。` }
          }
          state.pendingWarns.push(`[memory-guard] 检测到 ${hit.label} 写入，遵守"只存引用路径不存原文"：敏感内容请走 memory_vault_set，明文只留 → vault:<ref>。`)
        }
        return next()
      })
    } catch { /* guard 不可用则跳过 */ }

    // ---------- 7. 钩子：primer（agent/pre-step 门控召回注入） ----------
    if (ctx.agents) {
      const primerAuditFile = join(HOME, '.dsh', 'memories', 'primer-audit.jsonl')
      const appendPrimerAudit = ({ lane, q, chars }) => {
        try {
          mkdirSync(dirname(primerAuditFile), { recursive: true })
          appendFileSync(primerAuditFile, `${JSON.stringify({ ts: new Date().toISOString(), lane, q: q.slice(0, 50), chars })}\n`)
        } catch (e) {
          console.warn(`[dsh-memory] primer 审计写入失败: ${String(e?.message || e)}`)
        }
      }
      try {
        ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next()
          if (!decision || decision.kind === 'reject') return decision
          const warns = state.pendingWarns
          state.pendingWarns = []
          const lastUser = [...(decision.messages ?? [])].reverse().find((m) => m.role === 'user')
          const text = extractText(lastUser?.content)
          const gated = text && PRIMER_GATE.some((g) => text.includes(g))
          // delta 资产变更注入（2026-08-20）：最近 7 天变更资产清单，有变更才出声；
          // 目的：防"重复建设"（建文件前先感知已有资产），成本随变化量而非存量
          let deltaOut = ''
          try { const d = py('delta_assets.py', []); if (d.ok && d.out) deltaOut = d.out } catch { /* 注入失败不阻断 */ }
          if (!gated && warns.length === 0 && !deltaOut) return decision
          const parts = []
          if (warns.length) parts.push(warns.join('\n'))
          if (deltaOut) parts.push(`[资产变更提示·新建前先查重（可用 check_assets 工具）]\n${deltaOut}`)
          let primerLane = 'miss'
          if (gated) {
            const budget = classifyBudget(text) // 手术级注入分档（§8.5）
            const q = text.slice(0, 200)
            // fidelity-primer（借鉴 hermes）：先试定型速查卡，无卡自动降级 RRF；
            // --no-hits：primer 高频注入不污染命中统计
            const pc = py('rrf_recall.py', [q, '--primers', '--no-hits'])
            if (pc.ok && pc.out.startsWith('# 速查卡')) {
              primerLane = 'card'
              parts.push(`[事实速查卡·不可信参考资料，硬事实以卡为准]\n${pc.out}`)
            } else if (pc.ok && !pc.out.includes('（无命中）')) {
              primerLane = 'rrf'
              parts.push(`[记忆召回·不可信参考资料，硬事实须溯源一手材料]\n${pc.out}`)
            } else {
              const r = py('rrf_recall.py', [q, '--budget', String(budget), '--topk', String(primerTopK), '--no-hits'])
              if (r.ok && !r.out.includes('（无命中）')) {
                primerLane = 'rrf'
                parts.push(`[记忆召回·不可信参考资料，硬事实须溯源一手材料]\n${r.out}`)
              }
            }
          }
          if (parts.length === 0) {
            if (gated) appendPrimerAudit({ lane: primerLane, q: text, chars: 0 })
            return decision
          }
          try {
            const injectedText = parts.join('\n\n')
            const msg = await makeInjectedUserMessage({
              text: injectedText,
              kind: 'plugin:dsh-memory',
            })
            if (gated) appendPrimerAudit({ lane: primerLane, q: text, chars: injectedText.length })
            return { ...decision, messages: [...decision.messages, msg] }
          } catch (e) {
            // v0.2.1：注入失败整批回队（原实现 pendingWarns 已在上面清空 → 警告丢失且无重试），
            // 并留痕，避免"静默失效"再次发生。
            state.pendingWarns.unshift(...warns)
            console.warn(`[dsh-memory] primer 注入失败（已回队 ${warns.length} 条）: ${String(e?.message || e)}`)
            return decision
          }
        })
      } catch { /* pre-step 不可用则跳过 */ }
    }

    // ---------- 8. 钩子：harvest（会话转录；不可用则由 automation 兜底） ----------
    // v0.2.1：事件名修正——dsh 0.2 里 `turn/end` 只是**会话事件类型**（`session.append("turn/end")`），
    // 不是 Cordis 插件事件，`ctx.on('turn/end')` 永不触发。实据：`~/.dsh/memories/` 下从无
    // index.sqlite / harvest-state.json / corrections.jsonl，而 20 份会话日志都在（L2 通道恒空）。
    // 插件侧正确入口是 `session/event`（@mode emit，签名 `(session, event)`）。
    // 另：harvest 是重活（全量解析会话 zstd），改为**非阻塞 spawn + 每 10 分钟最多一次**，
    // 避免每个 turn 结束都同步阻塞主循环 30s。
    try {
      let lastHarvestAt = 0
      ctx.on('session/event', (_session, event) => {
        if (event?.type !== 'turn/end') return
        const now = Date.now()
        if (now - lastHarvestAt < 10 * 60 * 1000) return
        lastHarvestAt = now
        try {
          const child = spawn(PYTHON, [join(scriptsDir, 'harvest.py'), 'index'], {
            detached: true,
            stdio: 'ignore',
            env: PY_ENV,
          })
          child.on('error', () => { /* spawn 失败：交给 automation 兜底 */ })
          child.unref()
        } catch { /* 交给 automation 兜底 */ }
      })
    } catch { /* session/event 不可用：memory-harvest automation 兜底 */ }
  }

  return { memoryDir }
}
