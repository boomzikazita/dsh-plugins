/**
 * dsh-cybernetics — 逻辑控制 + 可靠性运行时（v5.0）
 *
 * 2026-11-08 重构，对照《工程控制论》（钱学森/宋健·第三版）：
 *   第十七章 逻辑控制/有限自动机 → logic.mjs：0/1 序列上的显式状态机、滞环、单次告警
 *   第十九章 冗余技术和容错系统   → reliability.mjs：λ、MTBF、k/N 冗余、故障分类、自检
 *   第二十一章 大系统             → cybernetics_rollup：下层会话自治、上层跨会话汇总
 *   删除：EMA/pHat、档位机、稳定阀、熵、振荡、healthScore、adaptiveAlpha、前馈规则表。
 *   删除理由：那些是给有运动方程的物理受控对象用的（第一至十五章），agent 的工具调用
 *   是离散逻辑序列（第十七章）与可靠性问题（第十九章），套错了章节。
 *
 * 保留：verify-on-stop（第十九章自检）、sandbox_mode（宿主能力）、JSONL 观测与轮转。
 */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { VERSION, BASH_TOOLS, bashExitDelta, callSignature, textContentOf, execArgsText } from './core.mjs'
import { classifyFault, classifyBashExit, createReliability, recordResult, DEFAULT_RETRY_BUDGET } from './reliability.mjs'
import { step as logicStep, DEFAULT_LOGIC } from './logic.mjs'
import { createSessionState, makeInjectedUserMessage } from './state.mjs'
import { makeRuntime } from './runtime.mjs'
import { registerCyberneticsTools } from './tools.mjs'

export const name = 'dsh-cybernetics'
export const inject = ['tools', 'agents']

