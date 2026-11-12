# DSH 平台核验与兼容范围（M0 报告）

核验日期：2026-11-10（Asia/Shanghai）。核验对象是**当前正在运行的这套 DSH**，不是文档包里的源码快照。
开发包 `docs/dsh_integration.md` 基于提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；本文记录实际安装版本与接口差异，开发以运行版本为准。

## 1 实际环境（已核实）

| 项 | 值 | 证据 |
| --- | --- | --- |
| DSH 运行时版本 | `@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.1` | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json:4` |
| 应用版本 | `0.2.2-rc.1` | `/Applications/DeepSeek Harness.app/Contents/Info.plist` CFBundleShortVersionString |
| Profile | `desktop` | `DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=~/.dsh/profiles/desktop` |
| 运行方式 | macOS Desktop（Electron），Web GUI 由 Host 的 `webServer` 提供 | GUI URL `http://127.0.0.1:54731`（本轮会话 runtime context）；`ctx.webServer` 服务在运行 |
| 操作系统 | macOS 27.3，arm64 | `sw_vers`、`uname -m` |
| Node（Host 进程） | v26.11.1 | 本会话 bash 环境；`node:sqlite` 可用，SQLite 3.53.4 带 FTS5（已实测建表） |
| 当前模型 | provider `opencode-go`，model `deepseek-v4.1-flash`，reasoningEffort `max` | profile `cordis.patch.yml` 的 `agent-default-model`；当前会话 runtime context 与工具列表一致 |
| 模型图像能力 | **支持 image 输入**（配置声明 `input: [text,image]`） | profile patch `llm-pi-ai` 模型表；真实图像送达仍需在工具调用中验证（实测见 §5） |
| 会话/执行器 | 原生工具执行器（`tool-executor-native` 为启用行），PTC 运行时已挂载 | profile 插件列表（plugin_manager list）、`cordis_inspect_query` 服务目录 |
| HMR | 启用（`@deepseek-ai/dsh-hmr`，`include:hmr` active） | plugin_manager 列表；HMR README 语义 |
| 已装第三方插件 | `dsh-academic-ppt@0.10.0-rc.6`（启用）；`dsh-coopanion-work@0.2.3`（已装但**因 engines.dsh 不兼容被禁用**） | plugin_manager list_bundles |

结论：当前是**源码快照之后的正式运行时**。开发包列出的接口需要逐项核对；`dsh-coopanion-work` 的 `incompatible-version` 说明 DSH 会按 `engines.dsh` 拒绝不兼容插件，本插件因此不声明过窄的 `engines.dsh`，只在 README 写明实测兼容版本。

## 2 已核实的公开接入点（本插件实际使用）

用 `cordis_inspect_list` / `cordis_inspect_query` 对**运行中**的 Host/Client 服务与 Slot 目录查询确认；源码位置指当前安装包内 `@deepseek-ai/*`（已从 `app.asar` 解出核对）。

### 2.1 全局论文中心（P0-01）

| 目标 | 接口 | 证据 |
| --- | --- | --- |
| 主侧栏入口 | Slot `sidebar.panellist`（list，root）注册 `{id, order, label}`；list 的 id **就是** `main` 面板的 key；owner props `{size, active}` | `Slots.listSubTree` 实测；`ui-plugin-manager/lib/client.js` 同法注册 `plugins` 入口 |
| 全局主页面 | Slot `main`（keyed，root）注册 `{key}`；`key === 侧栏入口 id` 时点击入口显示该页 | `Slots.listSubTree("main")` catalog；`ctx.layout.selectPanel(id)`（Client `layout` 服务） |
| 布局服务 | `ctx.layout.selectPanel(panelId)`、`beginNavigation()`、`openRightbar(track,fullscreen)`、`closeRightbar()` | Client `Service.listService` 的 `layout` |
| 主题 | `Theme.listTokens` + `--dsw-alias-*` 变量（浅色/深色自动切换） | Client `theme` 服务；`dsh-client-ui-plugin-manager` 样式实践 |
| 语言 | `ctx.locale.register(ns, {zh,en,...})`、`ctx.locale.bind(ns)` | Client `locale` 服务；已装插件 locale 实例 |

### 2.2 对话右栏论文抽屉（P0-02）

