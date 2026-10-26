/**
 * dsh-skill-search — skill_search 按需检索工具（从 dsh-skill-lazy v0.1.0 抽取）
 *
 * v0.1.1（2026-10-15）：
 *   1. DOMAIN_MAP 补现役 hithink-finance-*（10 个）——原表是 8 月 67 技能快照，新技能走关键词
 *      兜底时被 dev 的 'CLI'（描述里的 "hithink-finance CLI"）抢走，data/valuation/research
 *      三个金融技能被误分到「代码开发」（实测）
 *   2. a-share 关键词补 'a 股' 空格变体；覆盖报告的空域由 12 行刷屏改一行汇总（噪音）
 *
 * 保留：
 *   1. skill_search：按查询词从完整技能目录检索，13 域 DOMAINS 中文关键词桥归域，
 *      bigram 评分（scoreSkill）排序，usage.json 调用频率做同分tiebreak并随结果展示，
 *      附领域覆盖检查（缺口提示）。
 *   2. 支撑工具函数 + tools/post-execute 的 usage 记录钩子（skill 工具调用跨会话累计）。
 *
 * 已砍掉（相对 dsh-skill-lazy）：agent/pre-step 目录注入改写、领域折叠、主动匹配提示、
 * skill_mece_check 工具、cost_audit 工具。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-skill-search'
export const inject = ['tools', 'skills']

const HOME = homedir()
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const USAGE_FILE = join(PLUGIN_DIR, 'usage.json')
const SKILLS_DIR = join(HOME, '.dsh', 'skills')

// v0.2.1：技能文件路径归一。SkillSummary.path 可能是相对路径（实测 `.agents/skills/<名>/SKILL.md`，
// 基准是宿主进程 cwd / 家目录），按「会话 cwd → 宿主 cwd → HOME」探测第一个真实存在的绝对路径。
function absSkillFile(p, cwd) {
  if (typeof p !== 'string' || !p) return null
  const raw = p.replace(/^~(?=\/|$)/, HOME)
  if (isAbsolute(raw)) return raw
  for (const base of [cwd, process.cwd(), HOME]) {
    if (!base) continue
    const abs = resolve(base, raw)
    if (existsSync(abs)) return abs
  }
  return null
}

// ---------- MECE 领域映射（互斥且穷尽） ----------
// name → 领域 id 精确映射（67 个存量 skill 全量归类；新增未映射 skill 走关键词兜底 → other）
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
  'ponytail': 'thinking',
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
  // v0.2.1：现役 hithink-finance-* 技能（10 个）归类修正——原表停留在 8 月的 67 技能快照，
  // 新技能全走关键词兜底，而 dev 领域的关键词 'CLI' 又命中它们的描述（"hithink-finance CLI"），
  // 把 data/valuation/research 三个金融技能误分到「代码开发」（实测）。
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

// ---------- 工具函数 ----------

/** 描述 → 关键词集合（英文单词 + 中文连续串，去停用词） */
const STOP_WORDS = new Set(['the','a','an','and','or','of','to','in','for','with','on','as','by','from','use','using','when','what','how','this','that','is','are','be','do','does','can','will','should','document','file','create','make','your','you','user','skill','skills','输出','输入','用于','使用','场景','用户','文档','文件','进行','以及','或者','如果','需要'])
function keywordsOf(text) {
  const t = String(text || '')
  const en = (t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOP_WORDS.has(w))
  const cn = (t.match(/[\u4e00-\u9fa5]{2,4}/g) || [])
  return [...new Set([...en, ...cn])]
}

// ---------- usage 读写 ----------

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

// ---------- MECE：领域归类 / 分组 / 覆盖矩阵 ----------

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

/** 把一批 skill 按领域分组（组间互斥：每 skill 唯一归属；组内穷尽：列出全部命中） */
function groupByDomain(skills) {
  const groups = new Map(DOMAINS.map((d) => [d.id, []]))
  for (const s of skills) {
    const id = domainOf(s.name, s.description)
    groups.get(id).push(s)
  }
  return groups
}

/** 领域覆盖矩阵：每个领域存量技能数与缺口标记 */
function coverageMatrix(allSkills) {
  const counts = new Map(DOMAINS.map((d) => [d.id, 0]))
  const members = new Map(DOMAINS.map((d) => [d.id, []]))
  for (const s of allSkills) {
    const id = domainOf(s.name, s.description)
    counts.set(id, (counts.get(id) || 0) + 1)
    members.get(id).push(s.name)
  }
  return DOMAINS.map((d) => ({
    id: d.id,
    label: d.label,
    count: counts.get(d.id) || 0,
    members: (members.get(d.id) || []).sort(),
    gap: (counts.get(d.id) || 0) === 0 ? '空域' : (counts.get(d.id) || 0) < 2 ? '弱域' : '正常'
  }))
}

// ---------- skill_search 打分 ----------