export function apply(ctx, config = {}) {
  function expandHome(p) {
    if (typeof p !== 'string' || p === '') return p
    if (p === '~') return homedir()
    if (p.startsWith('~/')) return join(homedir(), p.slice(2))
    return p
  }

  const stateLogPath = expandHome(config.stateLog) || resolve(homedir(), '.dsh', 'cybernetics', 'state_log.ndjson')
  const cfg = {
    stateLog: stateLogPath,
    observedToolsFile: expandHome(config.observedToolsFile) || join(dirname(stateLogPath), 'observed_tools.json'),
    logic: { ...DEFAULT_LOGIC, ...(config.logic ?? {}) },
    reliability: {
      minSamples: config.reliability?.minSamples ?? 5,
      retryBudget: { ...DEFAULT_RETRY_BUDGET, ...(config.reliability?.retryBudget ?? {}) },
    },
    log: {
      maxBytes: config.log?.maxBytes ?? 8 * 1024 * 1024,
      keep: config.log?.keep ?? 3,
    },
  }
  const logFile = resolve(cfg.stateLog)

  // ---------- 全局状态（跨会话） ----------
  const state = {
    totalToolCalls: 0,
    observedTools: new Set(['cybernetics_status', 'cybernetics_snap', 'cybernetics_rollup', 'cybernetics_check', 'cybernetics_sandbox_mode']),
    obsPersistedSize: 0,
    bySession: new Map(),
    reliability: createReliability(),
    wastedRetries: 0,
    recovered: null,
  }

  // 观测记忆：冷启动或缺工具时避免误报
  try {
    if (existsSync(cfg.observedToolsFile)) {
      const remembered = JSON.parse(readFileSync(cfg.observedToolsFile, 'utf8'))
      if (Array.isArray(remembered)) for (const t of remembered) if (typeof t === 'string') state.observedTools.add(t)
    }
  } catch { /* 记忆损坏则从空开始 */ }
  state.obsPersistedSize = state.observedTools.size

  function persistObservedTools() {
    try {
      mkdirSync(dirname(cfg.observedToolsFile), { recursive: true })
      writeFileSync(cfg.observedToolsFile, JSON.stringify([...state.observedTools].sort()))
      state.obsPersistedSize = state.observedTools.size
    } catch { /* 持久化失败不阻断观测 */ }
  }

  const rt = makeRuntime({ cfg, state, logFile })

  let appends = 0
  function logState(entry) {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, JSON.stringify(entry) + '\n')
      appends += 1
      if (appends % 200 === 0) rt.rotateIfNeeded()
    } catch { /* 观测失败不阻断业务 */ }
  }

  // ---------- 会话路由 ----------
  function sidOf(exec) {
    return exec?.agent?.session?.id ?? exec?.session?.id ?? 'global'
  }
  function getSessionState(sid) {
    let s = state.bySession.get(sid)
    if (!s) {
      s = createSessionState(sid)
      state.bySession.set(sid, s)
      logState({ ts: Date.now(), event: 'session-start', sid })
    }
    return s
  }
  function sessionOf(exec) {
    return getSessionState(sidOf(exec))
  }

  // ---------- tools/pre-execute：计数、观测、沙箱审批门、调用签名 ----------
  ctx.on('tools/pre-execute', (exec, next) => {
    const toolName = exec?.name || exec?.tool || exec?.id || 'unknown'
    const now = Date.now()
    const sid = sidOf(exec)
    const s = sessionOf(exec)
    state.totalToolCalls += 1
    s.toolCallsInTurn += 1
    state.observedTools.add(toolName)
    s.sessionObserved.add(toolName)
    rt.trackWriteVerify(s, toolName)
    if (state.observedTools.size !== state.obsPersistedSize) persistObservedTools()

    // 沙箱提权走宿主审批门（保留 v0.2.1 的正确行为：一次调用不能自我授予全盘写权）
    const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
    if (toolName === 'cybernetics_sandbox_mode') {
      const target = argMode(exec)
      const rank = SANDBOX_RANK[target]
      const isEscalation = rank === 2 || (rank === 1 && s.sandboxMode === 'read-only')
      if (isEscalation) {
        logState({ ts: now, event: 'sandbox-mode-ask', sid, target })
        return {
          kind: 'ask',
          reason: `[沙箱提权] 请求把本会话文件沙箱切到 ${target}（任意目录可写）。请批准后再执行。`,
          displayReason: {
            en: `Escalate this session's file sandbox to ${target} (unrestricted writes)?`,
            zh: `确认把本会话文件沙箱提权到 ${target}（任意目录可写）？`,
          },
        }
      }
    }

    // 调用签名挂在 exec 上，result 按同一 exec 引用配对（异步 job 也不会错位）
    exec.__cyber = { startedAt: now, sig: callSignature(toolName, exec) }
    s.lastStartTs = now
    s.lastStartTool = toolName
    s.preExecCount += 1
    logState({ ts: now, event: 'pre-execute', sid, tool: toolName })
    return next()
  })

  // ---------- tools/result：故障分类 → 可靠性计数 → 逻辑状态机 ----------
  ctx.on('tools/result', (exec, result) => {
    const sid = sidOf(exec)
    const s = getSessionState(sid)
    const tool = exec?.name || exec?.tool || 'unknown'
    const now = Date.now()
    const meta = exec?.__cyber
    const sig = meta?.sig || callSignature(tool, exec)

    const isError = !!(result && (result.isError === true || result.error != null || result.ok === false))

    // bash 的命令级失败不进 isError，只在输出里留 `[exit code: N]`；这是主要失败模式，必须单列
    let exitInfo = null
    if (!isError && BASH_TOOLS.has(tool)) {
      const structured = result?.value?.exitCode
      const m = Number.isFinite(structured) ? null : /\[exit code: (\d+)\]/.exec(textContentOf(result))
      const code = Number.isFinite(structured) ? structured : m ? Number(m[1]) : null
      if (code !== null && code !== 0) exitInfo = bashExitDelta(code, execArgsText(exec))
    }
    const failed = isError || !!exitInfo?.failed

    let kind = null
    let errorType = null
    let errMsg = null
    if (failed) {
      if (isError) {
        const cls = classifyFault(result)
        if (cls) {
          kind = cls.kind
          errorType = cls.errorType
          errMsg = cls.errMsg
        }
      } else if (exitInfo) {
        const cls = classifyBashExit(exitInfo)
        kind = cls?.kind ?? 'unknown'
        errorType = cls?.code ?? null
      }
      if (!kind) kind = 'unknown'
    }

    // 耗时观测
    let dtMs = null
    const startedAt = meta?.startedAt ?? s.lastStartTs
    if (startedAt) {
      dtMs = now - startedAt
      const d = s.toolDurations.get(tool) ?? { totalMs: 0, count: 0 }
      d.totalMs += dtMs
      d.count += 1
      s.toolDurations.set(tool, d)
    }

    s.resultCount += 1
    const entry = { ts: now, event: 'result', sid, tool, failed, delta: failed ? 1 : 0 }
    if (kind) entry.kind = kind
    if (errorType) entry.errorType = errorType
    if (errMsg) entry.errMsg = errMsg
    if (dtMs != null) entry.dtMs = dtMs
    if (exitInfo) {
      entry.exitCode = exitInfo.code
      if (exitInfo.token) entry.cmd = exitInfo.token
      if (exitInfo.benign) entry.exitBenign = true
    }

    // 可靠性计数（跨会话样本）
    recordResult(state.reliability, tool, failed, kind)

    // 浪费重试：确定性/致命失败后原样重试同一调用
    if (rt.noteCall(s, { tool, sig, failed, kind, ts: now })) {
      entry.wastedRetry = true
      logState({ ts: now, event: 'wasted-retry', sid, tool })
    }

    // 逻辑控制：状态机推进，产生告警（一次事件段一条）
    const next = logicStep(s.logic, { tool, failed, kind, hash: sig, ts: now }, cfg.logic)
    s.logic = next.state
    for (const a of next.alarms) {
      s.alarmsInjected += 1
      logState({ ts: now, event: 'alarm', sid, code: a.code, n: a.n, tool: a.tool, kind: a.kind ?? null })
      rt.queueWarn(s, a.text)
    }

    logState(entry)
  })

  // ---------- agent/pre-step：turn 边界结算 + 告警注入 ----------
  if (typeof ctx.on === 'function' && ctx.agents) {
    try {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (!decision || decision.kind === 'reject') return decision
        const sid = payload?.agent?.session?.id ?? 'global'
        const s = getSessionState(sid)
        const turn = payload?.turn
        if (turn === undefined || s.currentTurn !== turn) {
          if (turn !== undefined) s.currentTurn = turn
          const vsWarn = rt.verifyOnStopWarn(s)
          if (vsWarn) {
            logState({ ts: Date.now(), event: 'verify-on-stop', sid, writes: s.turnWrites.length, tools: [...new Set(s.turnWrites)] })
            rt.queueWarn(s, vsWarn)
          }
          s.turnWrites = []
          s.turnVerifies = 0
          s.toolCallsInTurn = 0
        }
        if (s.pendingWarns.length === 0) return decision
        const warns = s.pendingWarns
        s.pendingWarns = []
        try {
          const msg = await makeInjectedUserMessage({
            text: warns.join('\n'),
            kind: 'plugin:dsh-cybernetics',
          })
          return { ...decision, messages: [...decision.messages, msg] }
        } catch (e) {
          s.pendingWarns.unshift(...warns)
          logState({ ts: Date.now(), event: 'dropped-warn', sid, count: warns.length, error: String(e?.message || e) })
          return decision
        }
      })
    } catch { /* pre-step 不可用则跳过 */ }
  }

  // ---------- agent/disposed：会话汇总（跨会话汇总的原料） ----------
  if (typeof ctx.on === 'function' && ctx.agents) {
    try {
      ctx.on('agent/disposed', ({ agent }) => {
        const sid = agent?.session?.id ?? 'unknown'
        const s = state.bySession.get(sid)
        if (!s) return
        logState({
          ts: Date.now(),
          event: 'session-summary',
          sid,
          toolCalls: s.preExecCount,
          results: s.resultCount,
          failed: state.reliability.k,
          alarmsInjected: s.alarmsInjected,
          wastedRetries: s.wastedRetries,
          alarmActiveEnd: s.logic.alarmActive,
          observedTools: s.sessionObserved.size,
          slowest: rt.slowestTools(s).map((t) => `${t.tool}(${t.avgMs}ms)`),
        })
        state.bySession.delete(sid)
      })
    } catch { /* disposed 不可用则跳过 */ }
  }

  // ---------- 工具注册 + 启动回放 ----------
  registerCyberneticsTools(ctx, { cfg, state, logState, sessionOf, sidOf, logFile, slowestTools: rt.slowestTools })

  rt.rotateIfNeeded()
  const recovered = rt.recoverFromLog(state.observedTools, 800)
  state.recovered = recovered
  logState({
    ts: Date.now(),
    event: 'boot',
    plugin: name,
    version: VERSION,
    logic: cfg.logic,
    reliability: { minSamples: cfg.reliability.minSamples, retryBudget: cfg.reliability.retryBudget },
    log: cfg.log,
    recovered,
  })

  return { state, logState }
}

export default { name, inject, apply }

// 工具参数里的 mode：宿主一般传对象，兼容 JSON 字符串（测试/旧版本）
function argMode(exec) {
  const a = exec?.arguments ?? exec?.args
  if (a && typeof a === 'object' && typeof a.mode === 'string') return a.mode
  if (typeof a === 'string') {
    try {
      const o = JSON.parse(a)
      if (typeof o?.mode === 'string') return o.mode
    } catch { /* 非 JSON 忽略 */ }
  }
  return ''
}
