# 缓存能力未知不等于不支持
用户要求实施此前诊断方案，pi-cache-optimizer 可作为其额外扩展，但不假定依赖它或自动修改用户配置。

## Requirements
- 缓存 capability evidence 缺失=unknown，而非 false/unsupported；显式否定保留 unsupported，显式支持保留支持。
- 将服务端 capability 与 Pi adapter control 字段分别表达；无control不是服务端不支持。
- fallback default cost cache_read/cache_write=0 不是缓存pricing证据，fallback confidence low，去除伪pricing true/medium。
- unknown cache capability时不要生成 supportsKvCache:false 或其他确定性否定控制字段；禁止盲目开启缓存。
- 类型schema/resolveCache/buildMetadata/proposals/UI/check/merge/snapshot/cache一致；保证用户覆盖与手动true/false preserved。
- 已有工具生成 fallback false metadata 在 sync/fix 时可按ownership安全纠正，不能把所有false都删除；无当前配置直接写入。
- 保留真实零缓存定价作为明确来源数据；不得因值为0误删真实catalog evidence。
- tests明确缺失/false/true，fallback pricing和confidence、实际zero catalog pricing，adapter无control仍capability true，旧managed false安全迁移，user override preservation，sync windhub-like unknown IDs，dry-run无写入。
- docs/spec 更新；npm run typecheck/npm test/git diff --check绿。主会话设计review，Herdr同模型实现测试；仅本地提交，不发布。
