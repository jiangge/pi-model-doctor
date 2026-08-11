# Pi Model Doctor

> [English](../README.md) | **简体中文**

Pi Model Doctor 是一个 Pi 扩展，用于管理 `models.json` 中的模型生命周期。普通的 `pi install npm:pi-model-doctor` 会安装到当前用户的 Pi 全局设置；只有显式使用 `-l` 才会安装为项目级包。它从 [models.dev](https://models.dev) 发现 provider 元数据、补全模型能力、检查现有配置，并在不覆盖用户自有设置的前提下执行安全修复。

## 目录

- [安装、更新与卸载](#安装更新与卸载)
- [全局安装与项目级覆盖](#全局安装与项目级覆盖)
- [命令](#命令)
- [安全写入与所有权](#安全写入与所有权)
- [缓存与离线行为](#缓存与离线行为)
- [Provider 能力](#provider-能力)
- [开发](#开发)

## 安装、更新与卸载

从 npm 安装到当前 Pi 用户的全局 Pi 环境（默认且推荐）：

```bash
pi install npm:pi-model-doctor
```

这会把包写入用户 Pi 包目录，并加入 `~/.pi/agent/settings.json`，因此同一用户的其他项目也可以使用。只有需要项目级固定版本时，才安装到当前项目的 `.pi/settings.json`：

```bash
pi install npm:pi-model-doctor -l
```

更新已安装的包：

```bash
pi update npm:pi-model-doctor
```

从安装时对应的作用域卸载：

```bash
# 全局/用户级安装
pi remove npm:pi-model-doctor
# 等价命令
pi uninstall npm:pi-model-doctor

# 项目级安装
pi remove npm:pi-model-doctor -l
```

安装或卸载后，请重启 Pi 或开启新会话，使扩展注册信息重新加载。卸载扩展不会删除已经写入 `models.json` 的模型；如需删除配置条目，请使用 `/model-doctor remove <provider/model>`，并保留时间戳备份以便回滚。

## 全局安装与项目级覆盖

本仓库的 `.pi/settings.json` 只包含本项目的开发工具配置。全局安装 npm 包后，不需要再添加 Model Doctor 的 `../index.ts`。Pi 全局设置会通过包根目录清单加载 npm 包：

```json
{
  "packages": ["npm:pi-model-doctor"]
}
```

只有明确执行 `pi install npm:pi-model-doctor -l` 时，才会把包引用写入当前项目的 `.pi/settings.json`，形成项目级覆盖。不要同时保留全局 npm 包和本地 `../index.ts` 条目，否则扩展可能被加载两次。

## 本地开发检出

用于本仓库开发冒烟测试时，`.pi/settings.json` 中与 Model Doctor 相关的条目是：

```json
{
  "extensions": ["../index.ts"]
}
```

Pi 会以项目的 `.pi/` 目录作为 `.pi/settings.json` 相对路径的基准；因此如果开发时使用 `../index.ts`，它会指向仓库根目录的 `index.ts`。但普通全局 npm 安装不需要这条本地路径。对于其他 Pi 项目，可通过 `pi install npm:pi-model-doctor` 安装已发布包，或将包目录加入该项目的 Pi settings。从 npm/Git 安装时**不会**使用 `../index.ts`；Pi 会读取包根目录清单中的 `pi.extensions: ["./index.ts"]`。

### 为什么实现位于仓库根目录

`.pi/` 是 Pi 的项目级运行时/配置命名空间，而面向 GitHub/npm/pi.dev 发布的包需要独立的包根目录。实现位于仓库根目录，`package.json`、`README.md`、`LICENSE`、`src/`、测试和 Pi 清单可以一起打包。项目级 `.pi/settings.json` 指向 `../index.ts` 仅用于本仓库的开发冒烟测试；从 npm 或 Git 安装时，Pi 会根据包自身的 `pi.extensions` 清单，从包根目录解析 `./index.ts`。

## 命令

```text
/model-doctor add <provider-or-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
/model-doctor add <provider-id> <endpoint-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
/model-doctor list [provider]
/model-doctor check [provider/model]
/model-doctor fix [provider/model] [--dry-run] [--yes]
/model-doctor remove <provider/model> [--dry-run] [--yes]
/model-doctor refresh [--force] [--dry-run]
/model-doctor sync <provider-or-url> [--models <id1,id2>] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
/model-doctor migrate <provider/model> [--to <provider/model>] [--dry-run] [--yes] [--remove-source]
/model-doctor cleanup-backups [--keep <count>] [--max-age-ms <milliseconds>] [--dry-run] [--yes]
/model-doctor rollback <models.json.bak-timestamp> [--dry-run] [--yes]
```

`sync` 从 models.dev 发现 provider/channel 的全部模型，交互式 UI 可在本次运行中选择多个模型。非交互模式必须通过 `--models model-a,model-b` 显式指定；不会隐式选择 catalog 首项或全部模型。sync 是一次组合 proposal：一次确认、一次备份、一次原子写入，所有选中模型一起应用。`sync --dry-run` 不写入 models.json、备份或缓存。

`add` 接受 models.dev provider id/name、provider API URL 或 model id。交互式 UI 中省略模型时会展示候选列表；非交互模式必须提供显式 model id。未在 models.dev 登记的第三方渠道：传入渠道 URL 和 model id 后，Model Doctor 可以使用其他 catalog provider 的精确模型记录作为 metadata-only 数据。可以一步添加指定渠道的模型：`add https://gateway.example/v1 <model>`；也可以显式指定存储 provider id：`add providerA https://gateway.example/v1 <model>`。如果只想先建立渠道，可以只传 URL（`add https://gateway.example/v1`，自动派生 provider id），也可以显式命名（`add providerA https://gateway.example/v1`）。两种 provider-only 形式都会创建一个包含 endpoint 和推断协议、但没有模型的 provider；之后可通过 `add providerA <model>`、`add https://gateway.example/v1 <model>` 或 `sync providerA` 添加模型。渠道的 endpoint、API 协议、headers、认证等传输字段始终属于用户，不会被覆盖。如果模型在多个 catalog provider 下存在，需要通过 `--metadata-provider <models.dev-provider>` 消歧；协议推断不足时通过 `--api <openai-completions|openai-responses|anthropic-messages|google-generative-ai>` 显式指定。对于一步添加渠道模型，如果给出的是没有路径的根 URL，且解析出的模型/协议属于 OpenAI-compatible（`openai-completions` 或 `openai-responses`），会自动补全 `/v1`；Anthropic 和 Google 协议不会补全。已有 `/v1` 和其他显式路径保持不变；插入 `/v1` 时查询参数和 fragment 仍会保留在 URL 末尾；只传 URL 建立 provider-only 渠道时没有模型类型，因此不会自动补全。显式 `--api` 优先决定这个行为；已经配置的渠道 endpoint 仍以用户现有值为准。provider-only 初始化会记录 endpoint/API 提示；用户后续修改会报告 conflict，且不会被自动规范化。Provider 官网数据不会自动抓取，也不会被当作 models.dev provider 记录；任何单独审核过的 provider 事实在通过受支持的 metadata source 提供之前都只是参考。API 凭据应使用引用形式，如 `$OPENAI_API_KEY`、`${OPENAI_API_KEY}`、`!command` 或 `pi-auth:provider`；除非显式传入 `--allow-literal-api-key`，否则字面 API key 不会被持久化。扩展永远不会打印 secret。使用 `--dry-run` 可预览 proposal 而不写入。非交互写入需要 `--yes`；`--dry-run` 优先级高于 `--yes`。`migrate` 接受显式 `--to provider/model`，UI 模式可展示目标候选；非交互模式必须提供 `--to`。

`check` 可离线检查本地文件，网络不可用时使用本地 models.dev 缓存；即使没有 catalog 也会报告本地所有权、元数据和 header findings。slash-command `refresh` 强制读取 catalog 并报告完整配置 findings，不应用修复；它从不写入 `models.json`，普通形式可以更新 catalog/policy 缓存。`refresh --dry-run` 完全只读，也不修改 catalog/policy 缓存。`fix` 只修改 Pi Model Doctor 拥有的字段。如果用户显式修改过 endpoint、header、compat 对象或模型能力，会报告为 conflict 且不会覆盖。`remove` 需要精确的 `provider/model` 目标。`migrate` 从当前元数据创建目标模型，保留安全用户字段，报告 endpoint/API/header 冲突但不复制 secret，默认保留源模型，显式 `--remove-source` 才会删除源；deprecated 目标仅作提示，不能自动应用。无操作的迁移报告无变更且不创建备份。每次修改都会验证 proposal 创建后 `models.json` 是否变化，然后使用备份、原子写入、持久化后 read-back 验证；持久化验证失败会自动恢复。当活动 Pi runtime 使用默认 agent models 路径时，命令会刷新并验证模型注册表，报告 `persisted-and-active`、`activation-failed` 或 `persisted-reload-required`；dry-run 和取消报告 `not-persisted`。备份清理是显式操作：`/model-doctor cleanup-backups --keep <count>` 或 `--max-age-ms <milliseconds>` 在授权后预览/删除旧的时间戳备份；从不自动运行。

## 安全写入与所有权

默认文件是 `join(getAgentDir(), "models.json")`（通常是 `~/.pi/agent/models.json`）。修改命令：

1. 读取现有文件。
2. 文件存在时创建时间戳备份 `models.json.bak-<timestamp>`。
3. 只合并请求的 provider/model。
4. 通过临时文件和原子重命名写入。

受管理条目携带 `_piModelDoctor` 元数据，包含来源、最近检查时间、修复策略、受管理字段和最近受管理值。未知 JSON 字段和用户自有的 headers/endpoint 覆盖保持不变。

迁移默认保留源模型，除非传入 `--remove-source`。不会复制 API key、OAuth、授权/secret headers、endpoint 覆盖或用户自有能力覆盖；冲突时目标值优先。回滚已持久化的修改使用 `/model-doctor rollback <models.json.bak-<timestamp>> [--dry-run] [--yes]`。命令会验证备份是常规、可解析的 models 文件，创建当前文件的独立 safety backup，原子恢复已验证的备份，并在支持时刷新/验证活动模型注册表。如果无法验证激活，重新加载 Pi 并运行 `/model-doctor check`；备份包含原始凭据，必须像 `models.json` 一样保护。

## 缓存与离线行为

本地缓存默认位于：

```text
~/.pi/model-doctor/models-cache.json
~/.pi/model-doctor/providers-cache.json
~/.pi/model-doctor/policies-cache.json
```

`policies-cache.json` 包含 reasoning/cache resolver 使用的版本化能力策略目录。其 baseline 记录 Pi 兼容性基线（`0.82.1`）、models.dev schema 标签（`api.json`）、归一化 schema 版本（`1`）、观测日期、PolicyCatalog schema 版本和 `_piModelDoctor` 元数据版本。无效、不兼容、敏感或权限不安全的数据会被忽略并重新生成。`models-cache.json` 保存归一化完整 catalog；`providers-cache.json` 保存 provider 摘要、环境变量名、所选 adapter、reasoning 控制方式和独立的 prompt/context/KV 能力信号。缓存写入拒绝敏感字段；缓存目录 mode 为 `0700`，缓存文件 mode 为 `0600`。能力结果包含 resolved、partial、advisory 或 unsupported 状态；价格元数据不视为启用运行时缓存的授权。每个结果都保留来源和置信度，避免把 provider 事实误认为已验证的 Pi runtime 行为。

可用 `PI_MODEL_DOCTOR_DIR` 覆盖位置；用 `PI_MODEL_DOCTOR_MODELS_PATH` 覆盖配置目标；用 `PI_MODEL_DOCTOR_MODELS_DEV_URL` 覆盖 models.dev endpoint。自定义 endpoint 必须通过相同的 HTTPS/私网策略；显式信任的私有测试基础设施需要 `PI_MODEL_DOCTOR_TRUSTED_ENDPOINT=1`。刷新是本地优先、故障安全的：网络刷新失败时保留有效旧缓存并报告其已过期。会话级后台刷新默认每 24 小时运行一次，带有限随机抖动以减少多会话刷新风暴；设置 `PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS=0` 可禁用。`PI_MODEL_DOCTOR_REFRESH_JITTER_MS` 可覆盖抖动上限。后台刷新只更新 catalog 缓存并报告 warning；从不修改 `models.json`。

## Provider 能力

缓存和 reasoning 引擎由元数据驱动，而不是有限模型表。它们为 OpenAI-compatible、OpenAI Responses、Anthropic Messages、Google 和未知 provider fallback adapter 归一化 prompt/context/KV-cache 信号以及 reasoning toggle/effort/budget/adaptive 选项。Provider 专属兼容性元数据记录 reasoning 预算、thinking 配置、独立 cache 能力和不支持的 runtime 行为。预算值与输出 token 上限保持区分；未知/建议性能力不会静默呈现为已启用。因此无需修改扩展即可发现新的 models.dev provider。对于第三方渠道，这些只是模型事实和建议性能力数据；不代表第三方传输实现了相同的 runtime 行为。

## 开发

在仓库根目录：

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

本仓库不会把 `@earendil-works/pi-coding-agent` 安装或固定在 `devDependencies` 中，而是将 Pi 声明为可选的宿主 peer。开发脚本会解析机器上已经安装的 Pi，并使用该版本执行类型检查和测试；如果无法自动找到 Pi，可设置 `PI_HOST_PACKAGE` 为已安装的 `@earendil-works/pi-coding-agent` 包目录。这样本地检查使用的就是实际加载扩展的 Pi 版本，开发辅助脚本也不会进入发布包。

安装到其他 Pi 项目：

```bash
pi install npm:pi-model-doctor
```

或从本地检出测试：`pi install /absolute/path/to/pi-model-doctor`。

领域模块刻意保持轻依赖，可用临时目录和 mocked `fetch` 实现测试。
