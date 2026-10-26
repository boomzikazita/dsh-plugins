/**
 * dsh-model-fallback — 主模型失败自动切换备用模型（DeepSeek Harness 插件）
 *
 * 机制：
 *   挂 `llm/stream` 瀑布事件（waterfall）。主模型流照常透传；当终态 chunk 为
 *   finish.kind === 'error'（适配器选择/派发/迭代失败都会归一成这个形态），
 *   按配置的 chains 顺序，用备用 provider/model 重新发起一次完整流式调用
 *   （消息、系统提示、工具表原样携带），把备用流的 chunk 接续吐给消费端。
 *
 * 安全阀：
 *   1. aborted（用户取消 / signal 中止）永不切换；
 *   2. 已产出内容块（text/reasoning/tool-call 等）后不切换 —— 防止两个模型的
 *      半截输出拼成一条消息（onlyBeforeContent，默认开）；
 *   3. skipCodes（默认空：所有 error 终态都切换；aborted 永不切换）；
 *   4. 自发起请求用 WeakSet 标记，瀑布重入时直接放行，不会递归拦截自己；
 *   5. 链长天然限制最大切换次数，无环。
 *
 * 跨 provider 切换默认丢弃 reasoningEffort（各家 effort 语义不通用，
 * 显式 effort 不被目标模型支持时 resolveCallConfig 会在派发前拒绝）；
 * 备用目标可显式给 reasoningEffort / temperature / maxTokens / stop 覆盖。
 *
 * 留痕（禁止静默失败）：
 *   每次切换写一条 ndjson 到 logFile，并 console.warn 进宿主日志；
 *   日志写盘失败计数告警，不吞错。
 *
 * 配置（cordis.patch.yml 的 config 段）见 README.md。
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-model-fallback'
export const inject = ['llm', 'tools']

export const VERSION = '0.4.0'

/**
 * 设置页表单 schema。静态 JSON Schema 路径无法枚举运行时注册的 provider/模型
 * （官方 agent-default-model 同为纯字符串字段，下拉选择器是客户端专写组件），
 * 模型目录联动走 model_fallback_status 工具（实时列注册表）。
 */
export const Config = z.object({
  onlyBeforeContent: z.boolean().default(true)
    .description('已开始输出内容后不再切换（防止两个模型的半截输出拼成一条消息）。默认开启'),
  codes: z.array(z.string()).default([])
    .description('触发切换的失败码白名单；留空 = 所有 error 终态都切换。aborted（用户取消）永不切换'),
  skipCodes: z.array(z.string()).default([])
    .description('永不切换的失败码；留空 = 所有 error 终态都切换'),
  logFile: z.string().default('~/.dsh/model-fallback/events.ndjson')
    .description('切换事件日志（ndjson）路径，一行一次切换'),
  chains: z.array(z.object({
    from: z.object({
      provider: z.string().description('主路由 provider（如 kimi-coding；当前默认模型见 设置 → 模型）'),
      model: z.string().default('').description('主路由模型 id；留空 = 该 provider 的任意模型'),
    }).description('匹配来源'),
    to: z.array(z.object({
      provider: z.string().description('备用 provider 路由名（须已在 设置 → 模型 里配置并注册）'),
      model: z.string().description('备用模型 id（可用 model_fallback_status 工具列出可选目录）'),
      reasoningEffort: z.string().default('').description('可选：覆盖推理强度；留空 = 跨 provider 时自动丢弃'),
    })).description('备用目标，按顺序逐个尝试'),
  })).default([]).description('fallback 链：主路由 → 备用目标列表。可配多条链覆盖不同主路由'),
})

function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return undefined
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  return p
}

const ROUTE_KEYS = ['reasoningEffort', 'temperature', 'maxTokens', 'stop']

/** 校验并归一化 chains 配置；非法条目跳过并计数告警，不静默吞掉。 */
function normalizeChains(raw) {
  if (!Array.isArray(raw)) return []
  const chains = []
  let dropped = 0
  for (const entry of raw) {
    const from = entry?.from
    const to = entry?.to
    // schema 默认把可选字符串填成 ''，归一化为「未指定」
    const fromModel = typeof from.model === 'string' && from.model.length > 0 ? from.model : undefined
    if (typeof from?.provider !== 'string' || from.provider.length === 0
      || (from.model !== undefined && typeof from.model !== 'string')
      || !Array.isArray(to) || to.length === 0) { dropped++; continue }
    const targets = []
    for (const t of to) {
      if (typeof t?.provider !== 'string' || t.provider.length === 0
        || typeof t?.model !== 'string' || t.model.length === 0) { dropped++; continue }
      const target = { provider: t.provider, model: t.model }
      for (const k of ROUTE_KEYS) {
        if (t[k] !== undefined && t[k] !== '') target[k] = t[k]
      }
      targets.push(target)
    }
    if (targets.length === 0) { dropped++; continue }
    chains.push({ from: { provider: from.provider, model: fromModel }, to: targets })
  }
  if (dropped > 0) console.warn(`[dsh-model-fallback] chains 配置有 ${dropped} 处非法条目，已跳过`)
  return chains
}

