// dsh-cybernetics 控制律与状态回放（2026-10-25 从 index.js 下沉，verbatim）
// 工厂注入 apply 作用域依赖；返回全部控制器供钩子与工具共用
import { readFileSync, existsSync } from 'node:fs'
import { valveFor, ema, emaAlphaFor, detectOscillationPure, adjustControlPure, execArgsText, healthWindowPure } from './core.mjs'

export function makeControl({ cfg, state, logState, logFile }) {
  // 稳定阀基线与采样基准周期（v4.6）：档位执行效果与 EMA 增益都从这里取
  const valveBase = cfg.stability?.maxToolCallsPerTurn ?? 25
  const dt0 = cfg.control?.dt0Ms ?? 250
  const alpha0 = cfg.control?.alphaLow ?? 0.15
  const alphaOf = (dtMs) => emaAlphaFor(dtMs, { alpha0, dt0 })

  // ---------- 控制律（P0-1 闭合回路 + P1-1 滤波 + P1-2 检测；按会话） ----------
  function pushResultBuf(s, delta) {
    s.resultBuf.push(delta)
    if (s.resultBuf.length > cfg.control.oscillationWindow) s.resultBuf.shift()
  }
  function queueWarn(s, text) {
    s.pendingWarns.push(text)
  }
  function currentMode(s) {
    if (s.modeSource === 'manual' && Date.now() >= s.manualModeUntil) {
      s.modeSource = 'auto' // 手动模式到期，恢复自适应
      s.mode = s.autoMode
    }
    return s.mode
  }
  function adjustControl(s, delta, dtMs) {
    // v4.6 P1-7 采样归一：增益按真实 Δt 归一（固定 α 在不同调用节奏下时间常数差 600 倍）
    const alpha = alphaOf(dtMs)
    // P1-1 一阶递归滤波：pHat = (1-α)·pHat + α·delta（慢统计，快通路交给 divergence）
    s.pHat = ema(s.pHat, delta, alpha)
    // 发散检测：连续失败（正反馈发散倾向）
    s.divergenceStreak = delta === 1 ? s.divergenceStreak + 1 : 0
    if (s.divergenceStreak >= cfg.control.divergenceStreak && !s.divergence) {
      s.divergence = true
      if (!s.divergenceWarned) {
        s.divergenceWarned = true
        logState({ ts: Date.now(), event: 'divergence-warn', sid: s.sid, streak: s.divergenceStreak, pHat: s.pHat })
        queueWarn(s, `[控制律] 连续 ${s.divergenceStreak} 次工具失败（pHat=${s.pHat.toFixed(2)}），检测到发散倾向，请检查工具链/命令正确性并降低并发`)
      }
    } else if (delta === 0 && s.divergence) {
      s.divergence = false
      s.divergenceWarned = false
    }
    // 振荡检测：结果 0/1 高频翻转（自激振荡）
    pushResultBuf(s, delta)
    const osc = detectOscillationPure(s.resultBuf, cfg.control.oscillationRatio)
    if (osc && !s.oscillation) {
      s.oscillation = true
      if (!s.oscillationWarned) {
        s.oscillationWarned = true
        logState({ ts: Date.now(), event: 'oscillation-warn', sid: s.sid, window: s.resultBuf.length, pHat: s.pHat })
        queueWarn(s, `[控制律] 工具结果在失败/成功间高频翻转（窗口 ${s.resultBuf.length} 内翻转率 ≥ ${cfg.control.oscillationRatio}），疑似振荡，建议减少并行依赖`)
      }
    } else if (!osc && s.oscillation) {
      s.oscillation = false
      s.oscillationWarned = false
    }
    // 负反馈 + 滞环 + 发散直通升档（v4.3）：纯函数决策，副作用（日志/警告）在此呈现
    const r = adjustControlPure({
      pHat: s.pHat,
      autoMode: s.autoMode,
      deescalateStreak: s.deescalateStreak,
      escalateStreak: s.escalateStreak,
      divergenceStreak: s.divergenceStreak,
      control: cfg.control,
    })
    if (r.escalated || r.deescalated) {
      const prev = s.autoMode
      s.autoMode = r.autoMode
      if (s.modeSource !== 'manual') s.mode = r.autoMode
      s.lastModeSwitch = Date.now()
      const cause = r.escalated ? (s.divergence ? 'escalate-divergence' : 'escalate') : 'deescalate'
      logState({ ts: Date.now(), event: 'mode-switch', sid: s.sid, from: prev, to: r.autoMode, pHat: s.pHat, cause })
      const reason = r.escalated
        ? (s.divergence ? `连续 ${s.divergenceStreak} 次失败（发散直通升档）` : `失败率 pHat=${s.pHat.toFixed(2)} 连续超阈值 ${cfg.control.escalateAt}`)
        : `失败率 pHat=${s.pHat.toFixed(2)} 连续 ${cfg.control.deescalateStreak} 次低于阈值 ${cfg.control.deescalateAt}`
      // v4.6 P0-3：打印**生效阈值**（基线 − 档位收缩量）。原实现印 MODE_LIMITS 的 5/4/3，
      // 而 patch 的基线 25 一直短路它，等于对模型报了一个不存在的限值。
      queueWarn(s, `[控制律] ${reason}，模式档位 ${prev}→${r.autoMode}（稳定阀阈值 ${valveFor(prev, valveBase)}→${valveFor(r.autoMode, valveBase)}）`)
    }
    s.deescalateStreak = r.deescalateStreak
    s.escalateStreak = r.escalateStreak
    // v4.3 饱和兜底：保守档仍连续失败（超 saturationStreak）→ 求助而非硬试（控制饱和，对照第 4 章反例）
    if (s.autoMode === 'conservative' && s.divergenceStreak >= cfg.control.saturationStreak && !s.saturationWarned) {
      s.saturationWarned = true
      logState({ ts: Date.now(), event: 'saturation-warn', sid: s.sid, streak: s.divergenceStreak, pHat: s.pHat })
      queueWarn(s, `[控制律] 保守档下仍连续 ${s.divergenceStreak} 次失败（饱和），继续硬试无益，建议暂停并求助用户或人工介入，不要继续盲目重试`)
    }
    if (delta === 0) s.saturationWarned = false // 成功后复位，允许下次饱和再告警
  }

  // ---------- A3 日志回放恢复（boot 时调用）：pHat/档位跨重启续算 ----------
  function recoverStateFromLog(maxLines = 500) {
    try {
      if (!existsSync(logFile)) return false
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-maxLines)
      let p = 0
      let autoMode = 'fast'
      let deescalateStreak = 0
      let escalateStreak = 0
      let divergenceStreak = 0
      let results = 0
      let lastResultTs = 0
      let prevTs = 0
      for (const l of lines) {
        let e
        try { e = JSON.parse(l) } catch { continue }
        if (e.event === 'result' && typeof e.delta === 'number') {
          divergenceStreak = e.delta === 1 ? divergenceStreak + 1 : 0
          // v4.6：回放与实时同口径（按 Δt 归一），否则跨重启续算的 pHat 与实时值系统性偏离
          const dt = prevTs > 0 && e.ts ? e.ts - prevTs : 0
          p = ema(p, e.delta, alphaOf(dt))
          prevTs = e.ts ?? prevTs
          lastResultTs = e.ts ?? 0
          results += 1
          const r = adjustControlPure({ pHat: p, autoMode, deescalateStreak, escalateStreak, divergenceStreak, control: cfg.control })
          autoMode = r.autoMode
          deescalateStreak = r.deescalateStreak
          escalateStreak = r.escalateStreak
        } else if (e.event === 'mode-switch' && typeof e.to === 'string') {
          autoMode = e.to
        }
      }
      if (results === 0) return false
      state.pHatSeed = p
      state.autoModeSeed = autoMode
      state.recovered = { entries: lines.length, results, pHat: p, autoMode, lastResultTs }
      logState({ ts: Date.now(), event: 'boot-recover', ...state.recovered })
      return true
    } catch {
      return false
    }
  }

  // ---------- C9 日志回放 pHat（status 交叉校验用） ----------
  function replayPHat(n = 50) {
    try {
      if (!existsSync(logFile)) return null
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-n)
      let p = 0
      let count = 0
      let prevTs = 0
      for (const l of lines) {
        let e
        try { e = JSON.parse(l) } catch { continue }
        if (e.event === 'result' && typeof e.delta === 'number') {
          // v4.6：与实时同一条增益规则（按 Δt 归一）。原实现用固定的 cfg.control.alpha(0.2)，
          // 而实时走 adaptiveAlpha(0.15/0.5)，两边口径不同 ⇒ 「漂移可疑」必然误报。
          const dt = prevTs > 0 && e.ts ? e.ts - prevTs : 0
          p = ema(p, e.delta, alphaOf(dt))
          prevTs = e.ts ?? prevTs
          count += 1
        }
      }
      return count ? p : null
    } catch {
      return null
    }
  }

  // ---------- B5 最慢工具 TOP3（会话级） ----------
  function slowestTools(s, top = 3) {
    return [...s.toolDurations.entries()]
      .map(([tool, { totalMs, count }]) => ({ tool, avgMs: Math.round(totalMs / Math.max(1, count)), count }))
      .sort((x, y) => y.avgMs - x.avgMs)
      .slice(0, top)
  }

  // ---------- 健康评分（v4.7：窗口级 + 按工具基线归一，替代 C13 会话级公式） ----------
  // 会话级分数必饱和（实测 309 会话失败率中位数 0 ⇒ 长期钉在 100），改在跨会话窗口上算。
  // state.window / state.preTotal / state.resTotal 由 index.js 的钩子维护。
  function healthOf(s) {
    const win = Array.isArray(state.window) ? state.window : []
    const pre = Number(state.preTotal) || 0
    const res = Number(state.resTotal) || 0
    return healthWindowPure({
      window: win,
      // 观测缺口：真的 pre-execute 没有配对 result（不是"每次调用都必有一条 result"那种恒等式）
      unpairedRate: pre > 0 ? Math.max(0, (pre - res) / pre) : 0,
      redundantRate: s && s.preExecCount > 0 ? s.redundantCalls / s.preExecCount : 0,
      divergence: !!s?.divergence,
      oscillation: !!s?.oscillation,
    })
  }

  // ---------- 前馈匹配（P2：工具名白名单，pattern 只匹配参数） ----------
  function matchFeedforward(exec) {
    const toolName = exec?.name || exec?.tool || exec?.id || ''
    const argsText = execArgsText(exec)
    let first = null
    for (const rule of cfg.feedforward) {
      try {
        if (rule.tools && !rule.tools.includes(toolName)) continue // 工具名白名单
        if (!rule.pattern) continue
        if (new RegExp(rule.pattern).test(argsText)) {
          // 不可逆/破坏性操作（dry-run+confirm）永远最优先，避免被网络类规则抢先短路
          if (rule.action.strategy === 'dry-run+confirm') return rule
          first = first ?? rule
        }
      } catch {
        // 无效正则跳过
      }
    }
    return first
  }

  // ---------- verify-on-stop 守卫（v4.5，2026-10-28；灵感 [arXiv:2609.00006] Hermes） ----------
  // 完成声明纪律（「无证据的完成视为降级报告」）原文靠 prompt 自觉，此处下沉为机制：
  // 本 turn 有 write/edit 写入但无任何 read/grep/glob 回读 → turn 边界注入提醒。
  // 判定只看工具调用事实，不做文件级配对（YAGNI：工具级足够拦住「写了就走」）。
  const WRITE_TOOLS = new Set(['write', 'edit'])
  const VERIFY_TOOLS = new Set(['read', 'grep', 'glob', 'read_image'])
  function trackWriteVerify(s, toolName) {
    if (WRITE_TOOLS.has(toolName)) s.turnWrites.push(toolName)
    else if (VERIFY_TOOLS.has(toolName)) s.turnVerifies += 1
  }
  function verifyOnStopWarn(s) {
    if (s.turnWrites.length === 0 || s.turnVerifies > 0) return null
    // v4.6 P1-8 精度修正：实测 49 次触达里 37 次只有 1 个写入，而单次 write 多半是**新建文件**，
    // 本就不存在「覆盖了原有内容却没人核对」的风险，属系统性误报。
    // 只在「改既有内容（edit）」或「成批写入（≥2）」时提醒。
    const hasEdit = s.turnWrites.includes('edit')
    if (!hasEdit && s.turnWrites.length < 2) return null
    return `[verify-on-stop] 上一轮有 ${s.turnWrites.length} 次文件写入（${[...new Set(s.turnWrites)].join('/')}）但无任何回读验证（read/grep/glob）。完成声明前请回读目标文件确认落盘内容——「写了但没验证」属降级报告。`
  }

  return { pushResultBuf, queueWarn, currentMode, adjustControl, recoverStateFromLog, replayPHat, slowestTools, healthOf, matchFeedforward, trackWriteVerify, verifyOnStopWarn }
}