function scoreSkill(query, skill) {
  const q = query.toLowerCase()
  const name = skill.name.toLowerCase()
  const desc = `${skill.description || ''} ${skill.whenToUse || ''} ${skill.triggers || ''}`.toLowerCase()
  let score = 0
  // 完整词/子串命中
  if (name.includes(q)) score += 100
  if (desc.includes(q)) score += 30
  // 用户消息点名技能名（query 含完整 kebab 名）→ 强相关 +100
  if (q.includes(name)) score += 100
  // 中文 2-gram 交集：query 与 desc 共享的相邻两字
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
    topK: config.topK ?? 6,
  }

  // ---------- 技能元数据读取（ctx.skills.list 优先，fallback 读 SKILLS_DIR frontmatter） ----------
  /** 给 skill 对象补充 triggers（官方 list 不保证返回；从 SKILL.md frontmatter 行级提取） */
  function enrichTriggers(skills, cwd) {
    return (skills || []).map((s) => {
      if (s.triggers) return s
      try {
        // v0.2.1：优先用 SkillSummary.path（实测为相对路径 '.agents/skills/<名>/SKILL.md'）——
        // 原实现只读 ~/.dsh/skills（本机为空）⇒ triggers 永不补充，评分少一路信号。
        const f = (typeof s.path === 'string' && absSkillFile(s.path, cwd))
          || join(SKILLS_DIR, s.name, 'SKILL.md')
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

  // ---------- 1. tools/post-execute：skill 调用频率 ----------
  // rc.7 起 createExecution 的参数字段是 `arguments` 不是 `args`；双字段兼容读取。
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

  // ---------- 2. skill_search：按需检索 + MECE 分组 ----------
  ctx.tools.register(defineTool({
    name: 'skill_search',
    description: '按关键词检索技能库，返回按 MECE 领域分组的结果与领域覆盖报告。任务可能对应多个技能、或需要跨技能匹配时先用它。',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords describing the task (Chinese or English).' },
      limit: { type: 'number', description: `Max hits per domain group (default ${cfg.topK}).` },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const query = String(input.query || '').trim()
      if (!query) return '[skill_search] 需要 query 参数'
      const lookup = {
        cwd: exec.agent?.session?.header?.cwd,
        signal: exec.signal,
        scope: exec.agent,
      }
      let all = []
      try {
        all = enrichTriggers(await ctx.skills.list(lookup), lookup.cwd)
      } catch {
        all = []
      }
      if (all.length === 0) return '[skill_search] 技能目录不可用'

      const limit = Math.max(1, Math.min(20, Number(input.limit) || cfg.topK))
      const usage = loadUsage()
      // 相关度降序；同分时 usage.json 调用频率高的在前
      const scored = all
        .map((s) => ({ s, score: scoreSkill(query, s) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (usage[b.s.name] || 0) - (usage[a.s.name] || 0))

      const lines = []
      lines.push(`# skill_search: "${query}"（命中 ${scored.length}/${all.length}）`)
      lines.push('')

      if (scored.length === 0) {
        lines.push('未命中任何技能。')
      } else {
        const groups = groupByDomain(scored.map((x) => x.s))
        lines.push('## 命中结果（MECE 分组：组间互斥、组内按相关度排序）')
        for (const d of DOMAINS) {
          const hits = groups.get(d.id) || []
          if (hits.length === 0) continue
          lines.push('')
          lines.push(`### ${d.label}（${hits.length}）`)
          for (const s of hits.slice(0, limit)) {
            const cnt = usage[s.name] || 0
            const when = s.whenToUse ? `\n  whenToUse: ${s.whenToUse.split('\n')[0].slice(0, 120)}` : ''
            lines.push(`- \`${s.name}\`（调用 ${cnt} 次）: ${s.description}${when}`)
          }
        }
      }

      // 领域覆盖检查（穷尽性）
      const matrix = coverageMatrix(all)
      lines.push('')
      lines.push('## 领域覆盖检查（穷尽性）')
      const filled = matrix.filter((m) => m.count > 0)
      const empty = matrix.filter((m) => m.count === 0)
      for (const m of filled) {
        lines.push(`- ${m.label}: ${m.count} 个技能${m.count < 2 ? ' ⚠️ 弱域' : ''}`)
      }
      if (empty.length) {
        // v0.2.1：空域逐行刷屏改为一行汇总——原输出对只有 10 个技能的库报 12 行「⚠️ 空域」，
        // 既是噪音也容易被误读成故障；空域语义是"未建"，不计入缺口告警。
        lines.push(`- 未建领域（${empty.length}）：${empty.map((m) => m.label).join(' / ')}`)
      }
      const weak = filled.filter((m) => m.count === 1)
      if (weak.length) {
        lines.push('')
        lines.push(`ℹ️ 弱域（仅 1 个技能）：${weak.map((m) => m.label).join(' / ')}——如需覆盖可新建对应领域技能。`)
      } else if (empty.length === 0) {
        lines.push('')
        lines.push('✅ 全部领域均有技能覆盖，无缺口。')
      }
      return lines.join('\n')
    },
  }))
}
