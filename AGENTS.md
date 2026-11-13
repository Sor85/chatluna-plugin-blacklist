# AGENTS.md — Blacklist

## 项目

ChatLuna v2 / Cordis 4 的独立扩展插件，让机器人自己拉黑辱骂、骚扰它的用户：提供拉黑（理由必填）、解除拉黑与查看黑名单的工具，并拦截已拉黑用户的对话和指令。管理指令只用于人工查看与撤销。许可证为 MIT。不得改动 ChatLuna 核心来实现功能。

## 开发与验证

- 修改前阅读本机的 ChatLuna 插件规范（如 `~/.claude/docs/CHATLUNA.md`，若存在），实际 API 以开发副本源码为准，不使用 ChatLuna v1 示例代替 v2 API。
- 当前目录是唯一源码来源，不安装依赖、不生成锁文件或构建产物。`node scripts/dev.mjs` 单向同步到 v2 的 `external/blacklist`，在该 workspace 中执行 Yarn、TypeScript 和 Vitest。
- 首次执行 `node scripts/dev.mjs install`；修改后执行 `node scripts/dev.mjs check`（同步、构建、类型检查、测试），也可单独执行 `sync`、`build`、`typecheck`、`test`。
- 开发副本默认位于 `../../chatluna-v2-mirror`，可用 `--mirror <路径>` 或 `CHATLUNA_V2_ROOT` 覆盖；需要 Node.js ≥24 和 Yarn 4。
- 发布用 `node scripts/publish.mjs`（`--dry-run` 演练，`--otp=<验证码>` 应对两步验证），不经 yarn 启动。v2 仍为私有仓库，发布在本机完成：要求工作区干净、已推送、tag 未占用、npm 已登录；同步后清空副本的 `lib`、`dist`、`tsconfig.tsbuildinfo`，用 `dev.mjs check` 重新构建并测试，`yarn pack` 改写 `workspace:*` 后解压再 `npm publish`（直接发布 tgz 时 npm 元数据缺 readme，市场显示「暂无说明」），最后打 `v<版本>` tag 并推送。
- README 面向插件使用者，不写本地开发步骤；开发命令与约定放在本文件。
- 不提交、发布、创建分支或更改宿主运行配置，除非用户明确授权。

## 实现约定

- 黑名单存表 `chatluna_blacklist`（主键 `platform:userId`），启动时整表读入内存，入站判断只查内存；写入先落库再改内存（`src/blacklist.ts`）。
- 对话拦截挂 `chat/before-receive` 与 `chat/before-open`：前者拦唤醒与入库，后者拦 observer 旁听记录直接派发的消息。指令不经过 chat 钩子，由 `command/before-execute` 返回空字符串拦截（`src/commands.ts`）。
- 限时拉黑存 `expiresAt` 时间戳，0 表示永久。到期记录在内存中按未拉黑处理，不设定时器；加载时删除到期行，再次拉黑时用 upsert 覆盖。时长解析用 `cosmokit` 的 `Time`。
- 拉黑校验集中在 `Blacklist.add`：理由去空白后必填、重复拉黑不覆盖原理由。不按权限等级保护任何用户（用户明确要求，工具定位是 bot 自卫而非管理员工具）；只由调用方按会话的 `selfId` 拒绝拉黑机器人自己。
- 工具调用身份是当前说话者，即通常的被拉黑者，所以 `blacklist:add` / `blacklist:remove` 默认等级 1；`blacklist_user` 的 `userId` 缺省为当前说话者。
- koishi 为可选服务，未加载时只屏蔽对话，不注册管理指令。

- 设置页黑名单挂在 Config 的 `list` 字段（`Schema.any().role('blacklist:list')`）上，该字段不存值：`client/blacklist-table.tsx` 不调用 `onChange`，也不用 SchemaForm 的 `Field`/`extensionProps` 外壳，避免出现恢复默认与 JSON 编辑菜单。v2 没有按插件区分的设置页插槽（`plugin.tab` 会出现在所有插件上），所以用字段扩展。
- 数据走 `chatluna_webui.state('blacklist.list')`，`refreshOn: ['blacklist/change']`；`Blacklist` 在加载完成与每次增删后触发该事件。解除拉黑走 `action('blacklist.remove')`，不经过插件配置（`src/webui.ts`）。到期不推送，前端每 30 秒按本地时间过滤到期行。
- `src/webui.ts` 增强 `@chatluna/ui-client/client` 类型，会把前端源码带入服务端编译，所以主 tsconfig 带 DOM 与 JSX 配置。组件用宿主 `@chatluna/ui-kit`、`AlertDialog` 与 Lucide 图标；`@chatluna/ui-client` 是客户端构建的发现标记，须留在开发依赖里。新增 Tailwind 类后须完整重启宿主（launcher 与 worker）再验证。

## 测试

- 单元测试使用内存 SQLite、真实权限/工具服务和真实 OneBot 适配器解析，不发送真实消息。
- 端到端验证使用 onebot-sandbox 的 HTTP 测试接口，只在本任务新建的测试空间内操作，结束后 `complete_test_space`；令牌只放请求头，不写入仓库或日志。
