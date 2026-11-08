// dsh-cybernetics — 运行时辅助（v5.0）：日志轮转、启动回放、verify-on-stop、浪费重试
//
// 这里不再有"控制律"。留下的是三件工程事务：
//   1) 观测持久化（JSONL + 轮转），让跨会话汇总有数据源（第二十一章）；
//   2) 启动回放：从最近日志重建工具可靠性计数，否则每次重启 λ 归零；
//   3) 自检与冗余口径：verify-on-stop（写后必读）与 wasted-retry（确定性失败后原样重试）。
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { recordResult } from './reliability.mjs'

export const WRITE_TOOLS = new Set(['write', 'edit'])
export const VERIFY_TOOLS = new Set(['read', 'grep', 'glob', 'read_image', 'ops_inspect_local_file', 'ops_grep', 'ops_glob'])

export function makeRuntime({ cfg, state, logFile }) {
  // ---------- 日志轮转 ----------
  function rotateIfNeeded() {
    const maxBytes = cfg.log?.maxBytes ?? 8 * 1024 * 1024
    const keep = Math.max(1, cfg.log?.keep ?? 3)
    try {
      if (!existsSync(logFile)) return false
      if (statSync(logFile).size < maxBytes) return false
      for (let i = keep - 1; i >= 1; i -= 1) {
        const src = `${logFile}.${i}`
        if (existsSync(src)) renameSync(src, `${logFile}.${i + 1}`)
      }
      renameSync(logFile, `${logFile}.1`)
      return true
    } catch {
      return false
    }
  }

  // ---------- 告警队列入队（agent/pre-step 合并注入） ----------
  function queueWarn(s, text) {
    s.pendingWarns.push(text)
  }

  // ---------- 最慢工具 TOP（可靠性观测，不是"性能控制"） ----------
  function slowestTools(s, top = 3) {
    return [...s.toolDurations.entries()]
      .map(([tool, { totalMs, count }]) => ({ tool, avgMs: Math.round(totalMs / Math.max(1, count)), count }))
      .sort((x, y) => y.avgMs - x.avgMs)
      .slice(0, top)
  }

  // ---------- verify-on-stop（第十九章"自检"；原 v4.5 机制保留） ----------
  function trackWriteVerify(s, toolName) {
    if (WRITE_TOOLS.has(toolName)) s.turnWrites.push(toolName)
    else if (VERIFY_TOOLS.has(toolName)) s.turnVerifies += 1
  }

  function verifyOnStopWarn(s) {
    if (s.turnWrites.length === 0 || s.turnVerifies > 0) return null
    // 单次 write 多为新建文件，本无覆盖风险；edit 或成批写入才提醒
    const hasEdit = s.turnWrites.includes('edit')
    if (!hasEdit && s.turnWrites.length < 2) return null
    return `[verify-on-stop] 上一轮有 ${s.turnWrites.length} 次文件写入（${[...new Set(s.turnWrites)].join('/')}）但无任何回读验证（read/grep/glob）。完成声明前请回读目标文件确认落盘内容——「写了但没验证」属降级报告。`
  }

  // ---------- 浪费重试：确定性/致命失败之后又原样重试同一次调用 ----------
  function noteCall(s, { tool, sig, failed, kind, ts }) {
    const nonRetryable = !!failed && (kind === 'deterministic' || kind === 'fatal')
    const prev = s.lastCall
    const wasted = !!(failed && nonRetryable && prev && prev.failed && prev.sig === sig)
    if (wasted) {
      s.wastedRetries += 1
      state.wastedRetries = (state.wastedRetries ?? 0) + 1
    }
    s.lastCall = { sig, tool, failed: !!failed, kind: kind ?? null, nonRetryable, ts: ts ?? Date.now() }
    return wasted
  }

  // ---------- 启动回放：重建工具可靠性计数（跨重启不丢样本） ----------
  function recoverFromLog(observedTools, maxLines = 800) {
    try {
      if (!existsSync(logFile)) return null
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-maxLines)
      let results = 0
      let lastTs = 0
      const sessions = new Set()
      for (const line of lines) {
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e.event === 'boot') continue
        if (e.sid) sessions.add(e.sid)
        if (e.event !== 'result') continue
        const tool = e.tool || 'unknown'
        const failed = e.failed === true || e.delta === 1
        recordResult(state.reliability, tool, failed, failed ? e.kind : null)
        observedTools.add(tool)
        results += 1
        if (Number.isFinite(e.ts)) lastTs = e.ts
      }
      if (results === 0) return null
      return { entries: lines.length, results, sessions: sessions.size, tools: observedTools.size, lastTs }
    } catch {
      return null
    }
  }

  return { rotateIfNeeded, queueWarn, slowestTools, trackWriteVerify, verifyOnStopWarn, noteCall, recoverFromLog }
}
