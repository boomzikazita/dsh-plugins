/**
 * dsh-model-fallback — Client 半：设置页管理面板（settings.section: model-fallback）。
 *
 * 通道：ctx.connection.rpc.call('/dsh-model-fallback', endpoint, payload)
 * 端点：catalog（实时 provider/模型目录）/ get（配置回显）/ save（持久化）。
 * 样式：不引任何宿主组件包；颜色走 currentColor + color-mix，随主题明暗自适应。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-fallback',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const inputCss = {
      background: 'transparent', color: 'inherit', fontSize: 13,
      border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
      borderRadius: 6, padding: '4px 8px', outline: 'none',
    }
    const btnCss = {
      ...inputCss, cursor: 'pointer', padding: '4px 14px',
    }
    const primaryBtnCss = {
      ...btnCss, fontWeight: 600,
      background: 'color-mix(in srgb, currentColor 10%, transparent)',
    }
    const cardCss = {
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }
    const rowCss = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const hintCss = { fontSize: 12, opacity: 0.65, lineHeight: 1.6 }

    function Labeled(props) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: 0.9 } },
        props.label, props.children)
    }

    /** provider 选择：已注册目录真下拉 + 「自定义…」切自由输入（目录外/未注册路由）。 */
    function ProviderField(props) {
      const known = (props.providers || []).map(p => p.id)
      const CUSTOM = '__custom__'
      const inList = known.includes(props.value)
      const selectValue = inList ? props.value : CUSTOM
      const options = [...(props.allowWildcard ? ['*'] : []), ...known]
      return h(React.Fragment, null,
        h('select', {
          style: { ...inputCss, width: 190 }, value: selectValue,
          onChange: e => props.onChange(e.target.value === CUSTOM ? '' : e.target.value),
        },
          options.map(id => h('option', { key: id, value: id }, id === '*' ? '*（任意，跟随当前模型）' : id)),
          h('option', { value: CUSTOM }, inList ? '自定义…' : (props.value ? `自定义：${props.value}` : '自定义…'))),
        selectValue === CUSTOM && h('input', {
          style: { ...inputCss, width: 150 }, value: props.value,
          placeholder: 'provider 路由名', onChange: e => props.onChange(e.target.value),
        }))
    }

    /** model 选择：有目录 → 真下拉；无目录（未配密钥/不枚举）→ 自由输入 + 原因提示。 */
    function ModelField(props) {
      const provider = (props.providers || []).find(p => p.id === props.providerId)
      const models = provider && Array.isArray(provider.models) ? provider.models : null
      if (models !== null && models.length > 0) {
        const inList = models.some(m => m.id === props.value)
        return h('select', { style: { ...inputCss, width: 220 }, value: props.value, onChange: e => props.onChange(e.target.value) },
          props.allowEmpty && h('option', { value: '' }, props.placeholder || '（留空）'),
          models.map(m => h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id)),
          props.value && !inList && h('option', { value: props.value }, props.value))
      }
      return h(React.Fragment, null,
        h('input', {
          style: { ...inputCss, width: 200 }, value: props.value,
          placeholder: props.placeholder || '模型 id', onChange: e => props.onChange(e.target.value),
        }),
        provider && h('span', { style: { fontSize: 11, opacity: 0.6 } },
          provider.models === null ? '目录获取失败，请手输' : '无目录（未配密钥或不支持枚举），请手输'))
    }

    function TargetRow(props) {
      const t = props.target
      return h('div', { style: rowCss },
        h('span', { style: hintCss }, '备用 ' + (props.index + 1)),
        h(ProviderField, { providers: props.providers, value: t.provider || '', onChange: v => props.onChange({ ...t, provider: v }) }),
        h(ModelField, { providers: props.providers, providerId: t.provider, value: t.model || '', onChange: v => props.onChange({ ...t, model: v }) }),
        h('input', {
          style: { ...inputCss, width: 110 }, value: t.reasoningEffort || '', placeholder: 'effort 可选',
          title: '推理强度覆盖；留空 = 跨 provider 自动丢弃', onChange: e => props.onChange({ ...t, reasoningEffort: e.target.value }),
        }),
        h('button', { style: btnCss, onClick: props.onRemove }, '删除'))
    }

    function ChainCard(props) {
      const c = props.chain
      const setFrom = patch => props.onChange({ ...c, from: { ...c.from, ...patch } })
      const setTo = (i, t) => props.onChange({ ...c, to: c.to.map((x, j) => (j === i ? t : x)) })
      return h('div', { style: cardCss },
        h('div', { style: rowCss },
          h('strong', { style: { fontSize: 13 } }, '链 ' + (props.index + 1)),
          h('span', { style: hintCss }, '主路由'),
          h(ProviderField, { providers: props.providers, allowWildcard: true, value: c.from?.provider || '', onChange: v => setFrom({ provider: v }) }),
          h(ModelField, {
            providers: props.providers, providerId: c.from?.provider, value: c.from?.model || '',
            allowEmpty: true, placeholder: '（留空 = 该 provider 任意模型）', onChange: v => setFrom({ model: v }),
          }),
          h('span', { style: { flex: 1 } }),
          h('button', { style: btnCss, onClick: props.onRemove }, '删除链')),
        (c.to || []).map((t, i) => h(TargetRow, {
          key: i, index: i, target: t, providers: props.providers,
          onChange: nt => setTo(i, nt),
          onRemove: () => props.onChange({ ...c, to: c.to.filter((_, j) => j !== i) }),
        })),
        h('div', null, h('button', {
          style: btnCss,
          onClick: () => props.onChange({ ...c, to: [...(c.to || []), { provider: '', model: '' }] }),
        }, '+ 添加备用目标')))
    }

    /** 同源 POST 调面板通道（/api 信任栅栏后，dsh-context 同款）。 */
    const api = async (path, body) => {
      const r = await fetch(path, {
        method: 'POST',
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const data = await r.json().catch(() => null)
      if (!r.ok || !data || data.ok !== true) {
        throw new Error((data && data.error && data.error.message) || `HTTP ${r.status}`)
      }
      return data.value
    }

    function FallbackSettings() {
      const [state, setState] = React.useState({ phase: 'loading', error: null, providers: [], draft: null, saving: false, saved: false })

      const load = () => {
        setState(s => ({ ...s, phase: 'loading', error: null }))
        api('/api/model-fallback/state')
          .then(value => setState({
            phase: 'ready', error: null, providers: value.providers || [], saved: false, saving: false,
            draft: {
              onlyBeforeContent: value.config?.onlyBeforeContent !== false,
              codes: (value.config?.codes || []).join(', '),
              skipCodes: (value.config?.skipCodes || []).join(', '),
              chains: value.config?.chains || [],
            },
          }))
          .catch(e => setState(s => ({ ...s, phase: 'error', error: e?.message ?? String(e) })))
      }
      React.useEffect(load, [])

      if (state.phase === 'loading') return h('div', { style: { padding: 24, opacity: 0.7 } }, '加载中…')
      if (state.phase === 'error') {
        return h('div', { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', null, '加载失败：' + state.error),
          h('div', null, h('button', { style: btnCss, onClick: load }, '重试')))
      }

      const d = state.draft
      const patch = p => setState(s => ({ ...s, saved: false, draft: { ...s.draft, ...p } }))
      const setChain = (i, c) => patch({ chains: d.chains.map((x, j) => (j === i ? c : x)) })
      const splitCodes = s => s.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean)

      const save = () => {
        setState(s => ({ ...s, saving: true, saved: false }))
        api('/api/model-fallback/save', {
          config: {
            onlyBeforeContent: d.onlyBeforeContent,
            codes: splitCodes(d.codes),
            skipCodes: splitCodes(d.skipCodes),
            chains: d.chains,
          },
        })
          .then(() => { setState(s => ({ ...s, saving: false, saved: true })); load() })
          .catch(e => setState(s => ({ ...s, saving: false, error: e?.message ?? String(e) })))
      }

      return h('div', { style: { padding: '16px 20px', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14 } },
        h('p', { style: hintCss },
          '主模型调用失败（provider 自身重试耗尽）时，按链顺序自动切换备用模型，会话无感知。',
          '主路由 provider 选 * = 跟随 设置→模型 当前选用的任意模型；用户取消（aborted）永不切换；已开始输出内容后默认不切换。保存后热重载即刻生效。'),
        h('label', { style: { ...rowCss, fontSize: 13, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: d.onlyBeforeContent, onChange: e => patch({ onlyBeforeContent: e.target.checked }) }),
          '已开始输出内容后不再切换（防两半截消息拼接）'),
        h('div', { style: rowCss },
          h(Labeled, { label: '永不切换的失败码（空格/逗号分隔）' },
            h('input', { style: { ...inputCss, width: 260 }, value: d.skipCodes, onChange: e => patch({ skipCodes: e.target.value }) })),
          h(Labeled, { label: '触发切换的失败码白名单（留空=全部 error）' },
            h('input', { style: { ...inputCss, width: 260 }, value: d.codes, onChange: e => patch({ codes: e.target.value }) }))),
        d.chains.map((c, i) => h(ChainCard, {
          key: i, index: i, chain: c, providers: state.providers,
          onChange: nc => setChain(i, nc),
          onRemove: () => patch({ chains: d.chains.filter((_, j) => j !== i) }),
        })),
        h('div', null, h('button', {
          style: btnCss,
          onClick: () => patch({ chains: [...d.chains, { from: { provider: '', model: '' }, to: [{ provider: '', model: '' }] }] }),
        }, '+ 添加链')),
        state.error && state.phase === 'ready' && h('div', { style: { color: 'tomato', fontSize: 12 } }, state.error),
        h('div', { style: rowCss },
          h('button', { style: primaryBtnCss, disabled: state.saving, onClick: save }, state.saving ? '保存中…' : '保存'),
          state.saved && h('span', { style: { fontSize: 12, opacity: 0.75 } }, '已保存并热生效')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置主页左侧导航一页
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-fallback',
          order: 50,
          label: () => '模型 Fallback',
        }, FallbackSettings))
        // 插件详情页内嵌配置面板（keyed by 包名，渲染在描述与组件列表之间）
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-model-fallback',
        }, FallbackSettings))
      },
    }
  },
})
