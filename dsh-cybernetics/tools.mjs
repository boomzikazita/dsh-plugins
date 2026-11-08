// dsh-cybernetics — 工具注册（v5.0）
//
// 5 个工具：
//   cybernetics_status   会话状态 + 跨会话工具可靠性（λ / CI / MTBF / 故障类型 / 重试预算）
//   cybernetics_snap     把当前事实写入日志并回读摘要
//   cybernetics_rollup   跨会话汇总（第二十一章：多级结构的上层协调）
//   cybernetics_check    工具可用性自检（能力清单；不再叫"能控性"）
//   cybernetics_sandbox_mode  切换会话文件沙箱（保留的宿主能力）
import { existsSync, readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VERSION } from './core.mjs'
import { rateEstimate, toolEstimates, toolLine, rollupRecords } from './reliability.mjs'

const fmtPct = (x, d = 1) => `${(x * 100).toFixed(d)}%`
const fmtCI = (lo, hi) => `[${fmtPct(lo)}, ${fmtPct(hi)}]`

function readLogLines(logFile, maxLines) {
  const files = []
  for (let i = 3; i >= 1; i -= 1) files.push(`${logFile}.${i}`)
  files.push(logFile)
  const lines = []
  for (const f of files) {
    if (!existsSync(f)) continue
    try {
      lines.push(...readFileSync(f, 'utf8').split('\n').filter(Boolean))
    } catch { /* 单个文件不可读就跳过 */ }
  }
  return lines.slice(-maxLines)
}

function parseLines(lines) {
  const out = []
  for (const l of lines) {
    try { out.push(JSON.parse(l)) } catch { /* 坏行跳过 */ }
  }
  return out
}

