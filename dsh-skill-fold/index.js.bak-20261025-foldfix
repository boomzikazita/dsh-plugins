/**
 * dsh-skill-fold — skill 目录折叠（2026-10-16 自 dsh-skill-lazy v0.2.x 移植精简版）
 *
 * 只留两件事：
 *   1. agent/pre-step（prepend）：官方 catalog 消息文本替换为紧凑版
 *      （名字 + ≤40 字符摘要，usage 频率降序，按当前任务折叠非匹配域），
 *      source.entries 不动 → 官方 digest/去重不受影响。
 *   2. tools/post-execute：skill 工具调用计数 → usage.json（exec.arguments 双读）。
 * skill_search / skill_mece_check 已由 dsh-skill-search / dsh-skill-authoring 提供，本插件不注册工具。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const name = 'dsh-skill-fold'
export const inject = ['tools', 'agents', 'skills']


const HOME = homedir()
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const USAGE_FILE = join(PLUGIN_DIR, 'usage.json')
const SKILLS_DIR = join(HOME, '.dsh', 'skills')

// 领域表与 dsh-skill-authoring v0.2.2 同源（构建时抽取，勿手改）
const DOMAIN_MAP = {
  'a-share-daily-analyst': 'a-share',
  'a-share-daily-report-pipeline': 'a-share',
  'a-share-market-analyst': 'a-share',
  'a-share-market-data': 'a-share',
  'a-share-market-news': 'a-share',
  'chief-of-staff': 'gov-doc',
  'chinese-official-documents': 'gov-doc',
  'gongwen-format': 'gov-doc',
  'gongwen-polish': 'gov-doc',
  'gongwen-writing-methods': 'gov-doc',
  'meeting-minutes': 'gov-doc',
  'senior-government-report-writing': 'gov-doc',
  'docx': 'office-doc',
  'nano-pdf': 'office-doc',
  'ocr-and-documents': 'office-doc',
  'officecli': 'office-doc',
  'pdf': 'office-doc',
  'pdf-cjk': 'office-doc',
  'powerpoint': 'office-doc',
  'ppt-structure-expert': 'office-doc',
  'xlsx': 'office-doc',
  'cli-anything': 'dev',
  'codebase-inspection': 'dev',
  'deepseek-harness-operations': 'dev',
  'project-analysis': 'dev',
  'project-context': 'dev',
  'python-debugpy': 'dev',
  'systematic-debugging': 'dev',
  'time-bomb-patching': 'dev',
  'github-auth': 'github',
  'github-blocked-fallback': 'github',
  'github-code-review': 'github',
  'github-issues': 'github',
  'github-pr-workflow': 'github',
  'github-project-assessment': 'github',
  'github-repo-management': 'github',
  'github-trending-cn': 'github',
  'chinese-publication-research': 'writing',
  'grounded-citations': 'writing',
  'humanizer': 'writing',
  'resume-authoring': 'writing',
  'agent-memory-system-design': 'memory-kb',
  'honcho-memory-setup': 'memory-kb',
  'llm-wiki': 'memory-kb',
  'memory': 'memory-kb',
  'obsidian': 'memory-kb',
  'siyuan-note': 'memory-kb',
  'task-context': 'memory-kb',
  'task-management': 'memory-kb',
  'wiki-ops': 'memory-kb',
  'huashu-nuwa': 'thinking',
  'maozedong-perspective': 'thinking',
  'mckinsey-content-editor': 'thinking',
  'policy-analysis-expert': 'thinking',
  'stepwise-execution': 'thinking',
  'linux-service-longevity': 'ops',
  'vaultwarden-selfhosted': 'ops',
  'computer-use': 'ops',
  'architecture-diagram': 'design',
  'multimodal-image-analysis': 'design',
  'web-content-capture': 'design',
  'interrupted-session-recovery': 'dsh-platform',
  'evaluating-ai-tools': 'research',
  'financial-report-deep-analysis': 'research',
  'technical-counter-examples': 'research',
  'hermes-agent-skill-authoring': 'skill-eng',
  // v0.2.1：与 dsh-skill-search 同步——现役 hithink-finance-* 技能（10 个）归类，
  // 原表停留在 8 月的 67 技能快照，新技能走关键词兜底时会被 dev 的 'CLI' 抢走。
  'hithink-finance-market': 'a-share',
  'hithink-finance-financials': 'a-share',
  'hithink-finance-fund': 'a-share',
  'hithink-finance-index': 'a-share',
  'hithink-finance-shared': 'a-share',
  'hithink-finance-special-data': 'a-share',
  'hithink-finance-data': 'a-share',
  'hithink-finance-valuation': 'a-share',
  'hithink-finance-research': 'a-share',
  'hithink-finance-symbol': 'a-share',
  // v0.2.2：迁移审计补表——原 21 条未映射 skill 全落「其他」，逐一归位；ponytail 族从 thinking 改归 dev（编码工具）
  'access-governance': 'ops',
  'async-result-verification': 'dev',
  'baseline-diff-monitoring': 'ops',
  'blocked-page-recovery': 'research',
  'competitor-news-monitor': 'research',
  'junshi': 'thinking',
  'linux-machine-cleanup': 'ops',
  'merge-reconciler': 'github',
  'ponytail': 'dev',
  'ponytail-debt': 'dev',
  'ponytail-help': 'dev',
  'ponytail-review': 'dev',
  'reddit-reading': 'research',
  'remote-desktop-access': 'ops',
  'requesting-code-review': 'dev',
  'rss-feeds': 'research',
  'sdlc-review': 'dev',
  'simplify-code': 'dev',
  'spike': 'dev',
  'test-driven-development': 'dev',
  'vault-fragment-lookup': 'memory-kb',
  'weekly-review-planning': 'memory-kb',
  'hermes-agent-skill-authoring': 'skill-eng',
  'dsh-operations': 'dsh-platform',
}

const DOMAINS = [
  { id: 'a-share', label: 'A股投资', keywords: ['A股', 'a 股', '股票', '行情', '复盘', '北向', '涨停', 'market', 'stock'] },
  { id: 'gov-doc', label: '政务公文', keywords: ['公文', '请示', '通知', '报告', '纪要', '汇报', '讲话', 'gongwen', 'official'] },
  { id: 'office-doc', label: '办公文档', keywords: ['Word', 'Excel', 'PPT', 'PDF', 'docx', 'xlsx', 'pptx', '排版', '文档', 'OCR', '扫描', '提取文字'] },
  { id: 'dev', label: '代码开发', keywords: ['调试', 'debug', '代码', 'CLI', 'harness', 'patch', '编译', 'git'] },
  { id: 'github', label: 'GitHub 生态', keywords: ['github', 'pull request', 'merge request', 'issue', 'clone', 'repository', 'repo ', 'ci/cd', 'github action'] },
  { id: 'writing', label: '写作与内容', keywords: ['写作', '润色', '简历', '引用', '出版', 'humanize', 'citations'] },
  { id: 'memory-kb', label: '记忆与知识管理', keywords: ['记忆', '召回', 'wiki', '笔记', 'Obsidian', '思源', 'memory', '知识库'] },
  { id: 'thinking', label: '思维框架', keywords: ['思维', '框架', '分析', '矛盾', '麦肯锡', '结构化', 'perspective'] },
  { id: 'ops', label: '系统运维', keywords: ['运维', '部署', 'Docker', '服务', 'vaultwarden', '长寿', 'service'] },
  { id: 'design', label: '视觉与设计', keywords: ['架构图', 'SVG', '图片', '图像', '设计', '截图', 'vision', '读图', '看图', '识别', 'OCR', '照片'] },
  { id: 'dsh-platform', label: 'DSH 平台', keywords: ['dsh', '会话恢复', '中断', 'resume', 'harness'] },
  { id: 'research', label: '分析与研究', keywords: ['研究', '评估', '财报', '反例', '调研', 'research', 'audit'] },
  { id: 'skill-eng', label: '技能工程', keywords: ['技能工程', '技能蒸馏', '技能门禁', 'skill_audit', 'skill_scaffold', 'skill 创建', 'skill 蒸馏'] },
  { id: 'other', label: '其他', keywords: [] },
]

const CN_STOP_WORDS = new Set(['市场','数据','股票','基金','指数','行情','用户','查询','管理','通过','需要','使用','系统','工具','文件','文档','进行','可以','相关'])
const STOP_WORDS = new Set(['the','and','for','with','that','this','from','are','was','were','have','has','had','not','but','can','will','your','you','use','using','used','when','how','what','which','into','about','based','via','skill','skills'])


function keywordsOf(text) {
  const t = String(text || '')
  const en = (t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOP_WORDS.has(w))
  // CJK：整段连续汉字取为词（2~12 字），不定宽切碎——原 {2,4} 会把「数据分析师」切成「数据/分析师」断词
  const cn = (t.match(/[一-龥]{2,12}/g) || []).filter((w) => !CN_STOP_WORDS.has(w))
  return [...new Set([...en, ...cn])]
}

function domainOf(name, description) {
  const direct = DOMAIN_MAP[name]
  if (direct) return direct
  const text = `${name} ${description || ''}`.toLowerCase()
  for (const d of DOMAINS) {
    if (d.id === 'other') continue
    for (const k of d.keywords) {
      // 英文关键词最短 3 字符，避免 CI/PR 这类 2 字符词误匹配（如 simplicity 里的 "ci"）
      if (/^[a-z][a-z0-9 /-]*$/.test(k) && k.length < 3) continue
      if (text.includes(k.toLowerCase())) return d.id
    }
  }
  return 'other'
}

function shorten(desc, max = 40) {
  const normalized = String(desc || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const firstSentence = normalized.split(/[。！？!?.]/)[0] || normalized
  return firstSentence.length <= max ? firstSentence : `${firstSentence.slice(0, max - 1)}…`
}

function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function readCatalogEntries(source) {
  const entries = source?.entries
  if (!Array.isArray(entries)) return void 0
  const out = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return void 0
    const { name, description } = entry
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return void 0
    out.push({ name, description })
  }
  return out
}

function loadUsage() {
  try {
    if (!existsSync(USAGE_FILE)) return {}
    return JSON.parse(readFileSync(USAGE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function bumpUsage(name) {
  try {
    const usage = loadUsage()
    usage[name] = (usage[name] || 0) + 1
    mkdirSync(PLUGIN_DIR, { recursive: true })
    writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2))
  } catch {
    // 记录失败不阻塞
  }
}

function renderCompactCatalog(entries, usage, cfg, query = '') {
  const maxLen = cfg.catalogDescriptionMaxLength ?? 40
  const sortByUsage = cfg.sortByUsage ?? true
  const foldEnabled = cfg.foldEnabled ?? true
  const foldKeepDomains = cfg.foldKeepDomains ?? 1   // 展开的匹配域数
  const foldKeepFrequent = cfg.foldKeepFrequent ?? 5 // 额外展开的高频 skill 数
  const sorted = sortByUsage
    ? [...entries].sort((a, b) => (usage[b.name] || 0) - (usage[a.name] || 0) || a.name.localeCompare(b.name))
    : entries

  // 领域折叠（2026-08-21，杠杆 2）：按当前任务 query 判定匹配域，
  // 只展开「匹配域 + 高频 skill」，其余域折叠成一行（需要时 skill_search）。
  let lines = []
  let folded = [] // {domain, count, names}
  if (foldEnabled && query && query.trim()) {
    const taskDomain = domainOf('', query) // query 直接判域（无 name）
    const freqNames = new Set(sorted.slice(0, foldKeepFrequent).map((e) => e.name))
    const expanded = []
    const foldedByDomain = new Map()
    for (const e of sorted) {
      const dom = domainOf(e.name, e.description)
      if (freqNames.has(e.name) || dom === taskDomain || taskDomain === 'other') {
        expanded.push(e)
      } else {
        const rec = foldedByDomain.get(dom) || { count: 0, names: [] }
        rec.count += 1
        rec.names.push(e.name)
        foldedByDomain.set(dom, rec)
      }
    }
    lines = expanded.map((e) => `- \`${e.name}\`: ${escapeText(shorten(e.description, maxLen))}`)
    for (const [dom, rec] of foldedByDomain) {
      const label = DOMAINS.find((d) => d.id === dom)?.label || dom
      lines.push(`- ⏳ 另有 ${rec.count} 个 ${label} skill（${rec.names.slice(0, 6).map((n) => `\`${n}\``).join(' ')}…）：需要时用 skill_search 检索`)
    }
  } else {
    lines = sorted.map((e) => `- \`${e.name}\`: ${escapeText(shorten(e.description, maxLen))}`)
  }
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. This is a compact catalog (name + one-line summary, sorted by usage). The following skills are available in this session:',
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
    'For full descriptions and cross-skill matching, call the `skill_search` tool with your task keywords — results come grouped by MECE domains with coverage-gap hints. When creating or evaluating a skill, call `skill_mece_check` first to verify mutual exclusivity and full coverage against the existing library.',
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>'
  ].join('\n')
}

function scoreSkill(query, skill) {
  const q = query.toLowerCase()
  const name = skill.name.toLowerCase()
  const desc = `${skill.description || ''} ${skill.whenToUse || ''} ${skill.triggers || ''}`.toLowerCase()
  let score = 0
  // 完整词/子串命中
  if (name.includes(q)) score += 100
  if (desc.includes(q)) score += 30
  // 2026-08-19 补充：用户消息点名技能名（query 含完整 kebab 名）→ 强相关 +100
  if (q.includes(name)) score += 100
  // 中文 2-gram 交集（2026-08-19 增强，借鉴 L1 lane1）：query 与 desc 共享的相邻两字
  // 解决「改插件」这类动作+对象查询——对象词「插件」与 desc 的 2-gram 命中即可计分
  if (/[\u4e00-\u9fa5]/.test(q)) {
    const qb = new Set()
    for (let i = 0; i + 1 < q.length; i += 1) qb.add(q.slice(i, i + 2))
    const db = new Set()
    for (let i = 0; i + 1 < desc.length; i += 1) db.add(desc.slice(i, i + 2))
    let inter = 0
    for (const g of qb) if (db.has(g)) inter += 1
    if (inter >= 1) score += 3 * inter
  }
  // 查询分词命中
  const tokens = keywordsOf(query)
  for (const t of tokens) {
    if (name.includes(t)) { score += 12; continue }
    if (desc.includes(t)) { score += 4; continue }
    // 中文连续词拆分 bigram 补充匹配：query 的"公文排版"应对应描述中的"公文按…排版"（两词被隔开）
    if (/^[\u4e00-\u9fa5]{3,}$/.test(t)) {
      const grams = new Set()
      for (let i = 0; i + 1 < t.length; i += 1) grams.add(t.slice(i, i + 2))
      let hits = 0
      for (const g of grams) if (desc.includes(g)) hits += 1
      if (hits >= 2) score += 3 * hits
    }
  }
  return score
}

// ---------- 插件主体 ----------

export function apply(ctx, config = {}) {
  const cfg = {
    catalogDescriptionMaxLength: config.catalogDescriptionMaxLength ?? 40,
    sortByUsage: config.sortByUsage ?? true,
    matchThreshold: config.matchThreshold ?? 3,
    foldEnabled: config.foldEnabled ?? true,
    foldKeepDomains: config.foldKeepDomains ?? 1,
    foldKeepFrequent: config.foldKeepFrequent ?? 5,
  }
  const state = { lastHintSig: '' }

  function enrichTriggers(skills) {
    return (skills || []).map((s) => {
      if (s.triggers) return s
      try {
        const f = join(SKILLS_DIR, s.name, 'SKILL.md')
        if (!existsSync(f)) return s
        const raw = readFileSync(f, 'utf8')
        const fm = raw.match(/^---\n([\s\S]*?)\n---/)
        if (!fm) return s
        const lines = fm[1].split('\n')
        const ti = lines.findIndex((l) => l.trim() === 'triggers:')
        if (ti === -1) return s
        const triggers = []
        for (let j = ti + 1; j < lines.length; j += 1) {
          const mm = lines[j].match(/^\s*-\s*["']?(.+?)["']?\s*$/)
          if (mm) triggers.push(mm[1])
          else break
        }
        return triggers.length ? { ...s, triggers: triggers.join(' ') } : s
      } catch { return s }
    })
  }

  async function listAllSkills(ctx) {
    try {
      const all = await ctx.skills.list({})
      if (Array.isArray(all) && all.length > 0) return enrichTriggers(all)
    } catch { /* fallthrough */ }
    const out = []
    try {
      for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const f = join(SKILLS_DIR, d.name, 'SKILL.md')
        if (!existsSync(f)) continue
        const raw = readFileSync(f, 'utf8')
        const fm = raw.match(/^---\n([\s\S]*?)\n---/)
        if (!fm) continue
        const meta = { name: d.name, description: '', whenToUse: '', triggers: '' }
        for (const line of fm[1].split('\n')) {
          const m = line.match(/^(description|whenToUse|triggers):\s*(.*)$/)
          if (m) meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
        }
        out.push(meta)
      }
    } catch { /* 读取失败返回已收集部分 */ }
    return out
  }

  function extractLatestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      const src = m?.source
      if (src?.kind === 'skill-catalog' || src?.kind === 'plugin') continue
      const content = m.content
      const text = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '')
      if (text && text.trim()) return text.slice(0, 300)
    }
    return ''
  }

  function buildMatchHint(query, all, usage) {
    if (!query) return null
    const scored = all
      .map((s) => ({ s, score: scoreSkill(query, s) }))
      .filter((x) => x.score >= cfg.matchThreshold)
      .sort((a, b) => b.score - a.score)
    if (scored.length === 0) return null
    const lines = ['[技能匹配提示] 当前任务可能与以下 skill 相关，按需用 skill 工具加载（不相关可忽略）：']
    for (const { s, score } of scored.slice(0, 3)) {
      const cnt = usage[s.name] || 0
      lines.push(`- \`${s.name}\`（相关度 ${score}${cnt ? `，已用 ${cnt} 次` : ''}）：${shorten(s.description, 50)}`)
    }
    return lines.join('\n')
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const messages = decision.messages || []
    let updated = decision
    // (a) catalog 精简（原有逻辑）+ 领域折叠（2026-08-21：按当前任务 query 折叠非匹配域）
    const idx = messages.findIndex((m) => m?.source?.kind === 'skill-catalog')
    if (idx !== -1) {
      const msg = messages[idx]
      const entries = readCatalogEntries(msg.source)
      if (entries && entries.length > 0) {
        const query = extractLatestUserText(updated.messages || messages)
        const text = renderCompactCatalog(entries, loadUsage(), cfg, query)
        updated = { ...updated, messages: messages.map((m, i) => (i === idx ? { ...m, content: [{ type: 'text', text }] } : m)) }
      }
    }
    // (b) 技能匹配提示（2026-08-19 L1：把「模型自觉匹配」变成「系统提示匹配」；
    //     同一条用户消息只提示一次——state.lastHintSig 去重，避免工具轮重复刷屏）
    try {
      const query = extractLatestUserText(updated.messages || messages)
      if (query) {
        const all = await listAllSkills(ctx)
        if (all.length > 0) {
          const hint = buildMatchHint(query, all, loadUsage())
          if (hint) {
            const sig = query.slice(0, 40)
            if (state.lastHintSig !== sig) {
              state.lastHintSig = sig
              const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
              const hintMsg = createUserMessage({
                content: [{ type: 'text', text: hint }],
                source: { kind: 'plugin:dsh-skill-fold' },
              })
              return { ...updated, messages: [...(updated.messages || messages), hintMsg] }
            }
          }
        }
      }
    } catch { /* 匹配提示失败不阻塞回合 */ }
    return updated
  }, { prepend: true })
  ctx.on('tools/post-execute', (exec, result, next) => {
    try {
      const toolName = exec?.tool?.name || exec?.name || exec?.id || ''
      const argsName = exec?.arguments?.name ?? exec?.args?.name
      if (toolName === 'skill' && argsName) bumpUsage(String(argsName))
    } catch {
      // 频率记录失败不阻塞调用
    }
    return next()
  })
}
