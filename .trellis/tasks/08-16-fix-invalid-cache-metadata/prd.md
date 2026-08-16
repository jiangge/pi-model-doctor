# 修复 models.dev 无效 cache metadata 导致 add 中止

## Goal

修复 `/model-doctor add wong gpt-5.6-sol` 在读取当前 models.dev catalog 时，因为无关模型 `cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b` 的 `interleaved: true` 被错误判定为无效 cache metadata，导致整个操作中止的问题。

## What I already know

- 当前 models.dev 数据中 Cloudflare 模型的 `interleaved` 值为布尔值 `true`。
- 当前 models.dev 数据中 `nvidia/nvidia/active-speaker-detection` 的 `limit.context` 为 `0`。
- 当前 models.dev 数据中 `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` 使用 `budget_tokens.min: -1` sentinel。
- 当前 models.dev 为 Lynkr、LM Studio 等本机 provider 登记了 HTTP loopback API URL。
- 当前 Sarvam reasoning effort values 使用 `null` 表示无 effort/关闭。
- 当前 `302ai` provider 的 env metadata 使用数字开头的 `302AI_API_KEY`。
- 当前 EdenAI catalog 同时包含仅大小写不同的两个 case-sensitive model id。
- `src/models-dev.ts` 原先只允许 model-level `interleaved` 为对象或 `undefined`，要求 limit 为正整数，并拒绝 reasoning budget sentinel。
- 因为 catalog normalization 采用全量严格校验，一个无关 provider/model 的合法新 schema 形态会阻断目标模型添加。

## Requirements

- 接受 models.dev 当前使用的布尔型 `interleaved` metadata，同时继续接受已有对象形态。
- 接受有限非负整数 limit（包括 `0`），继续拒绝负数、小数、非有限值和非数字。
- 精确接受 `budget_tokens.min` 的 `-1`/`0` sentinel；其他负数、非正 max 和非法范围仍无效，resolver 保持保守降级。
- provider API URL 允许 HTTP loopback，继续拒绝公网 HTTP、非 loopback 私网地址、URL credentials 和 credential query。
- reasoning option values 精确接受非空字符串或 `null` sentinel；resolver 只消费字符串，其他 primitive 仍无效。
- provider env metadata 允许大写字母或数字开头，其余仅大写字母、数字和下划线；数字开头项不自动转成 shell-style API key reference。
- model catalog key/id 按精确字符串验证和去重；case-fold 查找若命中多个大小写变体必须保持 ambiguous。
- 第三方渠道的全局 model id 若有多个候选，仅在 models.dev metadata 声明原生 `@ai-sdk/<provider>` 且唯一 canonical provider 存在时自动选择该官方 metadata provider；否则继续要求显式消歧。
- add dry-run、成功写入和已是最新的 no-op 都明确通知用户结果、持久化状态及 metadata provider。
- 不放宽敏感字段、非法对象键、cost 等其他安全校验。
- normalized catalog cache 的读取校验应与网络 normalization 接受的形态一致。
- 增加回归测试，覆盖 `interleaved: true`、`limit.context: 0` 和各自的无效值。
- 确保 `/model-doctor add wong gpt-5.6-sol` 不再因这些无关模型中止 catalog 加载。

## Acceptance Criteria

