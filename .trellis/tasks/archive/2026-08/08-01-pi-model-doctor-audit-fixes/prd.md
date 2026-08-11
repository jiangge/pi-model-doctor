# 全面修复 Pi Model Doctor 审查问题

## Goal

按照 `Pi_Model_Doctor_Implementation_Plan_v3.docx` 和本次审查结论，补齐 Pi Model Doctor 中未完成或实现不完整的能力，使项目从“核心功能可用”达到“计划要求可验收”：refresh 更新后检查配置变化；完成 budget/provider-specific reasoning 与 cache adapter 转换；修复无 UI 场景的确认安全边界；实现模型迁移生命周期；让三类 cache 具有真实语义；补齐 headers、模型选择、错误路径和集成测试。

## What I already know

* 当前实现位于仓库根目录，包含 `index.ts`、`src/`、`test/` 和可发布的 `package.json`；`.pi/settings.json` 仅用于本地开发 smoke test。
* 已有安全写入机制：JSONC 读取、增量 merge、timestamp backup、atomic rename、managedFields/managedValues 所有权快照和冲突保护。
* 已有统一命令：`add/list/check/fix/remove/refresh`，但无 UI 时 mutating command 会绕过确认。
* `refresh` 目前只刷新 catalog、统计 provider/model 数量并写入简单 policy 字符串，不检查现有配置变化。
* reasoning 已识别 toggle/effort/budget，但 budget 不能转换为 provider-specific 配置；cache 已识别 prompt/context/KV 信号，但 adapter 转换不完整。
* `policies-cache.json` 目前只写入 `model-doctor-v1`，没有真实 policy 内容或读取消费。
* 迁移命令与迁移领域逻辑不存在；未指定模型时当前实现选择 provider 的第一个模型。
* 当前测试 9/9 通过，但缺少 refresh、conditional HTTP、budget、adapter、fix-all、UI/无 UI、integration、deprecated、migration 等契约覆盖。

## Requirements

### R1. Refresh 配置变化检查

* `/model-doctor refresh [--force]` 刷新 models.dev 后，必须对当前 `models.json` 执行检查。
* refresh 输出必须包含 catalog 刷新状态、配置 findings 数量/摘要以及可修复变化数量；不得自动写入 models.json。
* 网络失败时继续使用有效 stale cache，并对配置检查结果保留 warning。
* refresh 的 dry-run/只读语义不得创建 models.json backup，也不得修复配置。

### R2. Universal Reasoning Engine 完整转换

* 保留统一 `NormalizedReasoning` 模型，并覆盖 toggle、effort、budget、unknown fallback。
* budget reasoning 必须生成可持久化的 provider-specific compat 配置，包括预算上限和必要的 thinking format/config 信息。
* 至少覆盖 Anthropic budget、Google thinkingConfig、OpenAI/OpenAI-compatible 的 reasoning effort/budget 兼容表达；未知 provider 必须产生明确 fallback policy，而不是静默丢失 budget。
* repair/check 必须比较这些 managed capability fields，并且不覆盖用户已修改字段。

### R3. Universal Cache Engine 完整 adapter 映射

* 继续归一化 prompt/context/KV cache 和读写计费信号。
* provider adapter 必须分别表达可用的 prompt/context/KV cache 行为；不能把三者只压缩为一个布尔判断。
* 对 Pi 当前无法直接表达的能力，必须生成明确的 compat/policy 字段或 warning，不能静默宣称已支持。
* cache policy 必须可序列化并被 refresh/check 使用。

### R4. 安全确认边界

* 交互式 UI 继续使用确认对话框。
* 无 UI 环境对 add/fix/remove 等写操作默认拒绝，除非显式传入 `--yes`。
* `--dry-run` 优先级高于 `--yes`，不得写 models.json、backup 或 catalog cache。
* help、错误提示和 README 必须记录无 UI 的 `--yes` 语义。
* API key、headers、authorization 等敏感内容继续脱敏，且 proposal/错误/变更输出不得泄露 secret。

### R5. 模型迁移生命周期

* 增加统一入口 `/model-doctor migrate <provider/model> [--to <provider/model>] [--dry-run] [--yes]`。
* migrate 支持把现有模型从旧 provider/model id 迁移到 models.dev 能匹配的新 provider/model，保留用户字段并生成变更计划。
* 迁移必须先检查目标冲突、endpoint/API 差异和用户所有权；默认不得删除源模型，除非显式 `--remove-source`。
* migrate 写入前必须走现有 backup/atomic write 和确认策略；dry-run 不产生持久化副作用。
* 文档说明迁移的限制、保留规则和回滚方式。

### R6. 三类 cache 真实语义

* `models-cache.json` 保存规范化完整 catalog。
* `providers-cache.json` 保存 provider 摘要及 adapter 能力/环境变量信息。
* `policies-cache.json` 保存版本化的 reasoning/cache fallback、provider adapter 和 capability mapping policy；必须由运行时读取并用于 fallback/compat 解析。
* cache schema/version 不兼容时安全失效并回退，不得把错误内容当作有效 policy。

### R7. Discovery 与 headers 检查

* add 未指定 model 时不得无提示静默选择 catalog 首项；UI 环境提供候选模型选择，非 UI 环境要求显式 model 或明确 `--yes`/fallback 行为并输出选择依据。
* check 必须区分并报告 provider/model headers 的存在、冲突和必要 header 缺失；不得覆盖用户 headers。
* model id、deprecated、endpoint、API protocol、limits、reasoning、cache、metadata version 均保留现有检查并纳入 repair plan。

### R8. Discovery 与未登记第三方渠道

