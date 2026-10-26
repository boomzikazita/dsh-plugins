/**
 * dsh-skill-authoring — DSH skill 创建与审计插件（vibe-coding-cn 9 项质量门禁）
 *
 * v0.2.1（2026-10-15）：
 *   1. 门禁告警注入恒失效（@deepseek-ai/dsh-llm 不可解析 + 失败静默丢）→ 等价兜底工厂 + 回队 + 留痕
 *   2. 写入门禁作用域改「DSH 实际装载的 skills 根」（原硬编码 ~/.dsh/skills，本机为空 ⇒ 门禁从不触发），
 *      相对路径按会话 cwd 归一
 *   3. skill_audit：裸名先经 ctx.skills.list() 解析真实路径（原调用必失败）；输出按描述渲染 ✓/✗ 表
 *   4. DOMAIN_MAP 补 hithink-finance-*（与 dsh-skill-search 同步，避免 'CLI' 抢域）
 *
 * v0.2.0（2026-10-14，dsh 0.2 适配 + skill_mece_check 迁入）：
 *   1. 删除 `export const Config = null`（Config 不导出才安全，null 会崩设置页）
 *   2. 写入门禁钩子读参改 exec.arguments ?? exec.args 双读（铁律 F；不修则门禁静默失效）
 *   3. 修「edit 工具被跳过」与注释不符：write/edit 目标都过门禁预检
 *   4. 并入 skill_mece_check 工具（自 dsh-skill-lazy 迁入，工具名不变）——
 *      创作门禁链成四环：skill_check_name → skill_mece_check → skill_audit → skill_scaffold
 *   5. pre-step 注入 source 改 v4 形态 { kind: 'plugin:dsh-skill-authoring' }；
 *      SCRIPTS_DIR 改 fileURLToPath；Python 解释器走 config.python（默认 python3）+ UTF-8 env
 *
 * 准则来源：vibe-coding-cn（https://github.com/2025Emma/vibe-coding-cn）→
 *           hermes-agent-skill-authoring（hermes 侧元 skill）→ 本插件（DSH 执行器）
 *
 * 原则：所有 skill 创建/修改必须经过 9 项门禁。文档给标准（skill 版），本插件给执行。
 *
 * 工具：
 *   skill_check_name(name)              校验 skill 名称正则（DSH: ^[a-z0-9]+(-[a-z0-9]+)*$）
 *   skill_mece_check(name, description) 创建/评估前 MECE 检查（互斥重叠 + 领域覆盖矩阵）
 *   skill_audit(path)                   按 9 项门禁审计现有 SKILL.md，输出 ✓/✗ 表
 *   skill_scaffold(name, description)   生成符合门禁的 SKILL.md 骨架（含 references/index.md）
 *
 * 钩子：
 *   skill-write-guard  tools/pre-execute 当 write/edit 目标为 ~/.dsh/skills/<目录>/SKILL.md 时，
 *                      自动跑门禁预检，不合格返回警告（不拦截，提示先补全）
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-skill-authoring'
export const inject = ['tools', 'agents', 'skills']

const HOME = homedir()
// 铁律 F：fileURLToPath 解析插件自身路径（new URL().pathname 裸取在 Windows 产非法路径）
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scripts')
const SKILLS_DIR = join(HOME, '.dsh', 'skills')

// v0.2.1：技能路径归一。`SkillSummary.path` 可能是**相对路径**（本机实测
// `.agents/skills/<名>/SKILL.md`，基准是宿主进程 cwd / 家目录，不是会话工作区），
// 因此按「会话 cwd → 宿主 cwd → HOME」逐个试，取第一个真实存在的绝对路径；
// 全都不存在时回落会话 cwd（保持可诊断），并展开 `~`。
function absSkillPath(p, cwd) {
  if (typeof p !== 'string' || !p) return null
  const raw = p.replace(/^~(?=\/|$)/, HOME)
  if (isAbsolute(raw)) return raw
  for (const base of [cwd, process.cwd(), HOME]) {
    if (!base) continue
    const abs = resolve(base, raw)
    if (existsSync(abs)) return abs
  }
  return resolve(cwd || process.cwd(), raw)
}

// ---------- 注入消息工厂（v0.2.1）----------
// 优先宿主 @deepseek-ai/dsh-llm 的 createUserMessage；该裸导入在插件真实目录下可能解析不到
// （本机实测 ERR_MODULE_NOT_FOUND），原实现静默吞掉 ⇒ 门禁告警永远到不了模型。
let _createUserMessage = null // null=未探测 / function=宿主工厂 / false=不可用
let _injectFactoryWarned = false
async function makeInjectedUserMessage({ text, kind }) {
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
    console.warn('[dsh-skill-authoring] @deepseek-ai/dsh-llm 不可解析，注入消息走等价兜底形态（建议补 node_modules/@deepseek-ai/dsh-llm 软链）')
  }
  return Object.freeze({ id: randomUUID(), role: 'user', content, source: { kind } })
}

// ---------- MECE 支撑（v0.2.0 自 dsh-skill-lazy 迁入，供 skill_mece_check） ----------
// name → 领域 id 精确映射（67 个存量 skill 全量归类；新增未映射 skill 走关键词兜底 → other）
let DOMAIN_MAP = {
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

let DOMAINS = [
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

// 2026-10-25 单源化·三级读取：~/.dsh/skill-domains.json（本机覆盖）→ 插件目录自带（随 GitHub 仓库分发）→ 内置拷贝（兜底）
for (const _p of [join(HOME, '.dsh', 'skill-domains.json'), join(dirname(fileURLToPath(import.meta.url)), 'skill-domains.json')]) {
  try {
    const _sd = JSON.parse(readFileSync(_p, 'utf8'))
    if (_sd && typeof _sd.domainMap === 'object' && Array.isArray(_sd.domains)) {
      DOMAIN_MAP = _sd.domainMap
      DOMAINS = _sd.domains
      break
    }
  } catch { /* 该级缺失/损坏 → 下一级 */ }
}