- [x] 包含 `cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b` 且 `interleaved: true` 的 catalog 可成功 normalize。
- [x] 包含 `nvidia/nvidia/active-speaker-detection` 且 `limit: { context: 0, output: 4096 }` 的 catalog 可成功 normalize。
- [x] 该 normalized catalog 写入/读取缓存后仍被视为有效。
- [x] `interleaved` 的不支持值（例如数字或任意字符串）仍触发 typed `invalid-catalog`。
- [x] limit 的负数、小数、非有限值或非数字仍触发 typed `invalid-catalog`。
- [x] `budget_tokens.min: -1` 和 `0` 可 normalize/cache，但其他负预算 sentinel 形态仍触发 typed `invalid-catalog`。
- [x] HTTP loopback provider API 可 normalize/cache，公网 HTTP 和非 loopback 私网 HTTP 仍无效。
- [x] reasoning effort values 中的 `null` 可 normalize/cache，其他非字符串 primitive 仍无效。
- [x] 数字开头的大写 env metadata 可 normalize/provider-cache，包含小写、空格或标点的值仍无效。
- [x] 仅大小写不同的 model ids 可同时 normalize/cache，case-insensitive 查找返回 ambiguous。
- [x] 真实 Pi RPC 可越过全部 catalog normalization；live catalog 网络/cache/provider-cache 均验证有效。
- [x] 使用显式 Wong endpoint、API 和 metadata provider 可生成 `gpt-5.6-sol` dry-run proposal。
- [x] 已配置但未登记于 models.dev 的 Wong 渠道可从重复候选中自动选择 metadata 声明的 canonical `openai` provider；无法可靠归属的重复 model id 仍保持 ambiguous。
- [x] `/model-doctor add wong gpt-5.6-sol --dry-run` 明确显示成功、自动选择的 metadata provider 和未持久化状态。
- [x] 现有测试、类型检查全部通过。

## Definition of Done

- Tests added/updated.
- Typecheck and test suite green.
- Error-handling/cache contract reviewed and updated only if the accepted models.dev schema needs durable documentation.

## Technical Approach

将 `interleaved` 的校验从“可选 metadata object”调整为专用校验：允许 `undefined`、boolean 或 metadata object；将 limit 校验精确调整为有限非负整数；仅为 `budget_tokens.min` 接受 `-1`/`0` sentinel。网络 normalization 与 normalized cache validation 对这些 metadata 复用相同规则；provider API URL 采用 HTTPS 或 HTTP loopback 的一致安全规则；reasoning values 保留 `null` sentinel，但运行时 resolver 只映射字符串值；env catalog/cache validator 接受 models.dev 的数字开头 metadata，而 API-key 自动引用仍只选择 shell-safe 字母开头项；model key/id 完整性使用精确字符串，查询层继续保留 case-fold ambiguity 检测。保留后续 capability resolver 的保守处理：布尔值不自动推导额外运行时能力，零 limit 使用既有默认值，非正 budget sentinel 降级为 advisory/unknown 而不产生错误预算。

## Decision (ADR-lite)

**Context**: models.dev 的 live schema 已使用 `interleaved: true`，而本项目的 validator 落后于上游形态。

**Decision**: 精确扩展 `interleaved` 的允许类型，而不是跳过坏模型、删除 metadata 或放宽所有 cache metadata。

**Consequences**: catalog 不会因合法布尔值全局失败；安全校验仍保持严格；若未来需要从布尔值推导能力，应另行定义语义。

## Out of Scope

- 不从历史备份自动恢复已从当前 `models.json` 删除的 `wong` provider、API key 或 headers。
- 不把不在 models.dev 中的 `wong` 伪装成官方 catalog provider；空配置下必须显式提供 endpoint，并用 `--metadata-provider` 消歧全局模型 metadata。
- 不因为单个任意损坏模型而普遍跳过 catalog 条目。
- 不把 `interleaved: true` 自动解释成 prompt/context/KV cache 已启用。

## Technical Notes

- 相关文件：`src/models-dev.ts`、`test/model-doctor.test.ts`。
- 相关规范：`.trellis/spec/backend/model-doctor-contract.md`、`.trellis/spec/backend/error-handling.md`、`.trellis/spec/backend/quality-guidelines.md`。
- 当前活动 `~/.pi/agent/models.json` 没有 provider；历史备份中的 Wong endpoint 为 `https://wzw.pp.ua/v1`，但凭据/headers 未自动恢复。
- Live models.dev observations: `cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b.interleaved === true`; `nvidia/nvidia/active-speaker-detection.limit.context === 0`; `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning.reasoning_options` includes `{ type: "budget_tokens", min: -1, max: 32768 }`; `google-vertex/gemini-2.5-flash` uses `{ type: "budget_tokens", min: 0, max: 24576 }`; `lynkr.api === "http://127.0.0.1:8081/v1"`; `sarvam/sarvam-105b.reasoning_options[0].values` includes `null`; `302ai.env === ["302AI_API_KEY"]`; EdenAI contains both `flexai/DeepSeek-V4-Flash-0731` and `flexai/deepseek-v4-flash-0731`。
