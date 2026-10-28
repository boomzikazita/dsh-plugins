// dsh-memory 常量与纯函数（2026-10-25 从 index.js 下沉，代码 verbatim；模块预算 ≤500 治理）
// 含：敏感模式/豁免路径/写工具集、归属门路由、primer 门控、trigger 保障、注入消息工厂、文本提取、注入分档
import { randomUUID } from 'node:crypto'

// 敏感模式（写前扫描；命中 → 警告/拦截/重定向 vault）
export const SENSITIVE_PATTERNS = [
  { id: 'api-key', re: /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/i, label: 'API Key' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { id: 'secret-assign', re: /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{8,}/i, label: '密钥/口令赋值' },
  { id: 'phone', re: /\b1[3-9]\d{9}\b/, label: '手机号' },
  { id: 'id-card', re: /\b\d{17}[\dXx]\b/, label: '身份证号' },
  { id: 'cookie', re: /\bcookie\s*[:=]/i, label: 'Cookie' },
]
// 豁免路径（凭据类，允许明文）
export const EXEMPT_PATH = /(\.env|credentials|\.vault-key|VAULT\.md\.enc|\.git\/)/i
// 写类工具（guard 扫描对象；bash 太噪，不扫）
// v0.2.1：补 memory_conflict（merge/replace 会把 agent 原文写进 L1，原集合漏扫）
export const WRITE_TOOLS = new Set(['write', 'edit', 'memory_suggest', 'memory_vault_set', 'memory_conflict'])
// 归属门（2026-10-17 四库严格划分）：L1 只收「触发式知识」，其余三类各有归处——
// SOUL=人格红线 / AGENTS=常驻纪律与系统事实 / USER=人物画像 / MEMORY=if-then 知识 / wiki=项目记录。
// 硬拦只认两类无歧义特征（档案、record），纪律类给软提示：纪律要每轮生效、召回会漏。
// 0.2.3 收紧：去掉裸「定稿」——它误伤合法画像「迭代类文稿要双版本：clean 定稿 + 修订标记版」（USER.md 输出条实测）。
export const ROUTE_ARCHIVE = /(已定稿|配置方案|投资方案|施工单|施工记录|第\s*\d+\s*批|\d+\s*批[季月]投|持仓|本金|佣金|条件单|全文\s*`|全文见)/
export const ROUTE_DISCIPLINE = /(一律|禁止|不得|必须先|红线)/
export const ROUTE_HINT = {
  archive: '项目方案/档案 → wiki（原文落库，L1 最多留一行指针）',
  discipline: '常驻纪律 → ~/.dsh/AGENTS.md（每轮注入；L1 靠关键词召回，漏命中即失效）',
}
// primer 门控：实体/主题关键词（命中才召回注入；默认零注入）
export const PRIMER_GATE = [
  '记忆', '记住', '忘了', '偏好', '人物', '档案', '端口', '配置', '会议纪要',
  'A股', '控制论', 'Honcho', 'ZeroTier', '飞书', '老郑', '句号',
]

/**
 * 注入 user 消息的稳健工厂（v0.2.1）
 *
 * 优先用宿主 `@deepseek-ai/dsh-llm` 的 createUserMessage。但该裸导入在插件**真实目录**下
 * 可能解析不到（本机实测 ERR_MODULE_NOT_FOUND：/home/boom/dsh-plugins/node_modules/@deepseek-ai/
 * 只有 dsh-tools；Node 按 realpath 向上查找，profile 那层的 dsh-llm 用不到），
 * 原实现把它放在 try 里静默吞掉 ⇒ primer/guard 整条注入链路恒失效。
 * 故：解析失败时按宿主 createMessage 的等价形态兜底（role/content/source/id + 冻结），
 * 保证注入不因依赖缺失而整条死掉；同时一次性 console.warn 留痕。
 */
let _createUserMessage = null // null=未探测 / function=宿主工厂 / false=不可用
let _injectFactoryWarned = false
export async function makeInjectedUserMessage({ text, kind }) {
  const content = [{ type: 'text', text }]
  if (_createUserMessage === null) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      _createUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : false
    } catch {
      _createUserMessage = false
    }
  }
  if (typeof _createUserMessage === 'function') {
    return _createUserMessage({ content, source: { kind } })
  }
  if (!_injectFactoryWarned) {
    _injectFactoryWarned = true
    console.warn('[dsh-memory] @deepseek-ai/dsh-llm 不可解析，注入消息走等价兜底形态（建议补 node_modules/@deepseek-ai/dsh-llm 软链）')
  }
  return Object.freeze({ id: randomUUID(), role: 'user', content, source: { kind } })
}

/** 从消息 content（字符串或块数组）提取纯文本 */
export function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
  }
  return ''
}

/**
 * trigger 保障（2026-08-19）：保证写入 L1 的每条记忆都带 `<!-- trigger: ... -->`。
 * 若内容已含 trigger 则原样返回；否则从 #标签 + 中文高频词（2-6 字，去停用词）自动提炼，
 * 附加在内容末尾。design 依据：MEMORY.md §4.2 格式要求每条带 trigger（触发词检索）。
 */
export const TRIGGER_STOP = new Set(['一个','我们','他们','这个','那个','什么','怎么','需要','要求','进行','以及','相关','问题','时候','内容','这些','那些','必须','可以','不要','不能','应该','用户','系统','直接','自动','然后','并且','或者','如果','因为','所以','但是','就是','没有','已经','还是','可能','主要','所有','其他','一般','具体','这里','那里','之后','之前','现在','今天','昨天','明天','最后','第一','第二','第三','方面','情况','方式','方法','过程','结果','影响','作用','目的','意义','来源','涉及','包含','包括','属于','存在','出现','发生','发现','导致','造成','通过','使用','利用','采用','进行'])
export const TRIGGER_META_TAGS = new Set(['规则','偏好','边界','记忆','用户','工作流','标准','安全','规范','工具','配置','验证','事实','线索','经验','教训'])
export function ensureTrigger(text) {
  if (!text) return text
  if (/<!--\s*trigger:/.test(text)) return text
  // ① #标签（排除元标签）
  const tags = [...text.matchAll(/#([\u4e00-\u9fffA-Za-z0-9_-]+)/g)].map((m) => m[1]).filter((t) => !TRIGGER_META_TAGS.has(t))
  // ② 中文词频（2-6 字，去停用词）
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, ' ')
  const freq = {}
  for (const w of cjk.split(/\s+/)) {
    if (w.length < 2 || w.length > 6 || TRIGGER_STOP.has(w)) continue
    freq[w] = (freq[w] || 0) + 1
  }
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w)
  // ③ 合并去重，限 6 个
  const trig = [...new Set([...tags, ...topWords])].slice(0, 6)
  if (!trig.length) trig.push('memory')
  return `${text} <!-- trigger: ${trig.join(',')} -->`
}

/** 手术级注入分档（§8.5）：按任务类型与输入长度自动切换 400/1200/2000 */
export function classifyBudget(text) {
  const len = (text || '').length
  const deep = /控制论|复盘|策略|评估|设计|方案|深度|人物|情感|多线程|文档审阅|分析/.test(text)
  const simple = /^(查|看|确认|路径|端口|密码|地址|时间|几点)/.test(text) || len <= 24
  if (deep) return 2000
  if (simple) return 400
  return 1200
}
