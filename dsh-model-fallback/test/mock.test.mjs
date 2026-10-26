// dsh-model-fallback 核心逻辑 mock 测试（不依赖 dsh 宿主）
import { strict as assert } from 'node:assert'
import plugin from '../index.js'

const err = (code, status) => ({ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code, status } } })
const abort = () => ({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'x', code: 'ABORTED' } } })
const stop = () => ({ type: 'finish', reason: { kind: 'stop' } })
const text = t => ({ type: 'text-delta', index: 0, text: t })
const usage = n => ({ type: 'usage', usage: { inputTokens: n, outputTokens: 1 } })

function makeHost(script) {
  // script: { 'provider/model': [chunks...] }，按调用顺序消费
  const calls = []
  const ctx = {
    on(ev, fn) { assert.equal(ev, 'llm/stream'); ctx._listener = fn },
    tools: { register() {} },
    inject(deps, cb) { cb(ctx) },
    effect(fn) { fn() },
    get(name) { return ctx[name] },
    connection: { fetch: { register(route) { (ctx._routes ??= {})[route.path] = route.fetch; return () => {} } } },
    configEditor: { entries: () => [{ options: { id: 'model-fallback' } }], edit: async (e, change) => { ctx._saved = change({ existing: true }) } },
    llm: {
      stream(opts) {
        calls.push(`${opts.provider}/${opts.model}`)
        const key = `${opts.provider}/${opts.model}`
        const chunks = script[key]
        assert.ok(chunks, `unexpected call ${key}`)
        return (async function* () { for (const c of chunks) yield c })()
      },
    },
  }
  return { ctx, calls }
}

async function collect(stream) { const out = []; for await (const c of stream) out.push(c); return out }

const baseOptions = { provider: 'kimi-coding', model: 'k3', messages: [], signal: undefined }
const config = { chains: [{ from: { provider: 'kimi-coding' }, to: [{ provider: 'qwen', model: 'qwen-max' }] }] }

// 1. 主失败（无内容）→ 切备用
{
  const { ctx, calls } = makeHost({
    'kimi-coding/k3': [err('RATE_LIMIT', 429)],
    'qwen/qwen-max': [text('ok'), stop()],
  })
  plugin.apply(ctx, config)
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  assert.deepEqual(calls, ['kimi-coding/k3', 'qwen/qwen-max'])
  assert.deepEqual(out.map(c => c.type), ['text-delta', 'finish'])
}

// 2. 已产出内容后失败 → 透传 error，不切
{
  const { ctx, calls } = makeHost({ 'kimi-coding/k3': [text('半'), err('RATE_LIMIT', 429)] })
  plugin.apply(ctx, config)
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  assert.deepEqual(calls, ['kimi-coding/k3'])
  assert.equal(out.at(-1).reason.kind, 'error')
}

// 3. aborted → 不切
{
  const { ctx, calls } = makeHost({ 'kimi-coding/k3': [abort()] })
  plugin.apply(ctx, config)
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  assert.deepEqual(calls, ['kimi-coding/k3'])
  assert.equal(out.at(-1).reason.kind, 'aborted')
}

// 4. usage 缓冲：主 usage 丢弃，只见备用 usage
{
  const { ctx } = makeHost({
    'kimi-coding/k3': [usage(100), err('OVERLOADED', 503)],
    'qwen/qwen-max': [text('ok'), usage(50), stop()],
  })
  plugin.apply(ctx, config)
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  const usages = out.filter(c => c.type === 'usage')
  assert.equal(usages.length, 1)
  assert.equal(usages[0].usage.inputTokens, 50)
}

// 5. 链尾失败 → 透传最后的 error
{
  const { ctx, calls } = makeHost({
    'kimi-coding/k3': [err('A', 500)],
    'qwen/qwen-max': [err('B', 500)],
  })
  plugin.apply(ctx, config)
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  assert.deepEqual(calls, ['kimi-coding/k3', 'qwen/qwen-max'])
  assert.equal(out.at(-1).reason.failure.code, 'B')
}

// 6. skipCodes 显式配置命中 → 不切
{
  const { ctx, calls } = makeHost({ 'kimi-coding/k3': [err('CONTENT_FILTER')] })
  plugin.apply(ctx, { ...config, skipCodes: ['CONTENT_FILTER'] })
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  assert.deepEqual(calls, ['kimi-coding/k3'])
  assert.equal(out.at(-1).reason.kind, 'error')
}

// 7. from.model 精确匹配：不匹配的模型不拦截
{
  const cfg2 = { chains: [{ from: { provider: 'kimi-coding', model: 'other' }, to: [{ provider: 'qwen', model: 'm' }] }] }
  const { ctx, calls } = makeHost({ 'kimi-coding/k3': [err('X', 500)] })
  plugin.apply(ctx, cfg2)
  const out = await collect(ctx._listener(baseOptions, () => ctx.llm.stream(baseOptions)))
  assert.deepEqual(calls, ['kimi-coding/k3'])
  assert.equal(out.at(-1).reason.kind, 'error')
}

// 8. 跨 provider 丢弃 reasoningEffort
{
  const { ctx } = makeHost({
    'kimi-coding/k3': [err('X', 500)],
    'qwen/qwen-max': [stop()],
  })
  let seen
  ctx.llm.stream = (o) => { seen = o; return (async function* () { yield stop() })() }
  plugin.apply(ctx, config)
  await collect(ctx._listener({ ...baseOptions, reasoningEffort: 'high' }, () => (async function* () { yield err('X', 500) })()))
  assert.equal(seen.reasoningEffort, undefined)
  assert.equal(seen.provider, 'qwen')
}

// 9. 通配链 '*'：任意 provider 失败都切换；精确链优先于通配
{
  const { ctx, calls } = makeHost({
    'some-other/m1': [err('X', 500)],
    'qwen/qwen-max': [text('ok'), stop()],
  })
  plugin.apply(ctx, { chains: [{ from: { provider: '*' }, to: [{ provider: 'qwen', model: 'qwen-max' }] }] })
  const out = await collect(ctx._listener({ provider: 'some-other', model: 'm1', messages: [] }, () => ctx.llm.stream({ provider: 'some-other', model: 'm1', messages: [] })))
  assert.deepEqual(calls, ['some-other/m1', 'qwen/qwen-max'])
  assert.equal(out.at(-1).reason.kind, 'stop')
}
console.log('ALL 9 CASES PASS')