/** 描述 → 关键词集合（英文单词 + 中文连续串，去停用词） */
const STOP_WORDS = new Set(['the','a','an','and','or','of','to','in','for','with','on','as','by','from','use','using','when','what','how','this','that','is','are','be','do','does','can','will','should','document','file','create','make','your','you','user','skill','skills','输出','输入','用于','使用','场景','用户','文档','文件','进行','以及','或者','如果','需要'])
const CN_STOP_WORDS = new Set(['市场','数据','股票','基金','指数','行情','用户','查询','管理','通过','需要','使用','系统','工具','文件','文档','进行','可以','相关'])
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

/** 互斥性：新技能与现有技能的重叠检测，返回 top 重叠项 */
function overlapCheck(newName, newDesc, allSkills) {
  const newKw = keywordsOf(`${newName} ${newDesc}`)
  if (newKw.length === 0) return []
  const scored = []
  for (const s of allSkills) {
    if (s.name === newName) continue // v0.2.2：自我匹配剔除（原实现把自己的 100% 塞进重叠榜，淹掉真信号）
    const base = keywordsOf(`${s.name} ${s.description}`)
    const shared = newKw.filter((k) => base.includes(k))
    if (shared.length === 0) continue
    scored.push({
      name: s.name,
      shared,
      ratio: shared.length / newKw.length, // 新技能被现有技能覆盖的比例
    })
  }
  return scored.sort((a, b) => b.ratio - a.ratio || b.shared.length - a.shared.length).slice(0, 6)
}

