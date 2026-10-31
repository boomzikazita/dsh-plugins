# 已归档/删除的仓库记录

## 2026-10-31 双轨收敛：6 个独立插件仓库已删除

原因：这些仓库与 monorepo `dsh-plugins` 内容重复，本地 `~/dsh-plugins` 是唯一 git 工作区，
每次改码需手动推两遍，已出现版本漂移（model-fallback 0.4.1 vs 0.4.0、skill-fold 0.1.1 vs 0.1.0）。
npm 上所有已发布包的 `repository.url` 均指向本 monorepo，删除不影响包页面链接。

| 仓库 | 删除前末端提交 | 日期 | 提交信息 |
|---|---|---|---|
| `dsh-cybernetics` | 4cf4baa	2026-10-27	fix: 能控性兜底去参数回显 + streak>=5 熔断话术 + failedHintSent 按 turn 重置（ |
| `dsh-model-fallback` | e480266	2026-10-22	init: dsh-model-fallback v0.4.0 —— 主模型失败自动切备用链（设置页可视化管理） |
| `dsh-prompt-diff` | 4b56d67	2026-10-16	sync: 本地 2026-10-15 变更 (v0.2.1) |
| `dsh-skill-authoring` | 2cb4656	2026-10-25	refactor: 模块预算 ≤500 瘦身——authoring 559→498（lib/mece.js）、memor |
| `dsh-skill-fold` | dcc28a2	2026-10-25	memory: 0.2.4 摘除 memory_notify 补推；fold: 过滤黑名单改白名单（凡带 source. |
| `dsh-skill-search` | 7363c30	2026-10-25	feat: 域表三级读取——~/.dsh 本机覆盖 → 插件目录自带 skill-domains.json（随仓库分发， |

> GitHub 删除后有约 90 天恢复窗口；如需恢复该窗口内提交工单即可。
