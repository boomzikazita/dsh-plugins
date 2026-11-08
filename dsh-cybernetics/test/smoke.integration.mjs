// 集成冒烟（不参与 node --test 的 *.test.mjs 匹配）：用最小假 ctx 验证
//   5 个工具注册 / pre-execute 与 result 钩子 / 告警注入 / 汇总 / 日志落盘。
// 前置：本包目录下需有 node_modules/@deepseek-ai/dsh-tools 软链到宿主（pnpm 安装后天然满足）。
// 运行：node test/smoke.integration.mjs
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '.smoke-tmp')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const handlers = new Map()
const tools = []
const ctx = {
  on(name, fn) { handlers.set(name, fn) },
  agents: {},
  tools: { register(t) { tools.push(t) }, schemas() { return [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }] } },
}
const mod = await import('../index.js')
mod.apply(ctx, { stateLog: join(root, 'state_log.ndjson'), observedToolsFile: join(root, 'observed_tools.json') })
const sid = 's1'
const pre = (name, args, s = sid) => {
  const exec = { name, arguments: args, agent: { session: { id: s } } }
  const r = handlers.get('tools/pre-execute')(exec, () => 'NEXT')
  return { exec, r }
}
const result = (exec, res) => handlers.get('tools/result')(exec, res)
const preStep = async (turn = 1) => {
  const decision = { messages: [] }
  return handlers.get('agent/pre-step')({ agent: { session: { id: sid } }, turn }, async () => decision)
}

const out = []
// 1) 两次确定性失败（沙箱拒绝）→ 第 2 次触发确定性告警
const failing = () => ({ isError: true, error: { message: 'Writing outside the workspace is blocked by sandbox', info: { code: 'FS_SANDBOX_DENIED' } } })
for (let i = 0; i < 3; i += 1) {
  const { exec } = pre('bash', JSON.stringify({ command: 'echo x > /etc/x' }))
  result(exec, failing())
}
let d = await preStep(1)
out.push(['确定性失败告警注入', d.messages.length === 1 ? 'PASS' : 'FAIL', d.messages.length])

// 2) 4 次成功后解锁，再 1 次失败不告警
for (let i = 0; i < 4; i += 1) {
  const { exec } = pre('bash', JSON.stringify({ command: `echo ok${i}` }))
  result(exec, { isError: false, content: [{ type: 'text', text: 'ok' }] })
}
{
  const { exec } = pre('bash', JSON.stringify({ command: 'echo last' }))
  result(exec, { isError: false, content: [{ type: 'text', text: 'ok' }] })
}
d = await preStep(2)
out.push(['解锁后不重复告警', d.messages.length === 0 ? 'PASS' : 'FAIL', d.messages.length])

// 3) 同一调用连续 3 次 → 重复告警
for (let i = 0; i < 3; i += 1) {
  const { exec } = pre('read', JSON.stringify({ file_path: '/tmp/x' }))
  result(exec, { isError: false, content: [{ type: 'text', text: 'x' }] })
}
d = await preStep(3)
out.push(['重复调用告警', d.messages.length === 1 && /重复/.test(d.messages[0].content[0].text) ? 'PASS' : 'FAIL', d.messages.length])

// 4) verify-on-stop：turn 内两次 write 无回读
for (let i = 0; i < 2; i += 1) {
  const { exec } = pre('write', JSON.stringify({ file_path: `/tmp/w${i}`, content: 'x' }))
  result(exec, { isError: false })
}
d = await preStep(4)
out.push(['verify-on-stop 提醒', d.messages.length === 1 && /verify-on-stop/.test(d.messages[0].content[0].text) ? 'PASS' : 'FAIL', d.messages.length])

// 5) 沙箱提权走审批门
{
  const { r } = pre('cybernetics_sandbox_mode', JSON.stringify({ mode: 'danger-full-access' }))
  out.push(['沙箱提权 ask', r && r.kind === 'ask' ? 'PASS' : 'FAIL', r?.kind])
}

// 6) 五个工具注册齐全
const names = tools.map((t) => t.name).sort()
const expect = ['cybernetics_check', 'cybernetics_rollup', 'cybernetics_sandbox_mode', 'cybernetics_snap', 'cybernetics_status']
out.push(['工具注册', JSON.stringify(names) === JSON.stringify(expect) ? 'PASS' : 'FAIL', names.join(',')])

// 7) status / rollup 可执行且包含可靠性口径
const fakeExec = { name: 'x', arguments: '{}', agent: { session: { id: sid } } }
const statusText = await tools.find((t) => t.name === 'cybernetics_status').execute({}, fakeExec)
out.push(['status 含 λ/MTBF', /λ=/.test(statusText) && /MTBF=/.test(statusText) ? 'PASS' : 'FAIL', statusText.split('\n')[4]])
const rollupText = await tools.find((t) => t.name === 'cybernetics_rollup').execute({ days: 1 }, fakeExec)
out.push(['rollup 有汇总', /跨会话汇总/.test(rollupText) && /λ=/.test(rollupText) ? 'PASS' : 'FAIL', rollupText.split('\n')[1]])

// 8) 日志确实落盘
const logLines = readFileSync(join(root, 'state_log.ndjson'), 'utf8').split('\n').filter(Boolean)
const events = new Set(logLines.map((l) => JSON.parse(l).event))
out.push(['日志事件', events.has('alarm') && events.has('result') && events.has('boot') ? 'PASS' : 'FAIL', [...events].join(',')])

for (const row of out) console.log(row[1], '|', row[0], '|', row[2])
const fails = out.filter((r) => r[1] !== 'PASS')
console.log(fails.length === 0 ? 'SMOKE-ALL-PASS' : `SMOKE-FAIL ${fails.length}`)
process.exit(fails.length === 0 ? 0 : 1)
