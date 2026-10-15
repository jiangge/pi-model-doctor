# 缺少渠道元数据时采用模型官方渠道参数

## Goal

当 `/model-doctor sync` 的目标渠道（例如 Windhub）不在 models.dev 中，导致所选模型无法直接绑定渠道元数据时，改为使用该模型官方 provider 的模型参数，并明确告知用户元数据来源及这是默认回退，避免把缺失 metadata 静默呈现为 128K 等普通模型配置。

## What I already know

- 用户要求：“当找不到指定的provider，则告知用户默认使用模型官方渠道的参数。”本任务暂按上一轮 Windhub/GLM-5.3 的 `/sync` 场景理解。
- 当前 `src/doctor.ts` 的 sync channel 路径只在跨 models.dev providers 的精确 model-id 命中唯一时采用其元数据；多个命中会 warning 并跳过 metadata。
- `src/capabilities.ts` 在 `limit.context` 缺失时将 `contextWindow` 设为 `128000`。
- 当前 models.dev catalog 不含 Windhub provider；`zai/glm-5.3` 的 context limit 为 `1000000`。但 `glm-5.3` 在多个 provider 下重复出现，Z.AI 的 `npm` 是通用 `@ai-sdk/openai-compatible`，model metadata 本身没有声明 origin provider，因此当前 catalog 并不能直接、可靠地区分 Z.AI 与其他代理商。
- `sync --metadata-provider <models.dev-provider>` 已存在，能显式指定 metadata source；测试复现了未指定时 128000、指定 `zai` 时 1000000。
- URL/add 路径已有 canonical metadata provider 选择逻辑，但其依赖 models.dev 中的 origin/native-provider 证据；sync channel 路径尚未复用该路径。

## Assumptions (temporary)

- MVP 仅针对 sync 到 models.dev 未登记的第三方渠道；渠道 endpoint、API、headers 和认证仍由用户配置拥有，绝不从官方 provider 覆盖。
- 用户应能看到最终选用的 metadata provider，以及使用官方 metadata 是回退行为。
- 不应仅因某个模型 ID 常见，就把代理商 metadata 当成官方参数。

## Open Questions

- 无阻塞问题。用户已批准按建议实施，通过 Herdr 同模型 agent 开发、测试，主 agent 制定方案、审查代码。

## Requirements (evolving)

- 目标 provider/channel 无 models.dev 条目时，优先从模型官方 provider 取得模型参数，而不是无提示地用 128K 缺省值。
- 告知用户官方 metadata 的 provider ID、回退原因及持久化状态。
- 模型参数可以同步；provider/channel 的 transport identity、endpoint、API、headers 和认证不被官方 provider 覆盖。
- 显式 `--metadata-provider` 优先于自动回退选择。

## Acceptance Criteria (evolving)

- [x] Windhub 同步 `glm-5.3` 时，在官方 source 可确定的情况下生成 1,000,000 context window，并报告选用的 metadata provider。
- [x] metadata source 自动回退不改变 Windhub 的 endpoint/API/auth/headers。
- [x] 显式 `--metadata-provider` 仍覆盖自动选择；无效显式 source 报错，不静默降级。
- [x] 找不到可靠官方 source 时按确认后的策略处理，且不再静默造成 128K 看似准确的结果。
- [x] dry-run 与写入/无变更通知都能清楚报告逐模型 metadata source、reason 与 persist 状态。
- [x] 回归测试、类型检查通过，相关 EN/ZH 命令文档和 backend contract 已更新。

## Definition of Done

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes
- Rollout/rollback considered if risky

## Decision (approved)

- 使用经官方资料核实的发布者/官方 provider 注册表，不硬编码模型参数；严格匹配型号，官方 catalog 必须存在对应模型。
- 显式 metadata provider 优先，SDK 包名不作为作者归属证明；无法确认时明确提示保守默认值，不谎称官方参数。
- 官方参考 context/output 不代表已验证渠道上限；保留渠道 transport 和用户手工修改，不将官方价格/缓存执行能力冒充渠道事实。
- add/sync/check/fix 共享来源语义，持久化可追溯来源，覆盖 dry-run/write/no-op 通知。
- 详细方案与验收矩阵见 [implementation-plan.md](implementation-plan.md)。同模型 Herdr agent `metadata-dev` (`xiaojimao/gpt-6.1-sol`) 实施与测试，主 agent 审查；不提交或推送。

## Technical Approach (approved)

- 将 add/sync/check/fix 的 metadata provider resolution 统一到严格精确的 publisher attribution registry；只选择 catalog source，不硬编码模型参数，保留 channel-owned transport fields。
- 对自动选用的 metadata provider 报告 provider、model、reason、evidence 和 persistence；若 source 不可靠则明确标注 catalog-only/conservative defaults。

## Out of Scope

- 从 Windhub API 自动探测上下文上限。
- 把 models.dev 某一代理商的数据视为所有代理商的真实运行时上限。
- 更改 API key、headers 或 endpoint 的所有权规则。

## Technical Notes

- `src/doctor.ts`：sync channel metadata resolution (`proposeSync`)，约 872–880 行；add proposal metadata selection。
- `src/models-dev.ts`：`findGlobalModel` / `selectOfficialMetadataMatch`。
- `src/capabilities.ts`：`toPiModel` 对缺失 context limit 的 128K 缺省值。
- `src/command.ts`：sync 通知、`--metadata-provider` 的命令 UX。
- `test/channel-discovery.test.ts`、`test/model-doctor.test.ts`：channel metadata/sync 测试。
- Live catalog checked at `https://models.dev/api.json`; provider limits may change over time.
- Research: [`research/official-provider-attribution.md`](research/official-provider-attribution.md) compares catalog evidence, curated mapping, and heuristics for identifying official metadata.
