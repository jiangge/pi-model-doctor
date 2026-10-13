# 发布 0.4.0
用户授权提交、推送、发布 npm。版本 0.4.0 包含 endpoint-first sync。使用现有 tag-triggered GitHub Actions OIDC 发布，不读取或发送本地 npm token。
验收：typecheck、107 tests、npm pack dry-run；推送 master/v0.4.0；Actions publish success；npm registry latest=0.4.0。不修改发布 workflow。