export function apply(ctx, config = {}) {
  // v0.2.0：Python 解释器走 config.python（默认 python3）；env 强制 UTF-8 防中文输出乱码
  const PYTHON = config.python || 'python3'
  const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  function py(script, args, input) {
    try {
      const out = execFileSync(PYTHON, [join(SCRIPTS_DIR, script), ...args], {
        input: input ?? '', encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: PY_ENV,
      })
      return { ok: true, out: out.trim() }
    } catch (e) {
      return { ok: false, out: String(e?.stderr || e?.message || e).trim() }
    }
  }

  // ---------- 工具 1：skill_scaffold ----------
  ctx.tools.register(defineTool({
    name: 'skill_scaffold',
    description: '按 vibe-coding-cn 9 项质量门禁生成新 skill 骨架：目录 + SKILL.md（frontmatter/whenToUse/Boundaries/QuickRef/Examples 占位）+ references/index.md。创建任何新 skill 前必须先调用本工具生成骨架，再填充内容。',
    parameters: {
      name: { type: 'string', required: true, description: 'skill 名（小写+连字符，如 my-skill）' },
      description: { type: 'string', required: true, description: '描述：what + when（什么能力 + 什么场景触发）' },
      dir: { type: 'string', description: '目标目录（默认 ~/.dsh/skills/<name>）' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input) {
      const args = ['scaffold', input.name, input.description]
      if (input?.dir) args.push('--dir', input.dir)
      const r = py('skill_gate.py', args)
      if (!r.ok) return `[skill_scaffold] 失败：${r.out}`
      return r.out
    },
  }))

  // ---------- 工具 2：skill_audit ----------
  ctx.tools.register(defineTool({
    name: 'skill_audit',
    description: '按 vibe-coding-cn 9 项质量门禁审计 SKILL.md：name/description/whenToUse/Boundaries/QuickRef/Examples/references/验证路径/操作手册风格，逐条输出 ✓/✗。创建或修改 skill 后必须运行自检。',
    parameters: {
      path: { type: 'string', required: true, description: 'SKILL.md 路径或 skill 名（先经 ctx.skills.list() 解析真实路径，回落 ~/.dsh/skills/<name>/SKILL.md）' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const raw = String(input?.path || '')
      let p = raw
      if (raw && !raw.includes('/') && !raw.includes('\\') && !raw.endsWith('.md')) {
        // v0.2.1：裸名先走 ctx.skills.list() 拿真实路径——本机 ~/.dsh/skills 为空（现役技能
        // 由外部 CLI 装在别处），原实现直接拼 SKILLS_DIR 必然返回"文件不存在"。
        try {
          const lookup = {
            cwd: exec?.agent?.session?.header?.cwd,
            signal: exec?.signal,
            scope: exec?.agent,
          }
          const all = await ctx.skills.list(lookup)
          const hit = (all ?? []).find((s) => s?.name === raw && typeof s.path === 'string')
          // 相对路径（实测 '.agents/skills/<名>/SKILL.md'）归一到宿主可读的绝对路径
          p = hit ? (absSkillPath(hit.path, lookup.cwd) || hit.path) : join(SKILLS_DIR, raw, 'SKILL.md')
        } catch {
          p = join(SKILLS_DIR, raw, 'SKILL.md')
        }
      }
      const r = py('skill_gate.py', ['audit', p])
      if (!r.ok) return `[skill_audit] 失败：${r.out}`
      // v0.2.1：按工具描述承诺渲染 ✓/✗ 表（原样返回 JSON，与描述不符）；解析失败则原样返回。
      try {
        const d = JSON.parse(r.out)
        if (d && Array.isArray(d.checks)) {
          const passed = d.passed ?? d.checks.filter((c) => c.ok).length
          const total = d.total ?? d.checks.length
          const rows = d.checks.map((c) => (c.ok ? `✓ ${c.title}` : `✗ ${c.title}　← ${c.detail ?? ''}`))
          return [`# skill_audit: ${d.path ?? p} — ${d.ok ? '✅ 通过' : '❌ 未通过'}（${passed}/${total}）`, '', ...rows].join('\n')
        }
      } catch { /* 非 JSON：原样返回 */ }
      return r.out
    },
  }))

  // ---------- 工具 3：skill_check_name ----------
  ctx.tools.register(defineTool({
    name: 'skill_check_name',
    description: '校验 skill 名称是否符合 DSH 规范（小写字母/数字，连字符分隔，如 my-skill）。创建 skill 前先校验名称。',
    parameters: {
      name: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input) {
      const r = py('skill_gate.py', ['check-name', input.name])
      if (!r.ok) return `[skill_check_name] 失败：${r.out}`
      return r.out
    },
  }))

  // ---------- 工具 4：skill_mece_check（v0.2.0 自 dsh-skill-lazy 迁入，工具名不变） ----------
  // 创建技能前 MECE 检查；创作门禁链四环：skill_check_name → skill_mece_check → skill_audit → skill_scaffold
  ctx.tools.register(defineTool({
    name: 'skill_mece_check',
    description: 'MECE check before creating or evaluating a skill. Given the proposed skill name and description, checks (1) mutual exclusivity — keyword overlap against every existing skill, with the shared keywords and overlap ratio, and (2) collective exhaustiveness — the domain coverage matrix of the whole skill library, flagging empty/weak domains and recommending where the new skill fits. Run this before scaffolding any new skill, and when auditing whether the library is complete.',
    parameters: {
      name: { type: 'string', required: true, description: 'Proposed skill name (kebab-case, e.g. my-new-skill).' },
      description: { type: 'string', required: true, description: 'Proposed skill description: what it does + when to use.' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const name = String(input.name || '').trim()
      const description = String(input.description || '').trim()
      if (!name || !description) return '[skill_mece_check] 需要 name 和 description'
      const lookup = {
        cwd: exec.agent?.session?.header?.cwd,
        signal: exec.signal,
        scope: exec.agent,
      }
      let all = []
      try {
        all = await ctx.skills.list(lookup)
      } catch {
        all = []
      }
      if (all.length === 0) return '[skill_mece_check] 技能目录不可用'

      const existing = all.some((s) => s.name === name)
      const targetDomain = domainOf(name, description)
      const dLabel = DOMAINS.find((d) => d.id === targetDomain)?.label || targetDomain

      const lines = []
      lines.push(`# skill_mece_check: "${name}"`)
      lines.push('')
      lines.push(`**归属领域（MECE 归类）**：${dLabel}`)
      if (existing) lines.push(`⚠️ 同名技能已存在：\`${name}\` —— 建议改为更新现有技能，而非新建。`)
      lines.push('')

      // 互斥性
      lines.push('## ① 互斥性（Mutually Exclusive）— 与现有技能重叠检测')
      const overlaps = overlapCheck(name, description, all)
      if (overlaps.length === 0) {
        lines.push('- ✅ 与现有技能无显著关键词重叠。')
      } else {
        lines.push(`- ⚠️ 检测到 ${overlaps.length} 个重叠候选（覆盖比例 = 现有技能包含新技能关键词的比例）：`)
        for (const o of overlaps) {
          lines.push(`  - \`${o.name}\` 覆盖 ${Math.round(o.ratio * 100)}% —— 共享词: ${o.shared.join(' / ')}`)
        }
        lines.push('')
        lines.push('  判定建议：')
        lines.push('  - 覆盖比例 > 50% → 高度重叠，优先考虑**扩展现有技能**而非新建；')
        lines.push('  - 30%~50% → 边界需在 whenToUse/Boundaries 中显式划清，防误触；')
        lines.push('  - < 30% → 重叠可接受，但仍需在描述中区分触发场景。')
      }
      lines.push('')

      // 穷尽性
      lines.push('## ② 穷尽性（Collectively Exhaustive）— 领域覆盖矩阵')
      const matrix = coverageMatrix(all)
      for (const m of matrix) {
        const mark = m.id === targetDomain ? ' ← 新技能落位' : ''
        lines.push(`- ${m.label}: ${m.count} 个技能 ${m.gap === '正常' ? '' : `⚠️ ${m.gap}`}${mark}`)
      }
      const target = matrix.find((m) => m.id === targetDomain)
      lines.push('')
      if (target && target.count === 0) {
        lines.push(`✅ 新技能将填补「${dLabel}」空域（${all.length + 1} 个技能后领域覆盖更完整）。`)
      } else if (target && target.count < 2) {
        lines.push(`ℹ️ 「${dLabel}」目前是弱域（${target.count} 个），新技能加入后仍建议后续审视是否需要更多覆盖。`)
      } else {
        lines.push(`ℹ️ 「${dLabel}」已有 ${target?.count ?? 0} 个技能，属正常覆盖；若新技能与它们边界清晰（见①），可接受。`)
      }
      lines.push('')
      lines.push('**结论**：是否新建由你拍板。若①无高重叠、②落位合理 → 可走 skill_scaffold 创建；若①高重叠 → 建议先更新现有技能。')
      return lines.join('\n')
    },
  }))

   // ---------- 钩子：SKILL.md 写入门禁（waterfall 契约：放行 next() / 拦截 {kind:'deny'}；警告走 pendingWarns→pre-step 注入）----------
  const pendingWarns = []
  // v0.2.1：作用域修正——原实现硬编码只认 `~/.dsh/skills`，而本机该目录为空（现役技能由
  // 外部 CLI 装到别处）⇒ 门禁永不触发；且相对路径直接拿 `target.includes('/skills/')` 判定会漏。
  // 现：从 ctx.skills.list() 的 path 反推「DSH 实际装载的 skills 根」，保留 ~/.dsh/skills 兜底，
  // 相对路径按会话 cwd 归一后再判归属（60s 缓存，避免每次写文件都列目录）。
  let skillRootsCache = { at: 0, roots: [] }
  async function skillRoots(exec) {
    if (Date.now() - skillRootsCache.at < 60_000 && skillRootsCache.roots.length) return skillRootsCache.roots
    const roots = new Set([SKILLS_DIR])
    try {
      const lookup = {
        cwd: exec?.agent?.session?.header?.cwd,
        signal: exec?.signal,
        scope: exec?.agent,
      }
      const all = await ctx.skills.list(lookup)
      for (const s of all ?? []) {
        if (typeof s?.path !== 'string' || !s.path.endsWith('SKILL.md')) continue
        const abs = absSkillPath(s.path, lookup.cwd)
        if (!abs) continue
        // 入根集两类：SKILL.md 自身目录 + 其**父目录**（= skills 根，本机实测 /home/boom/.agents/skills）。
        // 只加自身目录的话，"新建一个技能"的写目标不在任何根内 → 门禁对新建场景失效。
        roots.add(dirname(abs))
        roots.add(dirname(dirname(abs)))
      }
    } catch { /* 技能目录不可用：仅用兜底根 */ }
    skillRootsCache = { at: Date.now(), roots: [...roots] }
    return skillRootsCache.roots
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      // v0.2.0：edit 不再跳过（原代码 `if (toolName === 'edit') return next()` 与头注释
      // 「write/edit 目标为 SKILL.md 时过预检」不符）；真实门径是下面的 target 判定
      // 铁律 F：执行参数读 exec.arguments ?? exec.args（rc 系参数字段为 arguments，旧字段 args 兜底）
      const args = exec?.arguments ?? exec?.args ?? {}
      const raw = args.file_path || args.path || ''
      if (!raw || !String(raw).endsWith('SKILL.md')) return next()
      const cwd = exec?.agent?.session?.header?.cwd
      // 与技能根同一归一函数（含 ~ 展开、多基准探测），避免"根是绝对、目标是相对"判不上。
      const target = absSkillPath(String(raw), cwd) || String(raw)
      const roots = await skillRoots(exec)
      if (!roots.some((r) => target.startsWith(r))) return next() // 只对 DSH 装载的 skills 根生效
      const r = py('skill_gate.py', ['audit', target])
      if (r.ok) {
        let data
        try { data = JSON.parse(r.out) } catch { return next() }
        // v0.2.1：新建场景排除——写了门禁才真正生效后，"目标文件尚不存在"会被 audit 报
        // ok:false/error（文件不存在），那不是"未达标"，不该告警。
        if (data?.error || !Array.isArray(data?.checks) || data.checks.length === 0) return next()
        if (data.ok === false) {
          const fails = data.checks.filter((c) => !c.ok).map((c) => c.title)
          pendingWarns.push(`[skill-authoring] 该 SKILL.md 未通过 9 项门禁（未达标：${fails.join(' / ')}）。建议运行 skill_audit 补全。`)
        }
      }
    } catch {
      // 钩子失败不阻塞写操作
    }
    return next()
  })

  // 警告注入通道（与 dsh-cybernetics 同构）：agent/pre-step waterfall 追加 user 消息
  if (typeof ctx.on === 'function' && ctx.agents) {
    try {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (!decision || decision.kind === 'reject') return decision
        if (pendingWarns.length === 0) return decision
        const warns = pendingWarns.splice(0)
        try {
          const msg = await makeInjectedUserMessage({
            text: warns.join('\n'),
            kind: 'plugin:dsh-skill-authoring',
          })
          return { ...decision, messages: [...decision.messages, msg] }
        } catch (e) {
          // v0.2.1：失败回队 + 留痕（原实现静默丢弃，门禁告警因此永远不可见）
          pendingWarns.unshift(...warns)
          console.warn(`[dsh-skill-authoring] 门禁告警注入失败（已回队 ${warns.length} 条）: ${String(e?.message || e)}`)
          return decision
        }
      })
    } catch { /* pre-step 不可用则跳过 */ }
  }
}
