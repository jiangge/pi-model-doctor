# add 显式 API key 语义

用户明确要求 add --api-key 明文不能忽略，支持环境变量，替换旧值。主会话设计审查，Herdr 相同模型开发测试。

## Contracts
- add 显式非空 apiKey：无需 allow-literal-api-key，即保存明文或原样保存已有支持的 $ENV/${ENV}/ENV reference、!command，不执行/展开引用。
- provider-only 和 provider+model 两条 add 路径都替换已有 apiKey；未传则完全保留旧值。同值无多余变化。
- explicit auth 属于 user ownership override，不改变普通 metadata 合并保护策略。空白/空值继续拒绝。
- 预览 changes before/after、通知、warning/error、managed snapshots 和 catalog/provider/policy caches 不泄漏新旧密钥；models.json 正常保存，备份保留旧配置属预期。
- dry-run 无 models/cache/backup 写入，正常一次原子写入/备份。
- scope 仅 add，configure/sync 现有 opt-in 策略保持，防止 proposeAdd 复用使 sync 意外接受明文。
- 更新 README 中文 docs/help/backend contract：add flag 本身授权保存明文，reference 更推荐，已有值会替换；allow-literal flag 可保持兼容但不再必需于 add。
- 新增命令/API 级测试：新 provider 明文、既有 provider 明文替换、reference 替换、省略保留、同值、provider-only/model paths、空值、dry-run/redaction/backup、sync/configure 不回归。
- npm run typecheck/npm test/git diff --check 全通过。