| 目标 | 接口 | 证据 |
| --- | --- | --- |
| 注册 tab 类型 | `ctx.sidebarRightTabs.register({id, kind, title?, multiple?, ...})` → disposer | `dsh-client-ui-sidebar-right` README「Extension seats」；`dsh-client-ui-sidebar-documentpreview/lib/client.js` 真实用法 |
| 渲染 tab body | Slot `sidebar.right.pane.tab`（keyed，session）注册 `key: definition.id`；body 可得 `{sidebar,panel,tab}` 与 `tab.actions` | 同上；`Slots.listSubTree` 目录 |
| 打开抽屉 | `ctx.sidebarRight.openTab('pappers-hall')`；面板展开由宿主负责 | `sidebarRight` 服务契约（openResource/openTab/close/active/isExpanded…） |
| 收起后入口 | Slot `conversation.session.header.corner`（single，session）放一个“论文”按钮 | `Slots.listSubTree` 目录；`ui-sidebar-right` README 说明该 corner 席位用途 |

### 2.3 多选材料进入草稿（P0-03 的可用部分）

| 目标 | 接口 | 证据 |
| --- | --- | --- |
| 输入框上方扩展位 | Slot `conversation.input.dock`（list，session），owner props `InputZone{session,input}`，standardProps 含 `inputActions: InputActions` | `Slots.listSubTree("conversation.input.dock")` 实测 |
| 草稿插入动作 | `inputActions.captureInsertion(): {start,end,draftRev}` 与 `inputActions.insertText(text, span): boolean`；失败通常是 `draftRev` 变化，需重新捕获 | `dsh-client-ui-conversation/lib/client.js` 中 `SessionInputShell.actions` 定义（`captureInsertion`/`insertText`/`setDraft`/`persistDraft`） |
| 只改草稿不发送 | 上述动作不触发提交；发送仍由用户点击 | 同上；本插件“加入草稿”按钮只调用 `insertText` |
| 已有草稿/附件 | `insertText` 按位置插入，不清空草稿；不触碰附件 | 同上 |

### 2.4 原生还原与引用

| 目标 | 接口 | 证据 |
| --- | --- | --- |
| 会话行拖放目标 | **无公开的行级 drop 协议**：`sidebar.session.row.trailing`/`hover` 明确是“非交互装饰”（Slots catalog），`sidebar.session.row.action` 只接受按钮/菜单 | `Slots.listSubTree` catalog 原文；`docs/dsh_integration.md` 亦把它列为宿主扩展缺口 |
| 结构化引用 chip | 公共输入动作只到 `insertText`；`slash/input-insert-reference` 与 `ReferenceChipNode` 需要注册输入触发器源和引用序列化器（`ReferenceCodec`），当前只对内置/动态包开放 | `dsh-client-ui-conversation/lib/client.js`、`dsh-client-ui-input-trigger/lib/client.js` |
| 回答出处卡 | Slot `conversation.chat.turnTail`（list，session）可放来源卡 | Slots 目录 |

### 2.5 模型真实图像（P0-06 的硬门槛）

| 目标 | 接口 | 证据 |
| --- | --- | --- |
| 保存原图 | `ctx.attachments.saveImage({data: Uint8Array, mediaType, name?})` → `ImageAttachmentRef{attachmentId,mediaType,width,height,bytes,name?}` | Host `Service.listService` 的 `attachments`；`dsh-attachment/lib/types/admission.js` 与 `dsh-attachment-local` 实现 |
| 工具返回图像 | 工具 `output.render()` 返回 `[{type:'image', attachment: ref}, {type:'text', ...}]`；Host 采用 `@deepseek-ai/dsh-tools` 的渲染契约 | `dsh-tools/README.md`「defineTool」；`dsh-llm` ImageBlock 类型 |
| 模型能力检查 | 模型配置声明 `input:[text,image]`；不支持图像的模型会收到占位文本 | profile patch；`dsh-llm` 请求处理说明 |

### 2.6 安装、启停与生命周期

| 目标 | 接口 | 证据 |
| --- | --- | --- |
| 安装本地目录 bundle | `plugin_manager install_bundle`，target `link:<绝对包目录>`（开发态本地包） | `dsh-plugin-manager/README.md`「Source Web and development Desktop offer link:<absolute workspace package directory>」 |
| 开关单行插件 | `plugin_manager set_plugin {id, enabled}`；HMR 启用时**立即生效**，否则 `restart-required` | 同 README；本 profile HMR 启用 |
| 卸载 | `plugin_manager remove_bundle`（移除 profile 依赖与 bundle 选择） | 同 README |
| 插件数据 | 插件自有目录，不复用 profile/工作项目；本插件用 `$DSH_HOME/pappers-hall/` | 实现约定 |
| 重复注册保护 | Loader 行启停会 dispose `ctx.effect` 注册；本插件所有注册均有 disposer | 实践规则（`references/practices.md`） |