* `add` 支持不在 `models.dev` 中登记的第三方渠道 URL；必须精确匹配用户给出的 model id/name，不能因为 catalog provider 缺失而直接失败。
* 第三方渠道的 endpoint、API 协议、headers、认证和其他传输字段以用户配置为准；models.dev provider identity 不得覆盖这些字段，也不得自动注入该 provider 的环境凭据。
* 模型能力、价格、reasoning、cache 等信息可以从唯一的 models.dev 模型条目作为 metadata-only/advisory 数据使用；重复 model id 必须通过 `--metadata-provider` 明确选择。
* `--api` 可以显式覆盖第三方渠道协议；check/fix 只修复 metadata/capability 字段并报告 `third-party-channel`，不修改 channel-owned transport 字段。
* 官方 provider 网站数据不是隐式信任来源；若将来接入，必须有独立、可审计、脱敏且不向第三方 endpoint 转发凭据的 metadata source。

### R9. 渠道模型批量同步

* 增加统一入口 `/model-doctor sync <provider-or-url>`。
* UI 环境发现目标渠道的 models.dev 模型候选，允许本次重复选择多个模型并通过 Done 结束；取消时不写入。
* 非 UI 环境必须通过 `--models <id1,id2>` 显式指定本次模型集合，不得静默配置全部或首个模型。
* sync 为一次组合 proposal，使用一次确认、一次 backup 和一次 atomic write；保留现有 provider/model 用户字段和第三方 channel-owned transport 字段。
* `--dry-run` 不写入 models.json、backup 或 catalog/policy cache；无 UI 写入仍需要 `--yes`。

### R10. 测试与集成验收

* 增加单元测试覆盖 toggle/effort/budget/unknown reasoning、cache signals/policies、各 adapter。
* 增加 models.dev forced refresh、ETag/Last-Modified、304、stale fallback、无缓存失败测试。
* 增加 service 的 list/check/fix-all/refresh/migrate、deprecated、metadata version、headers、冲突和 dry-run 测试。
* 增加交互确认取消、无 UI 未带 `--yes` 拒绝、`--yes` 成功、secret-safe 输出测试。
* 增加 Pi extension 注册 integration smoke test。
* 所有新增行为必须通过 typecheck、test、git diff --check。

## Acceptance Criteria

* [x] refresh 输出配置变化检查结果，且不自动写配置。
* [x] budget reasoning 对 Anthropic/Google/OpenAI-compatible/unknown provider 有可验证的转换或明确 fallback。
* [x] prompt/context/KV cache 具有独立可检查的 adapter/policy 结果。
* [x] policies cache 有版本化结构并被运行时读取。
* [x] 无 UI 写操作无 `--yes` 时失败；带 `--yes` 才可写；UI 仍可确认取消。
* [x] migrate 命令支持 dry-run、确认、保留源模型默认策略、backup/atomic write，并提供 rollback。
* [x] 未指定 model 时 UI 可选择候选，非 UI 不会静默选择首项。
* [x] headers 检查不泄露内容且能报告必要/冲突状态。
* [x] sync 支持 UI 多选和 headless 显式模型列表，组合写入只产生一次 backup/atomic write。
* [x] 契约要求的测试矩阵有自动化覆盖，所有测试通过。
* [x] README、后端契约和错误处理说明与实际行为一致。

## Definition of Done

* Tests added/updated for every behavior above.
* Typecheck and test suite pass.
* No known `TODO`/`FIXME` or unsafe `any` in production source.
* Documentation and backend contract updated.
* Existing models.json user fields remain backward compatible.
* All writes remain backed up and atomic; dry-run remains side-effect free.
* Work is committed and Trellis task archived; no sub-agents are used.

## Technical Approach

* Extend existing domain types and `ModelDoctor` rather than adding a parallel service.
* Add typed `PolicyCatalog` and have `CacheStore` validate/read/write it.
* Make capability resolution return normalized capability plus adapter mapping/policy metadata; preserve compatibility fields in `PiCompat` as an extensible object.
* Centralize mutation authorization in command layer with `--yes` and a no-UI guard.
* Implement migration as a plan-producing service operation that composes existing `toPiModel`, ownership checks, `ChangePlan`, `writeModelsJson`, and source-preservation rules.
* Make refresh call a non-mutating full check against the freshly loaded catalog and return an explicit summary.
* Keep model metadata and policy extensions backward compatible by treating unknown fields as preserved data.

## Decision (ADR-lite)

**Context**: The audit found that the first implementation had a sound persistence foundation but several incomplete feature paths and insufficient verification.

**Decision**: Fix all audit findings in the current extension architecture, add typed policies/adapters/migration, and expand tests before declaring conformance.

**Consequences**: The extension gains a larger API and more explicit state/policy modeling. Existing models.json remains compatible, but the command help and policy cache schema become part of the maintained contract.

## Out of Scope

* Network push, PR creation, deployment, or publishing.
* Automatic deletion of deprecated models.
* Rewriting user-owned headers, API keys, endpoint overrides, temperature, or arbitrary unknown fields.
* Supporting provider-specific runtime behavior that Pi itself cannot express; such cases must be represented as policy/compat metadata or warnings.

## Technical Notes

* Primary reference: `Pi_Model_Doctor_Implementation_Plan_v3.docx`.
* Existing contract: `.trellis/spec/backend/model-doctor-contract.md`.
* Primary implementation: `src/{command,doctor,json,cache,models-dev,capabilities,types}.ts`。
* Tests: `test/model-doctor.test.ts`。
* Existing safe-write and ownership logic should be preserved and reused.
* 发布形态为仓库根目录 Pi package：`package.json` 的 `pi.extensions` 指向 `./index.ts`；本地 `.pi/settings.json` 指向 `../index.ts`。
