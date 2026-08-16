# 修复 models.dev 无效 cache metadata 导致 add 中止

## Goal

修复 `/model-doctor add wong gpt-5.6-sol` 在读取当前 models.dev catalog 时，因为无关模型 `cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b` 的 `interleaved: true` 被错误判定为无效 cache metadata，导致整个操作中止的问题。

## What I already know

- 当前 models.dev 数据中该模型的 `interleaved` 值为布尔值 `true`。
- `src/models-dev.ts` 当前只允许 model-level `interleaved` 为对象或 `undefined`。
- 因为 catalog normalization 采用全量严格校验，一个无关 provider/model 的合法新 schema 形态会阻断目标模型添加。

## Requirements

- 接受 models.dev 当前使用的布尔型 `interleaved` metadata，同时继续接受已有对象形态。
- 不放宽敏感字段、非法对象键、limit/cost/reasoning 等其他安全校验。
- normalized catalog cache 的读取校验应与网络 normalization 接受的形态一致。
- 增加回归测试，覆盖 `interleaved: true` 和无效 primitive 值。
- 确保 `/model-doctor add wong gpt-5.6-sol` 不再因该无关 Cloudflare 模型中止 catalog 加载。

## Acceptance Criteria

- [ ] 包含 `cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b` 且 `interleaved: true` 的 catalog 可成功 normalize。
- [ ] 该 normalized catalog 写入/读取缓存后仍被视为有效。
- [ ] `interleaved` 的不支持值（例如数字或任意字符串）仍触发 typed `invalid-catalog`。
- [ ] 现有测试、类型检查全部通过。

## Definition of Done

- Tests added/updated.
- Typecheck and test suite green.
- Error-handling/cache contract reviewed and updated only if the accepted models.dev schema needs durable documentation.

## Technical Approach

将 `interleaved` 的校验从“可选 metadata object”调整为专用校验：允许 `undefined`、boolean 或 metadata object；网络 normalization 与 normalized cache validation 复用同一规则。保留后续 capability resolver 对对象信号的保守处理，布尔值只作为合法 catalog metadata 保留，不自动推导额外运行时能力。

## Decision (ADR-lite)

**Context**: models.dev 的 live schema 已使用 `interleaved: true`，而本项目的 validator 落后于上游形态。

**Decision**: 精确扩展 `interleaved` 的允许类型，而不是跳过坏模型、删除 metadata 或放宽所有 cache metadata。

**Consequences**: catalog 不会因合法布尔值全局失败；安全校验仍保持严格；若未来需要从布尔值推导能力，应另行定义语义。

## Out of Scope

- 不改变 `wong` provider 匹配或 `gpt-5.6-sol` 模型发现逻辑。
- 不因为单个任意损坏模型而普遍跳过 catalog 条目。
- 不把 `interleaved: true` 自动解释成 prompt/context/KV cache 已启用。

## Technical Notes

- 相关文件：`src/models-dev.ts`、`test/model-doctor.test.ts`。
- 相关规范：`.trellis/spec/backend/model-doctor-contract.md`、`.trellis/spec/backend/error-handling.md`、`.trellis/spec/backend/quality-guidelines.md`。
- Live models.dev observation: `cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b.interleaved === true`。