export function registerCyberneticsTools(ctx, d) {
  const { cfg, state, logState, sessionOf, sidOf, logFile, slowestTools } = d

  // ---------- cybernetics_status ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_status',
    description: '读取本会话状态与跨会话工具可靠性：λ 失败率及 95% 置信区间、MTBF、故障类型构成、重试可恢复上限、浪费重试、逻辑告警态。',
    parameters: {
      n: { type: 'number', description: '（兼容保留，已不用）' },
    },
    output: {
      schema: { type: 'string', description: '状态摘要文本' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const s = sessionOf(exec)
      const rel = state.reliability
      const est = rateEstimate(rel.k, rel.n)
      const lines = [
        `[cybernetics] 状态 v${VERSION}（逻辑控制 + 可靠性）`,
        `session=${sidOf(exec)}`,
        `调用/结果: ${s.preExecCount}/${s.resultCount}` +
          (s.preExecCount > 0 && s.resultCount !== s.preExecCount
            ? `（未配对 ${Math.abs(s.preExecCount - s.resultCount)}）` : ''),
        `逻辑状态: alarm=${s.logic.alarmActive ? 'active' : 'idle'}  连续失败 ${s.logic.failStreak}/${cfg.logic.failStreak}` +
          `（确定性阈值 ${cfg.logic.deterministicStreak}）  连续成功 ${s.logic.okStreak}/${cfg.logic.recoverStreak}` +
          `  重复计数 ${s.logic.repeatCount}/${cfg.logic.repeatAlarm}`,
        `本会话告警注入: ${s.alarmsInjected} 条  浪费重试: ${s.wastedRetries}`,
        `可靠性（跨会话样本 n=${est.n}）: 失败 ${est.k}  λ=${fmtPct(est.rate)} ${fmtCI(est.lo, est.hi)}` +
          `  MTBF=${est.mtbf == null ? '—' : est.mtbf.toFixed(1)} 次/失败`,
        `故障类型: 暂态 ${rel.kinds.transient}  确定性 ${rel.kinds.deterministic}  可纠正 ${rel.kinds.agent}` +
          `  致命 ${rel.kinds.fatal}  未归类 ${rel.kinds.unknown}`,
      ]
      const rows = toolEstimates(rel, { minSamples: cfg.reliability.minSamples, limit: 8 })
      if (rows.length) {
        lines.push('按工具（λ 降序）:')
        for (const row of rows) lines.push('  ' + toolLine(row.tool, row, { budget: cfg.reliability.retryBudget }))
      } else {
        lines.push(`按工具: 样本不足（每种工具至少 ${cfg.reliability.minSamples} 次）`)
      }
      const slow = slowestTools(s)
      lines.push(`本会话最慢: ${slow.length ? slow.map((t) => `${t.tool}(${t.avgMs}ms×${t.count})`).join(' ') : '—'}`)
      lines.push(`废重试: ${state.wastedRetries ?? 0}（跨会话累计，确定性/致命失败后原样重试）`)
      if (state.recovered) {
        lines.push(`启动回放: 结果 ${state.recovered.results} 条 / 会话 ${state.recovered.sessions} 个 / 已知工具 ${state.recovered.tools} 个`)
      }
      return lines.join('\n')
    },
  }))

  // ---------- cybernetics_snap ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_snap',
    description: '把当前会话状态与可靠性摘要写入状态日志（snap 事件）并返回一行确认。',
    parameters: {},
    output: {
      schema: { type: 'string', description: '快照确认' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const s = sessionOf(exec)
      const rel = state.reliability
      const snap = {
        ts: Date.now(),
        event: 'snap',
        sid: sidOf(exec),
        version: VERSION,
        logic: {
          alarmActive: s.logic.alarmActive,
          failStreak: s.logic.failStreak,
          okStreak: s.logic.okStreak,
          repeatCount: s.logic.repeatCount,
          alarmsTotal: s.logic.alarmsTotal,
        },
        session: {
          preExec: s.preExecCount,
          results: s.resultCount,
          alarmsInjected: s.alarmsInjected,
          wastedRetries: s.wastedRetries,
          observedTools: s.sessionObserved.size,
          slowest: slowestTools(s),
        },
        reliability: {
          n: rel.n,
          k: rel.k,
          kinds: rel.kinds,
          wastedRetries: state.wastedRetries ?? 0,
        },
      }
      logState(snap)
      return `[cybernetics] 快照已写入 sid=${sidOf(exec)}  n=${rel.n} 失败=${rel.k} 告警=${s.alarmsInjected} 浪费重试=${s.wastedRetries}`
    },
  }))

  // ---------- cybernetics_rollup ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_rollup',
    description: '跨会话汇总（多级结构的上层协调）：读状态日志，按时间窗统计会话/调用/失败率及置信区间、按工具的 λ、故障类型构成、告警、浪费重试与最慢工具。',
    parameters: {
      days: { type: 'number', description: '回看天数，默认 7' },
      limit: { type: 'number', description: '最多读取日志行数，默认 5000' },
    },
    output: {
      schema: { type: 'string', description: '跨会话汇总文本' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input) {
      const days = Number.isFinite(input?.days) ? Math.max(0, input.days) : 7
      const limit = Number.isFinite(input?.limit) ? Math.max(100, input.limit) : 5000
      const since = Date.now() - days * 24 * 3600 * 1000
      const records = parseLines(readLogLines(logFile, limit))
      const r = rollupRecords(records, { since })
      const est = rateEstimate(r.rel.k, r.rel.n)
      const lines = [
        `[cybernetics] 跨会话汇总 v${VERSION}（最近 ${days} 天）`,
        `会话 ${r.sessions}  调用 ${r.res}  失败 ${r.rel.k}  λ=${fmtPct(est.rate)} ${fmtCI(est.lo, est.hi)}` +
          `  MTBF=${est.mtbf == null ? '—' : est.mtbf.toFixed(1)} 次/失败`,
        `未配对调用: ${r.unpaired}${r.pre > 0 ? `（${fmtPct(r.unpaired / r.pre)}）` : ''}  浪费重试: ${r.wastedRetries}`,
        `故障类型: 暂态 ${r.rel.kinds.transient}  确定性 ${r.rel.kinds.deterministic}  可纠正 ${r.rel.kinds.agent}` +
          `  致命 ${r.rel.kinds.fatal}  未归类 ${r.rel.kinds.unknown}`,
        `告警: ${Object.keys(r.alarms).length ? Object.entries(r.alarms).map(([k, v]) => `${k} ${v}`).join('  ') : '无'}`,
      ]
      const rows = toolEstimates(r.rel, { minSamples: cfg.reliability.minSamples, limit: 10 })
      if (rows.length) {
        lines.push('按工具:')
        for (const row of rows) lines.push('  ' + toolLine(row.tool, row, { budget: cfg.reliability.retryBudget }))
      } else {
        lines.push('按工具: 样本不足')
      }
      if (r.slowest.length) {
        lines.push(`最慢: ${r.slowest.map((t) => `${t.tool}(${t.avgMs}ms×${t.count})`).join(' ')}`)
      }
      return lines.join('\n')
    },
  }))

  // ---------- cybernetics_check ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_check',
    description: '工具可用性自检（能力清单）：给定目标与所需工具，对照当前可用工具（插件工具 ∪ 观测记忆），返回 missing / 可用 / 未实测。',
    parameters: {
      goal: { type: 'string', required: true, description: '当前目标描述' },
      requiredTools: { type: 'array', items: { type: 'string' }, description: '所需工具名数组' },
    },
    output: {
      schema: { type: 'string', description: '工具可用性自检结论' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const goal = input?.goal || '（未提供目标）'
      const required = Array.isArray(input?.requiredTools) ? input.requiredTools : []
      const s = sessionOf(exec)
      const collect = (scope) => {
        try {
          const list = ctx.tools?.schemas?.(scope)
          return Array.isArray(list) ? list.map((t) => t.name).filter(Boolean) : []
        } catch {
          return []
        }
      }
      const pluginTools = [...new Set([...collect(exec?.agent), ...collect(undefined)])]
      const known = new Set([...pluginTools, ...state.observedTools])
      const missing = required.filter((t) => !known.has(t))
      const unobserved = required.filter((t) => known.has(t) && !pluginTools.includes(t) && !s.sessionObserved.has(t))
      const ok = missing.length === 0
      return [
        '[cybernetics] 工具可用性自检',
        `目标: ${goal}`,
        `所需工具(${required.length}): ${required.join(', ') || '无'}`,
        `已知工具(${known.size}): ${[...known].join(', ') || '无'}`,
        `未实测（本会话）: ${unobserved.join(', ') || '无'}`,
        `missing: ${missing.join(', ') || '无'}`,
        `结论: ${ok ? (unobserved.length ? '可用（含未实测提示）' : '可用') : '缺工具'}`,
        ok ? 'advice: 所需工具齐备。' : `advice: 缺少 ${missing.join(', ')}；先找替代能力或向用户说明受限。`,
      ].join('\n')
    },
  }))

  // ---------- cybernetics_sandbox_mode（保留的宿主能力） ----------
  // 提权走宿主审批门：tools/pre-execute 对该工具返回 {kind:'ask'}，批准后才执行。
  ctx.tools.register(defineTool({
    name: 'cybernetics_sandbox_mode',
    description: '切换当前会话的 DSH 文件沙箱模式（per-session，重启后保留）：workspace-write（默认）/ danger-full-access（免沙箱拦截）/ read-only。提权到 danger-full-access 会触发宿主审批门，需用户批准；降级立即生效。',
    parameters: {
      mode: { type: 'string', required: true, description: '目标沙箱模式：read-only / workspace-write / danger-full-access' },
    },
    output: {
      schema: { type: 'string', description: '切换结果' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const mode = input?.mode
      const VALID = ['read-only', 'workspace-write', 'danger-full-access']
      if (!VALID.includes(mode)) throw new Error(`invalid mode "${mode}": must be one of ${VALID.join(' / ')}`)
      const session = exec?.agent?.session
      if (!session) throw new Error('no session available to switch sandbox mode')
      session.append('sandbox/mode', { mode })
      try { sessionOf(exec).sandboxMode = mode } catch { /* 状态不可用不影响切换 */ }
      const tip = mode === 'danger-full-access'
        ? '写全放开：任意目录可写（含 Obsidian 等工作区外）。'
        : mode === 'workspace-write'
          ? '默认模式：可写工作区 + 临时区；工作区外写/删触发沙箱拒绝。'
          : '只读：所有文件变更被拒，读取不受影响。'
      logState({ ts: Date.now(), event: 'sandbox-mode-switch', sid: sidOf(exec), mode })
      return `[cybernetics] 会话沙箱模式已切换为 ${mode}\n${tip}`
    },
  }))
}