function asCodeList(raw, fallback) {
  if (!Array.isArray(raw)) return fallback
  return raw.filter(c => typeof c === 'string' && c.length > 0)
}

/** 内容块判定：usage/finish 之外的所有 chunk 都视为「已开始产出内容」。 */
function isContentChunk(chunk) {
  return chunk.type !== 'usage' && chunk.type !== 'finish'
}

export function apply(ctx, config = {}) {
  const chains = normalizeChains(config.chains)
  const opts = {
    onlyBeforeContent: config.onlyBeforeContent !== false,
    codes: asCodeList(config.codes, []),
    skipCodes: asCodeList(config.skipCodes, []),
    logFile: expandHome(config.logFile),
  }

  // ── 设置面板 HTTP 通道（client.js ↔ 本 Host 半，dsh-context 同款模式）──
  // connection.fetch.register：标准 fetch Request/Response 路由，挂在 /api 信任栅栏后，
  // 不走 rpc.handle（0.3.0 实测它内部经调用方 fiber 访问 webServer，缺 inject 必抛）。
  // ctx.inject 条件激活：headless 缺 connection/configEditor 时跳过，核心 fallback 不受影响。
  ctx.inject(['connection', 'configEditor'], (rctx) => {
    const conn = rctx.get('connection')
    const register = typeof conn?.fetch?.register === 'function' ? conn.fetch.register.bind(conn.fetch) : undefined
    const editor = rctx.get('configEditor')
    if (register === undefined || editor === undefined) {
      console.warn('[dsh-model-fallback] connection.fetch / configEditor 不可用，设置面板通道未注册（核心 fallback 不受影响）')
      return
    }
    const json = (value, init = {}) => Response.json(value, { ...init, headers: { 'cache-control': 'no-store' } })
    const fail = (message, status = 400) => json({ ok: false, error: { message } }, { status })
    const route = (path, handler) => rctx.effect(
      () => register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      `dsh-model-fallback: ${path}`,
    )

    // 面板初始化数据：实时 provider/模型目录 + 当前配置
    route('/api/model-fallback/state', async () => {
      const providers = []
      let failures = 0
      for (const p of ctx.llm.listProviders()) {
        try {
          const models = await ctx.llm.listModels(p.id)
          providers.push({ id: p.id, name: p.name, models: models.map(m => ({ id: m.id, name: m.name })) })
        } catch (e) {
          failures++
          providers.push({ id: p.id, name: p.name, models: null, error: e?.message ?? String(e) })
        }
      }
      return json({
        ok: true,
        value: {
          providers,
          failures,
          config: {
            onlyBeforeContent: config.onlyBeforeContent !== false,
            codes: asCodeList(config.codes, []),
            skipCodes: asCodeList(config.skipCodes, []),
            chains: JSON.parse(JSON.stringify(Array.isArray(config.chains) ? config.chains : [])),
          },
        },
      })
    })

    // 保存：全量校验（非法即整体拒存，不静默丢用户输入）→ configEditor 持久化（走 Loader 正常路径，live 热重载）
    route('/api/model-fallback/save', async (request) => {
      let body
      try { body = await request.json() } catch { return fail('请求体不是 JSON') }
      const next = body?.config
      if (next === null || typeof next !== 'object') return fail('config 必须是对象')
      const rawChains = Array.isArray(next.chains) ? next.chains : []
      const problems = []
      const clean = []
      rawChains.forEach((c, i) => {
        const fp = c?.from?.provider
        if (typeof fp !== 'string' || fp.trim().length === 0) { problems.push(`第 ${i + 1} 条链：主路由 provider 为空`); return }
        const to = Array.isArray(c?.to) ? c.to : []
        if (to.length === 0) { problems.push(`第 ${i + 1} 条链（${fp}）：至少一个备用目标`); return }
        const targets = []
        to.forEach((t, j) => {
          if (typeof t?.provider !== 'string' || t.provider.trim().length === 0
            || typeof t?.model !== 'string' || t.model.trim().length === 0) {
            problems.push(`第 ${i + 1} 条链目标 ${j + 1}：provider 与 model 必填`); return
          }
          const target = { provider: t.provider.trim(), model: t.model.trim() }
          if (typeof t.reasoningEffort === 'string' && t.reasoningEffort.trim().length > 0) {
            target.reasoningEffort = t.reasoningEffort.trim()
          }
          targets.push(target)
        })
        const from = { provider: fp.trim() }
        if (typeof c?.from?.model === 'string' && c.from.model.trim().length > 0) from.model = c.from.model.trim()
        clean.push({ from, to: targets })
      })
      if (problems.length > 0) return fail(problems.join('；'))
      const entry = editor.entries().find(row => row.options?.id === 'model-fallback')
      if (entry === undefined) return fail('找不到配置行 model-fallback（插件未通过 patch 挂载？）', 500)
      await editor.edit(entry, (raw) => ({
        ...raw,
        onlyBeforeContent: next.onlyBeforeContent !== false,
        codes: asCodeList(next.codes, []),
        skipCodes: asCodeList(next.skipCodes, []),
        chains: clean,
      }))
      logEvent({
        ts: new Date().toISOString(), event: 'config-saved',
        chains: clean.map(c => `${c.from.provider}${c.from.model ? '/' + c.from.model : '/*'} → ${c.to.map(t => `${t.provider}/${t.model}`).join(' → ')}`),
      })
      return json({ ok: true, value: { saved: true, chains: clean.length } })
    })
  })

  // 模型目录联动：设置页表单是静态 JSON Schema，无法枚举运行时注册表；
  // 用这个工具实时列出已注册 provider 与其模型目录，供配置 chains 时选型。
  ctx.tools.register(defineTool({
    name: 'model_fallback_status',
    description: '列出当前已注册的模型 provider 及其模型目录（实时）、生效中的 fallback 链与最近切换事件。配置 dsh-model-fallback 的 chains 前先调用它选型。',
    parameters: {},
    output: {
      schema: { type: 'string', description: '模型目录、生效链与切换事件的文本摘要' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const lines = []
      // 1) 已注册 provider + 模型目录（实时）
      let providers = []
      try { providers = ctx.llm.listProviders() } catch (e) {
        lines.push(`已注册 provider 列举失败：${e?.message ?? e}`)
      }
      let listFailures = 0
      for (const p of providers) {
        let models = []
        try { models = await ctx.llm.listModels(p.id) } catch (e) {
          listFailures++
          lines.push(`- ${p.id}（${p.name}）：模型目录获取失败：${e?.message ?? e}`)
          continue
        }
        lines.push(models.length === 0
          ? `- ${p.id}（${p.name}）：无目录（该适配器不枚举模型，id 按端点文档手填）`
          : `- ${p.id}（${p.name}）：${models.map(m => m.id).join(', ')}`)
      }
      if (providers.length === 0) lines.push('- （无任何已注册 provider）')
      if (listFailures > 0) lines.push(`（${listFailures} 个 provider 目录获取失败，见上）`)
      // 2) 生效链
      lines.push('', '生效中的 fallback 链：')
      if (chains.length === 0) lines.push('- （未配置，插件空转）')
      for (const c of chains) {
        lines.push(`- ${c.from.provider}${c.from.model ? '/' + c.from.model : '/*'} → ${c.to.map(t => `${t.provider}/${t.model}`).join(' → ')}`)
      }
      // 3) 最近切换事件（日志尾部 5 行）
      lines.push('', '最近切换事件：')
      if (!opts.logFile || !existsSync(opts.logFile)) lines.push('- （尚无记录）')
      else {
        try {
          const rows = readFileSync(opts.logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-5)
          if (rows.length === 0) lines.push('- （尚无记录）')
          for (const r of rows) {
            const e = JSON.parse(r)
            lines.push(`- ${e.ts} ${e.from?.provider}/${e.from?.model} → ${e.to?.provider}/${e.to?.model}（${e.failure?.code ?? '?'}${e.failure?.status ? ' HTTP ' + e.failure.status : ''}）`)
          }
        } catch (e) { lines.push(`- 日志读取失败：${e?.message ?? e}`) }
      }
      return lines.join('\n')
    },
  }))

  if (chains.length === 0) {
    console.warn('[dsh-model-fallback] 未配置有效 chains，插件空转（不拦截任何模型调用）')
    return
  }
  /** 自发起 fallback 请求的身份标记：瀑布重入时据此直接放行。 */
  const selfRequests = new WeakSet()
  let logDirReady = false
  let logFailures = 0

  function logEvent(rec) {
    if (!opts.logFile) return
    try {
      if (!logDirReady) { mkdirSync(dirname(opts.logFile), { recursive: true }); logDirReady = true }
      appendFileSync(opts.logFile, JSON.stringify(rec) + '\n')
    } catch (err) {
      logFailures++
      if (logFailures <= 3) {
        console.warn(`[dsh-model-fallback] 事件日志写盘失败（第 ${logFailures} 次）：${err?.message ?? err}`)
      }
    }
  }

  function matchChain(provider, model) {
    let wildcard
    for (const c of chains) {
      if (c.from.provider === '*') { wildcard ??= c; continue }
      if (c.from.provider !== provider) continue
      if (c.from.model !== undefined && c.from.model !== model) continue
      return c
    }
    return wildcard
  }

  /** 当前失败是否允许切换备用。 */
  function eligible(failure, hasContent) {
    if (opts.onlyBeforeContent && hasContent) return false
    const code = failure?.code
    if (code !== undefined && opts.skipCodes.includes(code)) return false
    if (opts.codes.length > 0 && (code === undefined || !opts.codes.includes(code))) return false
    return true
  }

  /**
   * 跑一条流；error 终态且满足切换条件时，丢弃本次失败，接续下一个备用目标。
   * usage chunk 先缓冲不透传：失败切换时丢弃旧 usage，保证消费端只看到最终
   * 生效那条流的计费信息。
   */
  async function* run(options, makeStream, targets) {
    let hasContent = false
    let heldUsage = null
    let failure = null
    for await (const chunk of makeStream()) {
      if (chunk.type === 'usage') { heldUsage = chunk; continue }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' && targets.length > 0
          && eligible(chunk.reason.failure, hasContent)) {
          failure = chunk.reason.failure
          break
        }
        if (heldUsage !== null) yield heldUsage
        yield chunk
        return
      }
      if (isContentChunk(chunk)) hasContent = true
      yield chunk
    }
    if (failure === null) {
      // 流无 finish 自然耗尽（罕见）：原样收尾，补吐缓冲的 usage。
      if (heldUsage !== null) yield heldUsage
      return
    }
    const [target, ...rest] = targets
    const code = failure?.code ?? 'UNKNOWN'
    console.warn(
      `[dsh-model-fallback] ${options.provider}/${options.model} 失败（${code}`
      + (failure?.status ? ` HTTP ${failure.status}` : '')
      + `），切换到备用 ${target.provider}/${target.model}`,
    )
    logEvent({
      ts: new Date().toISOString(),
      event: 'fallback',
      sessionId: options.sessionId ?? null,
      purpose: options.purpose ?? null,
      from: { provider: options.provider, model: options.model },
      to: { provider: target.provider, model: target.model },
      failure: {
        code,
        status: failure?.status ?? null,
        message: typeof failure?.message === 'string' ? failure.message.slice(0, 300) : null,
      },
    })
    // 深冻的原始 options 不可改，复制一份换路由；messages/tools 等嵌套引用共享只读安全。
    const nextOptions = { ...options, provider: target.provider, model: target.model }
    if (target.reasoningEffort !== undefined) nextOptions.reasoningEffort = target.reasoningEffort
    else if (target.provider !== options.provider) delete nextOptions.reasoningEffort
    for (const k of ['temperature', 'maxTokens', 'stop']) {
      if (target[k] !== undefined) nextOptions[k] = target[k]
    }
    selfRequests.add(nextOptions)
    yield* run(nextOptions, () => ctx.llm.stream(nextOptions), rest)
  }

  ctx.on('llm/stream', (options, next) => {
    if (selfRequests.has(options)) return next()
    const chain = matchChain(options.provider, options.model)
    if (chain === undefined) return next()
    return run(options, next, chain.to)
  })

  console.warn(
    `[dsh-model-fallback] v${VERSION} 已挂载：${chains.length} 条链（`
    + chains.map(c => `${c.from.provider}${c.from.model ? '/' + c.from.model : '/*'} → ${c.to.map(t => `${t.provider}/${t.model}`).join(' → ')}`).join('；')
    + '）',
  )
}

export default { name, inject, Config, apply }
