// MECE 归域与重叠检测（2026-10-25 从 index.js 下沉，代码 verbatim；模块预算 ≤500 治理）
// DOMAIN_MAP/DOMAINS 由调用方注入（三级加载完成后的最终值）
export function makeMece(DOMAIN_MAP, DOMAINS) {
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

  return { keywordsOf, domainOf, coverageMatrix, overlapCheck }
}