## 3 开发包的假设与运行版的差异

| 开发包假设 | 实际运行版 | 本插件处理 |
| --- | --- | --- |
| `ctx.sidebarRightTabs.register(definition)` 存在 | 存在（Client 服务） | 直接使用 |
| `ctx.uiWorkspace.openSession(target)` 存在 | 存在（Client `uiWorkspace` 服务） | 仅用于“打开目标会话”（本版未做跨会话行投放） |
| `SessionInput.insertReference(ref, span)` 公开可用 | 仅内部 `SessionInputShell` 使用；公共面是 `inputActions.insertText` | 用标准文本材料令牌 + Host bundle 范围校验；结构化 chip 需要宿主扩展（见 §4） |
| 会话行整行接收 drop | **不提供** | 记录为宿主扩展缺口，不做私有 DOM 监听 |
| `captureInsertion()` 得到 TokenSpan | 存在，且带 `draftRev`，必须在插入前校验 | 使用；失败重试一次并重新捕获 |
| `ReferenceCodec.serialize(ref, signal)` 可扩展 | 未找到公开注册入口 | 不伪造引用卡；材料以不可变 bundle 快照 + 文本令牌表达 |
| 模型图像输入默认可知 | 当前模型声明支持 image；实际送达需验证 | `papers_get_figure` 用 `attachments.saveImage` + ImageBlock，并记录验证结果 |
| 依赖可安装（PDF.js/GROBID/OCR/向量模型） | 本 profile 无 GROBID/Tesseract/本地嵌入模型；`translator` 服务未启用 | 首版用系统 poppler（pdfinfo/pdftotext/pdftoppm）做文字层与页面渲染；OCR/向量/翻译显式降级，界面显示原因 |

## 4 必需的宿主扩展（本插件交付范围内明确列出）

| 缺口 | 影响 | 本版替代 | 建议宿主接口 |
| --- | --- | --- | --- |
| 会话行拖放目标协议 | P0-03“拖到已有会话行松开”无法原生完成 | 右栏抽屉 + composer dock + “引用到对话”按钮进入**当前会话**草稿；跨会话投放未实现 | 行级 drop target：`{sessionId, acceptedTypes, hoverIntent, onDrop, loading/error}`，与排序 MIME 分离 |
| 持久草稿批次写入 | 目标会话未挂载时无法可靠持久化多材料插入 | 只在目标输入框已挂载时插入；失败保留 pending 记录可重试 | `draftBatch` 事务接口（opId 去重、draftRev、保留已有草稿/附件、不自动发送） |
| 结构化引用序列化器 | `papers://` 或材料组卡片无法成为原生 chip | 文本材料令牌 + `references.commit` 不可变快照 + Host 校验 | `ReferenceCodec` 公开注册 + Host 解引用钩子（按调用 Session 校验） |
| 图片/来源配对进入草稿附件 | 不能把原图直接作为草稿附件发送 | 通过 `papers_get_figure` 工具结果把真实 ImageBlock 送入模型（本版已实现） | 草稿附件批量接口：`{image, sourceRef}` 成对提交、失败不留半项 |
| 会话范围权限读取 | 跨会话材料授权需宿主参与 | Host 侧 bundle 记录绑定创建时 Session；工具调用时校验 | `sessions` 权限查询与 bundle 接纳记录 |

## 5 图像真实进入模型的验证结果

见 `reports/verify.md` 的“真实看图”一节（由验收脚本 `test/visual.mjs` 记录）：验证时记录实际 provider/model/executor、工具结果中的 `ImageAttachmentRef`、以及随后模型回答中只能从像素读出的信息（图内文字/刻度）。**仅生成 PNG 或仅把图片路径给模型不算通过。**

## 6 兼容性结论

- 已验证可安装并运行的组合：DSH **0.2.2-rc.1**（desktop profile，macOS arm64，Node 26）。
- 本插件不修改 DSH 源码、不改 profile 配置文件、不监听私有 DOM、不写 `localStorage` 作为资料库；停用即卸载全部注册（见 `reports/verify.md` 的开关测试）。
- 对更早版本：开发包快照（fcc0ad4，约 0.2.1-rc 系列）中的 Slot/服务名与当前基本一致，但本插件**只声明并实测 0.2.2-rc.1**；其它版本未验证，不宣称兼容。
