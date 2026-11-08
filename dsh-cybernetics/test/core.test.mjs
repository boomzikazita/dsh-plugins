// dsh-cybernetics — 共享纯函数测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bashExitDelta,
  firstCommandToken,
  commandTextOf,
  execArgsText,
  stableStringify,
  callSignature,
  textContentOf,
} from '../core.mjs'

test('firstCommandToken 跳过环境变量前缀并取最后一段命令', () => {
  assert.equal(firstCommandToken('FOO=1 grep -n x file'), 'grep')
  assert.equal(firstCommandToken('cd /tmp && ls -la'), 'ls')
  assert.equal(firstCommandToken('echo x | wc -l'), 'wc')
  assert.equal(firstCommandToken(''), '')
})

test('commandTextOf 从参数 JSON 中取 command 字段', () => {
  assert.equal(commandTextOf('{"command":"grep -n x ."}'), 'grep -n x .')
  assert.equal(commandTextOf('{"cmd":"ls"}'), 'ls')
  assert.equal(commandTextOf('grep -n x .'), 'grep -n x .')
  assert.equal(commandTextOf('{}'), '{}')
})

test('bashExitDelta：grep 无匹配（退出 1）算约定非零，不算失败', () => {
  const r = bashExitDelta(1, '{"command":"grep -n foo ."}')
  assert.equal(r.failed, false)
  assert.equal(r.benign, true)
  assert.equal(r.token, 'grep')
})

test('bashExitDelta：普通命令退出 1 算失败', () => {
  const r = bashExitDelta(1, '{"command":"python3 x.py"}')
  assert.equal(r.failed, true)
  assert.equal(r.benign, false)
})

test('bashExitDelta：退出 0 恒成功', () => {
  assert.deepEqual(bashExitDelta(0, '{"command":"ls"}'), { failed: false, benign: false, token: '', code: 0 })
})

test('execArgsText：arguments 优先，支持对象与缺失', () => {
  assert.equal(execArgsText({ arguments: '{"a":1}' }), '{"a":1}')
  assert.equal(execArgsText({ arguments: { a: 1 } }), '{"a":1}')
  assert.equal(execArgsText({ args: 'x' }), 'x')
  assert.equal(execArgsText({}), '')
})

test('stableStringify：键顺序不同但内容相同得到同一字符串', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }))
  assert.equal(stableStringify([1, { b: 2, a: 3 }]), '[1,{"a":3,"b":2}]')
})

test('callSignature：同工具同参数一致，参数不同则不同', () => {
  const a = callSignature('bash', { arguments: '{"command":"ls"}' })
  const b = callSignature('bash', { arguments: { command: 'ls' } })
  const c = callSignature('bash', { arguments: '{"command":"ls -la"}' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^bash\|/)
})

test('textContentOf：拼接文本块，忽略非文本块', () => {
  const r = { content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }
  assert.equal(textContentOf(r), 'ab')
  assert.equal(textContentOf({}), '')
})
