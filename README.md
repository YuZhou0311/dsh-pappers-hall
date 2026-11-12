# Pappers-Hall：DSH 原生论文中心插件

在 DSH 里管理论文、读原文、做批注、按文字或截图找图，并把选中的论文/图表/批注直接带进研究对话。
本仓库是 `pappers_hall_devkit_lite` 开发包的实现：**一个可安装、可启停、停用后对原生 DSH 零影响的官方形态插件**（Host 半包 + Web Client 半包），不是静态演示页，也不是独立网页。

- 插件包名：`dsh-pappers-hall`（bundle 行 id：`pappers-hall`）
- 实测运行环境：**DSH 0.2.2-rc.1**，`desktop` profile，macOS arm64，Node 26.11.1，Web GUI `http://127.0.0.1:54731`
- 平台核验与接口证据：[docs/compatibility.md](docs/compatibility.md)
- 内部实现契约：[docs/CONTRACT.md](docs/CONTRACT.md)
- 验收结果：[reports/verify.md](../reports/verify.md)（另见 `reports/test-results.json`、`reports/papers.md`）

## 1 功能总览

| 区域 | 能力 | 实现方式 |
| --- | --- | --- |
| 主侧栏“论文中心” | 全局入口，独立于工作项目；重启/切换项目后仍在 | `sidebar.panellist` + `main` keyed panel |
| 论文中心页 | 网格/列表切换、中文译名与原题并列、真实页面缩略图、搜索与筛选、多选（Cmd/Ctrl、Shift 连选、网格框选）、批量操作、回收站、状态条 | Client 页面 + Host JSON API |
| 阅读器 | 原图主位、页缩略图、页码跳转、原文文字层、原文/双语切换、批注（文字/区域）、图表面板、引用导出 | poppler 页面渲染 + FTS 文字层 + Client 阅读器 |
| 图片检索 | 图注/图内文字检索、上传截图做**感知哈希近重复**检索，命中原因分通道显示；视觉语义通道不可用时显式降级 | `figures_fts` + dHash |
| 对话右栏“论文”抽屉 | 不离开当前任务；搜索论文/笔记/图片，多选后“引用到对话” | `sidebarRightTabs` + `sidebar.right.pane.tab` |
| 草稿材料 | 输入框上方显示已选材料组；“加入草稿”只改草稿、不发送、可重复点击不重复插入 | `conversation.input.dock` + `inputActions.captureInsertion/insertText` |
| 对话入口 | 会话标题栏右侧“论文”按钮打开抽屉 | `conversation.session.header.corner` |
| Agent 工具 | `papers_search`、`papers_get_passage`、`papers_get_figure`（真实图像）、`papers_translate`、`papers_propose_changes`、`papers_apply_changes`、`papers_cite`、`papers_index_status` | `ctx.tools.register` |
| 后台维护 | 持久任务队列（租约/重试/取消/暂停恢复/检查点）、事件增量导入、删除/恢复一致性 epoch | SQLite + Host worker |
| 删除与恢复 | 软删进回收站后**立即**退出检索与工具读取；恢复使用新 epoch；迟到写入被拒绝 | `state` + `epoch` |
| 数据隔离 | 资料库在 `$DSH_HOME/pappers-hall/`，与 profile、工作项目、会话记录分离 | Host 自有目录 |

**明确降级（当前环境没有对应依赖，界面会说明原因而不是假装可用）**：OCR、视觉语义嵌入（向量检索）、机器翻译（本 profile 未启用 `translator` 服务）、GROBID 结构化解析。

## 2 安装

### 2.1 前置

- DSH 0.2.2-rc.1（desktop 或 web profile 且有 `webServer`、`tools`、`timer` 服务）
- 系统自带/自行安装的 poppler 工具：`pdfinfo`、`pdftotext`、`pdftoppm`（macOS 可用 `brew install poppler`）。插件不打包这些二进制，只在 PATH 中调用；也可在插件配置 `pdfTools` 中显式指定路径。
- 不需要 `pnpm install`：本插件零 npm 依赖（只用 Node 内置模块）。

### 2.2 安装为 profile 插件（推荐）

在 DSH 会话里让 Creator/Agent 执行（等价于内置 `plugin_manager` 工具）：

```text
plugin_manager install_bundle
  target: link:/Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin
```

`link:` 安装会把本目录作为 profile 依赖（开发态本地包），HMR 启用时新插件行立即生效，无需重启。
手工等价方式（仅说明，不推荐手改 profile）：

```bash
dsh plugin --profile desktop add link:/Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin
```

安装后应看到：
- 插件管理页出现 **Pappers-Hall**（标题、描述、图标来自 `locale/*.json` 与 `icon.svg`）；
- 左侧栏出现“论文中心”图标；
- 任意对话标题栏右侧出现“论文”按钮；
- Agent 工具列表出现 `papers_*`。

### 2.3 配置（可选）

bundle 行的 `config`（在 profile 的 `cordis.patch.yml` 或插件详情页修改）：

```yaml
- id: pappers-hall
  name: dsh-pappers-hall
  config:
    dataDir: /Users/you/.dsh/pappers-hall   # 资料库目录（默认值）
    fixtureDir: /Users/you/Project/Pappers-Hall/pappers_hall_devkit_lite/papers  # 测试资料目录（可选）
    testMode: false                          # true 时把导入记为测试数据
    pdfTools:                                # 可选：覆盖 poppler 可执行文件路径
      pdfinfo: /opt/homebrew/bin/pdfinfo
      pdftotext: /opt/homebrew/bin/pdftotext
      pdftoppm: /opt/homebrew/bin/pdftoppm
```

### 2.4 首次导入测试论文（可选）

论文中心页右上角“导入”可选择 PDF；也可以让 Agent/脚本调用 API：

```bash
curl -sS http://127.0.0.1:54731/pappers-hall/api \
  -H 'content-type: application/json' \
  -d '{"method":"library.import","params":{"paths":["/绝对路径/papers/pdf/A01_react.pdf"],"operationId":"demo-1"}}'
```

30 篇测试论文的下载与版本核对见 [reports/papers.md](../reports/papers.md) 与 `pappers_hall_devkit_lite/papers/inventory.json`（30/30 SHA-256 与页数一致）。

## 3 启用、停用、卸载

| 操作 | 方式 | 行为 |
| --- | --- | --- |
| 停用插件 | 插件管理页关闭 **Pappers-Hall** 开关，或 `plugin_manager set_plugin {id:"pappers-hall", enabled:false}` | Host 行卸载：取消定时器、关闭 SQLite、注销 HTTP 路由与 8 个 Agent 工具；Client 行移除：侧栏入口、主页面、右栏 tab 类型、composer dock、标题栏按钮全部消失。**资料库文件保留**，原生 DSH 不受影响 |
| 重新启用 | 打开开关 / `enabled:true` | 重新挂载同一份资料库；不重复注册（Loader 保证行生命周期唯一） |
| 重启后 | — | 开关状态保存在 profile bundle 选择里；重启不会自动改变启用状态，也不会丢数据 |
| 卸载 | `plugin_manager remove_bundle {target:"dsh-pappers-hall"}` | 移除插件代码与启用选择；`$DSH_HOME/pappers-hall/` 资料库保留，可手动备份/删除 |

验证细节（停用后 API 404、工具消失、原生对话与插件页无报错、重启后状态保持）见 [reports/verify.md](../reports/verify.md)。

## 4 数据、备份与迁移

| 内容 | 位置 |
| --- | --- |
| 资料库（SQLite + 页面/图表缓存 + PDF 副本索引） | `$DSH_HOME/pappers-hall/`（默认 `~/.dsh/pappers-hall/`） |
| 数据库 | `pappers-hall/library.sqlite`（WAL 模式） |
| 页面/图表渲染缓存 | `pappers-hall/cache/`（可随时删除，自动重建） |
| 导入的 PDF | 默认不复制原文件，只记录绝对路径与 SHA-256；文件被移动/删除时论文进入“来源不可用”状态而不是伪造内容 |

- **备份**：停用插件后复制整个 `pappers-hall/` 目录（或运行中 `sqlite3 library.sqlite ".backup backup.sqlite"`）。
- **恢复**：把备份目录放回原位并启用插件。
- **卸载后**：资料库不会自动删除；如要彻底清除，停用插件后删除该目录。
- **迁移到另一台机器**：复制资料库目录，同时保证 PDF 路径可达（或重新导入 PDF，哈希去重不会产生重复条目）。

## 5 Agent 工具

| 工具 | 说明 |
| --- | --- |
| `papers_search` | 在“本次引用材料 bundle”或用户明确授权的论文库中检索文字/图注/批注/笔记，返回命中原因与原文位置 |
| `papers_get_passage` | 读取某论文指定页/锚点原文，返回文件版本 SHA-256 与深度（fulltext/abstract/metadata_only） |
| `papers_get_figure` | 返回图注/页码/尺寸等 JSON，并把**真实图像**通过 DSH 附件服务作为 ImageBlock 返回给当前模型 |
| `papers_translate` | 翻译标题/段落/页面（宿主 `translator` 服务缺失时明确 `unavailable`，不伪造译文） |
| `papers_propose_changes` | 提议改译名/标签/批注/笔记（只登记，不应用） |
| `papers_apply_changes` | 按 proposal 幂等应用，返回逐项结果与撤销凭据 |
| `papers_cite` | 按 APA/BibTeX/GB-T 7714 生成引用文本（正式书目优先） |
| `papers_index_status` | 查看计数、索引通道状态、任务队列与降级原因 |

来源范围校验：材料由“引用到对话”生成不可变 bundle（记录创建时 Session），工具在 Host 按**实际调用 Session** 校验 bundle 绑定，用户只拖入两篇时不会读取整库；来源删除/失效立即拒绝。

## 6 依赖、许可与安全

- **运行时依赖**：Node 内置模块（`node:sqlite`、`node:child_process`、`node:crypto`、`node:fs` 等）。无 npm 第三方依赖、无 Python 依赖、无网络服务依赖（DOI/Crossref 查询为可选离线降级）。
- **外部程序**：poppler（`pdfinfo`/`pdftotext`/`pdftoppm`，GPL-2.0+，以**独立进程**调用，不链接、不打包、不修改）；系统图像缩放可选使用 `sips`（macOS 自带）。分发本插件源码不包含上述程序的代码。
- **前端**：React 由 DSH 宿主模块表提供，不重复打包；图标 `icon.svg` 为本项目原创（MIT）。
- **数据安全**：资料库只在本机 Host 与同源浏览器之间通过 `127.0.0.1` 传输；HTTP API 仅注册在 Host 已绑定的回环地址上，不做跨机共享；不放论文全文进日志；工具输出按需读取、不向模型发送整库。
- **许可**：插件代码 MIT（见 `LICENSE`）；30 篇测试论文各自许可见 `pappers_hall_devkit_lite/papers/licenses.md` 与 `inventory.json`，不随插件分发。

## 6.5 v0.2 迭代（2026-11-10 晚，针对第一轮用户反馈）

第一轮交付后用户反馈：阅读器“对照彻底没法看”、要像 Zotero 一样直接看 PDF/标注/让 AI 定位、库要能看到标签/收藏夹/详细信息、向量检索不可用、与 Agent/DSH 联动不足、UI 要更顺滑。v0.2 已完成：

| 反馈 | v0.2 改动 | 验证 |
| --- | --- | --- |
| 对照没法看 | 阅读器重做：Host 用 `pdftotext -bbox-layout` 生成真实版面（blocks 段落/栏/角色 + words 坐标），Client 渲染页面图 + **文字选择层**；双语改为**段落卡片**（正文/标题/题注分角色，页眉/表格默认隐藏），逐段翻译/整页翻译、进度与重试 | 真实 GUI 截图 + `test/v02.mjs` READER/AI 用例 |
| Zotero 式标注 | 页面上拖选即高亮（5 色）、区域标注、便签；每个高亮按行合并 rect（归一化 0–1，缩放/滚动不漂移）；点击标注弹 popover 可改色/编辑/删除/复制/引用/问 AI | 真实浏览器创建高亮并经 API 读回（3 行=3 rects，quote 干净） |
| 标签/收藏夹/详细信息 | 三栏 Zotero 式文献库（智能视图 + 5 领域 + 自定义收藏夹 + 标签），详情面板含题名/原题/译名/作者/年份/来源/DOI/arXiv/许可/PDF 版本/SHA-256/页数/文件大小/**摘要**/来源链接/收藏夹/图表网格 | `test/v02.mjs` LIB 用例 + 截图 |
| 向量检索不可用 | 新增 **AI 语义通道**：用 DSH 当前模型做中文→英文关键词扩写（+可选 Top-20 LLM 重排），channels 标注 `ai_expand/ai_rerank`；仍是“LLM 关键词扩展召回”而非向量，报告如实区分。**AI 翻译**（标题/段落）与 **AI 问答**（可选带页面/图真实像素）同时上线 | `test/v02.mjs` AI 用例：translate.blocks 真实中文译文、ai.ask 文本+看图（读出 Figure 1 的 (1a)–(1d)/(2a)/(2b)）、ai_expand 通道 |
| DSH/Agent 联动 | `tool.call.toolview` 自定义工具卡（papers_* 结果→论文/图/页来源卡，可“打开原文”/“引用到对话”）；阅读器 AI 面板“发送到对话”进入 pending→composer dock；新增 `papers_get_annotations`/`papers_annotate` 工具（Agent 可读写标注、按页/页码定位） | 工具 10/10 注册；selftest 187 checks PASS |
| UI 顺滑 | 深/浅色主题、动效（stagger/骨架 shimmer/弹簧工具条/交叉淡入/抽屉滑入）、键盘与右键菜单、可拖拽三栏、空态/降级态 | 真实 GUI 截图（`reports/screenshots-v02/`） |

v0.2 新增验收脚本：`node test/v02.mjs`（26 项，真实 Host；结果 `reports/v02-api-results.json`）。v0.1 回归套件保持：`node test/run-tests.mjs`。

最终验收数字（2026-11-10 晚，v0.2 交付状态）：

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `test/v02.mjs` | **26/26 pass** | 阅读器结构/标注 v2/收藏夹标签/详情/AI 翻译问答看图/AI 扩写/回归 |
| `host/selftest.mjs` | **PASS 198 checks** | 无 DSH 依赖的 Host 自测（含 C05 图注恢复、双栏顺序、AI 解析、迁移幂等） |
| `test/run-tests.mjs`（v0.1 全量，在 v0.2 上重跑） | 184 项：**110 pass / 49 fail / 25 not_run** | 相比 v0.1 首次 99/60/25，AI 扩写与图注恢复带来 +11 pass；剩余 fail 均为能力边界（无 embedding/OCR/中文分词）与人工项，详见 `reports/verify.md` |
| 真实 GUI 截图 | `reports/screenshots-v02/01..08` | 三栏库/详情/阅读器/双语/AI/选区/直接标注 |

## 6.6 v0.3 迭代（2026-11-10 深夜，针对第二轮用户反馈）

第二轮反馈：批量条溢出叠字、窄窗右栏半透明表头透出、标注 popover 引用错乱溢出、尺寸不统一、选段看不到选区、选中后无法 AI 非思考快速翻译、没有撤销、论文信息要更多（影响因子等）、要对标 Zotero 常用插件、论文要能拖进指定对话、整体继续美化。v0.3 已实现：

| 反馈 | v0.3 改动 | 验证 |
| --- | --- | --- |
| UI 重叠/尺寸混乱 | 批量条移入中栏定位并换行、右栏实色、详情标题 2 行 clamp + tabs 独立 sticky、统一控件 26/28 与正文 12–13、弹层 ≤340px + 视口内翻转/滚动 | 四档窗口（1586/1280/1100/960）DOM rect 审计全部 PASS：batch 全在中栏内、表头∩右栏=0、标题∩tabs=0、无横向滚动 |
| 选段看不到/引用错乱 | 选区改为**几何命中**（word bbox 实时相交 + 列聚类隔离，跨栏不串），拖动中实时半透明覆盖层 + “已选 N 词”，quote/rects 由命中词重建（每行 1 rect、排除旋转词） | 真实 GUI 拖选截图 + 真实 Host 标注 quote 干净、创建/撤销闭环 |
| 快速非思考翻译 | 选区工具条首项“快速翻译”：`ai.quickTranslate`/`translate.text {fast:true}`，Host 选最低 reasoning effort（实测 fast=**low** vs deep=**max**），结果卡显示“非思考模式 · 秒数 · 模型”，失败给 Host 原因 + 重试 | 真实 GUI 5.9s 中文译文；API 实测 fast 2985–4846ms vs deep 2420–5098ms（provider 波动，如实记录，无硬目标） |
| 撤销 | Host `operations` 日志 + `operations.recent/undo`（幂等、不可逆返回 not_undoable）；Client 全局 ⌘Z/⌘⇧Z + toast“撤销”，reader 通过注入 undo 复用（无重复注册） | UNDO 7/7（标注 create/update/delete、setRead、tags、delete、幂等、not_undoable）；真实 GUI 高亮 4→5→4 |
| 论文信息/影响因子 | 详情分节：基本信息/出版信息/计量指标/摘要/关键词/收藏夹/标签/图表/笔记/批注；指标区含 JCR 影响因子（手动）、**OpenAlex 2 年均被引（非 JCR IF）**、被引次数、期刊 h-index、分区、来源与相对时间、刷新/重置指标、失败原因；`metrics.refresh` 显式联网（OpenAlex+Crossref）、7 天期刊缓存、手动优先、不伪造 | API：C05 refresh 成功 `source=openalex+crossref, citedBy=332, 2yr=20.8698, hIndex=756, ISSN=2041-1723, impactFactor=null`；无 DOI→failed/no-doi；手动→source=manual 回读 |
| Zotero 常用插件对标 | Better BibTeX（citation key、5 种引文格式复制/导出）、阅读清单（未读/在读/已读+进度）、标签 hash 配色、重复文献视图 + 合并（可撤销）、批注 Markdown/JSON 导出、⌘⇧C 快速引文对话框、⌘K 命令面板、`?` 快捷键帮助 | v03 套件 CITATION/EXPORT/DUP/LIST/READING 全 PASS；真实 GUI 截图 03/04/05 |
| 拖论文到指定对话 | 库行/详情图表可拖；落点：侧栏会话行（按 `data-row-key` 识别 → 切到该对话并插入 token）、新建会话、composer；按 sessionId 隔离 pending，挂载后自动插入草稿，**不自动发送**，toast 可撤销 | 真实 GUI：drop 会话行 → 自动打开该对话，composer 得到 `⟦Pappers-Hall 1 篇论文 · bundle=bn-…⟧` |
| UI 继续美化 | 动效（stagger/骨架/弹簧/拖拽放置脉冲/撤销 toast）、深浅色 token、四档响应式、空态/错误/离线统一、0 console error | 截图与 harness |

v0.3 新增验收脚本：`node test/v03.mjs`（38 项，真实 Host）；最终结果 **38/38 PASS**（报告 `reports/v03-api-results.json`，复跑 4 轮记录在 `reports/v03-evidence.json`）。v0.2 套件 26/26、lifecycle 12 pass/0 fail/1 not_run 均不回退；`host/selftest.mjs` PASS 256 checks。

## 6.7 v0.4 迭代（2026-11-11 凌晨，针对第三轮用户反馈）

第三轮反馈：1) **接入免费、效果不错的论文翻译工具**；2) **右侧 Pappers-Hall 侧边栏重设计**——“纯靠搜索和翻阅的太蠢了”，要好找文章和批注。

| 反馈 | v0.4 实现 | 验证 |
| --- | --- | --- |
| 免费论文翻译 | Host 新增免费引擎链：**Google 翻译（非官方免费 gtx）**、**MyMemory（免费额度）**、**LLM 精译**兜底，可选 LibreTranslate；`provider:'auto'` 按 google→mymemory→llm 降级；`translate.providers/settings/text/title/blocks/detect`、`mt_cache`（30 天，键含 provider/模式/语言/文本哈希）、`mt_events`；engine 元数据如实标注 `free/unofficial` + disclaimer | 真实引擎实测：Google 829ms/665ms/1168ms、MyMemory 1628–1984ms、LLM fast 2872–3089ms；同文本缓存 0–1ms；`translate.blocks` A01 p3 7/7 段 Google、冷跑 1704ms；降级链（强制 google 失败→mymemory 成功；全失败→unavailable+failures）；v04 套件 34/34 |
| 阅读器接入 | 选区“快速翻译”默认免费链，结果卡显示 `Google 翻译 · 0.4s` / `MyMemory · 2.4s` / `AI·model · 4.0s` + 缓存标记；“AI 精译”可替换卡片；双语整页 `translate.blocks {provider:'auto'}` 逐段 G/M/AI 小标 + “AI 精译本页”；中文选区先 detect 不请求；设置切换广播即生效 | mock 228/228、真实 Host 67/67；真实整页 8/8 段（引擎页标 + 进度/缓存）；真实选区 auto 命中 MyMemory / Google（Google 间歇限流时正确降级并如实标注） |
| 侧边栏重设计 | 不再“搜索框+平铺列表”：头部 Pappers-Hall + 引擎状态 + 设置齿轮 + 刷新；⌘F 跨 tab 搜索；四 tab（论文/批注/图片/笔记）带真实计数；快捷 chips（未读/在读/有批注/收藏夹/标签）；论文 tab 分组 sticky（继续阅读/未读推荐/有批注/收藏夹，缩略图+中文题名+原题+作者年来源+状态点+批注数+被引+标签+hover 操作+拖到对话）；批注 tab 颜色/类型筛选 + 按论文折叠 + quote/页码/评论/时间 + 打开定位/引用/复制；图片 tab 默认 2 列最近图表墙（缩略图+图注+页码）+ 搜索/按论文筛选；笔记 tab 统一样式；底部已选操作 + 统计 + 引擎状态 | 真实 GUI：图片 badge=346、缩略图 12 张 0 占位、图墙 6 张真实图；批注 21 条分组/筛选；设置 sheet 引擎测试成功（`成功 · MyMemory · 1752ms · 缓存命中 · 我们提出了一种结合推理和行动的通用范式。`）；30s 自动刷新 |
| 翻译引擎设置 | 新 `surfaces/settings/` sheet：自动/Google/MyMemory/AI 精译/LibreTranslate 五选一、Fallback 开关、学术短句测试（引擎+延迟+译文+缓存）、免责声明（非官方接口可能不稳定、仅发送待译文本、不保证术语）；设置持久化到 Host settings 并与阅读器共享 | `translate.providers/settings` 实测；测试按钮真实请求；v04 套件 SETTINGS 4/4 |

v0.4 验收：`node test/v04.mjs` **34/34 PASS**（`reports/v04-api-results.json`）；v0.3 套件 38/38、v0.2 26/26、lifecycle 12 pass/0 fail/1 not_run 均不回退；`host/selftest.mjs` **PASS 291 checks**。

## 6.8 v0.5 迭代（2026-11-11 凌晨，第四轮用户反馈）

第四轮反馈：1) **把向量检索正式做起来**；2) 文献组织改成 Zotero 式——**只保留一个“收藏夹”**，系统支持创建**多个嵌套文件夹**放不同文献；**侧边栏和搜索都支持用文件夹+标签筛选**。

| 反馈 | v0.5 实现 | 验证 |
| --- | --- | --- |
| 真实向量检索 | 本机 CPU 嵌入组件（可一键安装）：`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` **384 维多语言模型**；Host `host/embedding.js` 管理 Python worker（懒启动/超时/重启/dispose），新 `embeddings` 表，索引 30 篇库 **3526 chunks**（paper 30 / pages 3129 / figures 346 / annotations 21）；后台 `embedding.index` job（~32–42s、幂等、自动 mount 重建）；`search.query` 真 `vector` 通道 + RRF 与 FTS/LIKE/AI 融合，`reasons:['vector_similarity']`，scope papers/pages/figures/annotations；`embedding.status`、`diagnostics.capabilities.vector` 动态 ready | 4 条中文语义查询真实 Top5：遥感→SatMAE/BLIP-2/SatlasPretrain；agent→Tree Search/ReAct/Reflexion；作物气候→作物模型组；vector latency 18–55ms（索引就绪后），冷查询含 worker 加载约 8–11s；纯 FTS 对比 3 条为空、1 条 overlap=1；v05 套件 42/43 pass/0 fail/1 not_run |
| Zotero 式文件夹 | 迁移 `user_version=5`：`papers.favorite`、`collections.parent_id`；历史 custom→folder，5 个领域保留只读 `field`；`library.folders.tree`（嵌套，count=直接+后代**唯一论文数**，directCount 单独）；create/update（改名/改色/移动，禁止移入自身后代）/delete（子夹上移、论文不删、field 只读）/assign（多对多）；左栏“我的文件夹”树、拖论文入夹、FolderPicker、详情文件夹选择；全部可 undo | v05 文件夹 14 例全过（含 3 层嵌套、重复成员 DISTINCT、cycle 拒绝、delete 上移、undo）；真实 GUI 文件夹筛选「共 2 篇」（含子夹后代） |
| 单一收藏夹 | 移除“多收藏夹/自定义收藏夹”概念：`library.setFavorite` 星标 + 左栏单一“收藏夹”智能视图 + 侧栏收藏 chip + 行内星标；不再有新建收藏夹入口 | 收藏 1 篇实测：library.get.favorite/list favorite/discover stats.favorite 一致，可 undo；截图后测试收藏已取消，交付 0 收藏 |
| 文件夹+标签筛选 | `library.list` 支持 `favorite/folderId(含后代)/tags(AND)/collectionId 等价`；`search.query filters:{folderId,tags,favorite,field}` 全通道过滤；左栏搜索筛选 chips（收藏/文件夹▾/阅读状态/标签）、侧栏 chips（收藏/文件夹▾树/标签）与组合筛选 | v05 搜索筛选 3/3；folder+tags+favorite 三条件组合命中唯一 C01；所有结果满足过滤、channels 不伪造 |
| 语义搜索 UI | 主面板搜索同时调用 `search.query`（FTS+向量，ai:off 快速路径），结果按语义排序合并入表；顶部通道 chips 显示 全文/标签/AI 扩写/**向量**（模型名+延迟，不可用提示 `scripts/setup-embedding.sh`）；⌘K 加“语义搜索…” | 真实 GUI 查询“遥感影像预训练模型”→ SatMAE/BLIP/BLIP-2/SatlasPretrain/GEO-Bench… 向量排序；chips 显示 384d 模型 |

v0.5 验收：`test/v05.mjs` **42/43 pass, 0 fail, 1 not_run**（worker 可用无法模拟不可用）；`host/selftest.mjs` **PASS 332 checks**；回归 v04 34/34、v02 26/26、lifecycle 13(12/0/1)、v03 按 v0.4 路由变更口径通过；数据 30 篇/21 批注/346 图、测试文件夹/收藏已清理。

### 向量检索安装与隐私（可选组件）
- 一键安装：`bash scripts/setup-embedding.sh`（或 `npm run setup:embedding`）→ 在 `~/.dsh/pappers-hall/embedding/venv` 创建独立 Python venv（torch 2.2.2 + sentence-transformers 2.7.0 + numpy<2）并预下载模型到 `~/.dsh/pappers-hall/models`；约占 1.2GB。
- **本机 CPU 推理，文本不上传**；未安装时 `vector` 通道诚实显示 unavailable + 提示脚本，FTS/关键词/翻译照常可用。
- 首次索引约 32–42s（后台 job，不阻塞 UI）；换模型会通过 indexVersion 自动重建；向量存 SQLite BLOB（本库约 5.4MB）。

## 6.9 v0.6 迭代（2026-11-11 上午，第五轮用户反馈：DSH 深度集成 + 自动文献管理）

第五轮反馈：1) **不要“领域”分类**，领域直接并进普通文件夹；2) 让 **DSH 直接做文献管理**——上传论文自动归类到合适文件夹、没有合适文件夹自动新建；用户上传 PDF 先问“是否加入论文中心”，同意后导入+归类；3) **聊天框“+”菜单**里加入论文中心插件选项，可把论文中心 @ 进对话，Agent 自动调用插件找相关文献、读文献、做科研任务。

| 反馈 | v0.6 实现 | 验证 |
| --- | --- | --- |
| 去掉领域层 | 迁移 `user_version=6`：5 个只读 field collection → 普通 `folder`（可改名/改色/移动/删除/嵌套），并为论文写入显式文件夹成员；`folders.tree` fieldCount=0；UI 删除“领域”分组与只读逻辑 | 真实库 5 个文件夹各 6 篇、count 与 library.list 逐夹一致；verifier 迁移 4 例全过；GUI 截图 01 |
| 上传自动归类 | `library.import` 成功后自动调用分类器：folder 画像=成员 paper embeddings 均值（空夹用夹名），余弦阈值 **0.32**，无合适夹时 create（LLM 2–8 字中文主题名，确定性回退且过滤 Subject:/Title 占位）；`library.classify {paperIds, apply}` API；导入结果内联 `classification`（applied/unavailable/error，不阻塞导入）；显式 collectionId 时跳过自动归类 | v06：C02 import→accepted=1、classification→作物模拟与农业系统 confidence **0.7763**、论文 30→31 后清理；classify 建议 ReAct 0.8649 / C01 0.6659 / CLIP 0.7352；apply/undo 真实通过 |
| PDF 先问后导 | 新 Agent 工具 `papers_import_file {path, confirm}`：`confirm!==true` **只预览**（读文件头/首页/标题/DOI/页数）返回 `needs_confirmation + title + question`，**绝不写库**；confirm=true 走现有 ingest + 自动归类；重复/无效明确 status；路径支持 workspace 相对/绝对。系统提示新增管理规则：**必须先预览并询问用户**，同意后才导入并报告归类 | 工具隔离 harness 8/8：预览 30→30 零写入；confirm 导入 30→31 + classification + 自动归类；无效 path invalid；真实对话 GUI：Agent 自主调用预览并询问“要加入论文中心吗？”（截图 04/05） |
| “+”菜单/@论文中心 | 注册 `inputTriggers`：① slash source（`/papers`，4 条中文模板）；② `@` source（最近论文 + 文件夹，chip 序列化 `@论文中心(paper:ph-xxx)` / `(folder:cl-xxx)`，openReference 打开阅读器/文件夹）；③ **`commandUi` 4 个 “+” 菜单动作**（找相关文献/整理文件夹/导入 PDF/查看概览），点击向 composer 插入中文指令模板（真实 GUI：+ 菜单出现 4 项，点击后输入框出现模板，截图 02/03） | + 菜单/模板插入真实 GUI 验证；@ 候选在真实菜单显示论文/文件夹（folder section 实测 5 个文件夹）；build/harness 通过 |
| Agent 使用插件 | 新工具 5 个（共 15）：`papers_overview`（库统计/文件夹/标签/最近）、`papers_folders`（tree/create/rename/delete/assign/unassign）、`papers_classify`、`papers_import_file`、`papers_related`（语义近邻排除自身）；系统提示 section `plugin:pappers-hall-management` 指导找文献/整理/引用/导入确认；`diagnostics.agent={tools:[15],promptSection:true}` | verifier 工具 harness 8/8：folders 全 action、related Top5 排除自身、overview 结构、preview 不写库、confirm 导入；GUI Agent 自主调用 `papers_import_file` 并询问；`diagnostics.agent` 实测 15 tools+promptSection=true |

v0.6 验收：`test/v06.mjs` **31/32 pass、0 fail、1 not_run**（embedding 可用无法模拟不可用）；`test/v06-tools.mjs` **8/8**；`host/selftest.mjs` **PASS 357 checks**；回归 v0.5 42/43、v0.4 34/34、v0.2 26/26、lifecycle 12/0/1、v03 口径不变。

## 6.10 v0.7 迭代（2026-11-11 下午，用户截图反馈：状态栏含义 + 侧栏文件夹不筛选）

反馈：1) 底部状态栏“降级：vector, ocr, translation”不知道什么意思；2) 对话右侧论文侧栏选择文件夹/标签/收藏后不能筛选论文。

| 反馈 | 根因 & 修复 | 验证 |
| --- | --- | --- |
| “降级：vector, ocr, translation” | **根因**：`status.degraded` 是插件挂载时的静态数组，与真实能力脱节——向量索引明明 ready 却仍报 “No embedding model is installed”，免费翻译链可用却报 translation 不可用；UI 直接把英文 channel id 拼成一句 | `collectDegraded` 改为每次动态计算：vector 仅在组件缺失/未配置/索引未建时出现；translation 在 DSH translator 或免费引擎链（google/mymemory/llm，configured/available）可用时不出现；OCR 仅在无 OCR 引擎时以 `severity:'optional'` + 中文原因出现；`diagnostics.capabilities.translation='ready'` + `translationProviders`。UI 映射中文标签（向量检索/OCR/翻译/全文索引）+ title 解释，vector ready 不再显示降级 | live：`status.degraded` 仅 `[OCR(optional)]`，channels `{fts:ready,vector:ready}`，capabilities `vector/translation=ready`、providers `['google','mymemory']`；v07 套件 24/24 |
| 侧栏选文件夹不筛选 | **根因**：drawer 论文 feed 的 useEffect 依赖数组缺少 `filters.folderId/favorite/tags`，`hasFilters` 也没算它们，选择文件夹/标签/收藏后根本不会重新请求；批注/图片/笔记 tab 也未应用这些筛选 | 补齐依赖与 `library.list` 参数（folderId 含后代 / favorite / tags AND），与 quick/reading/annotated/query 组合；批注 tab 传 `annotations.feed {folderId,tags}`；图片/笔记 tab 先取允许 paperIds 客户端过滤（Host figures.search 不支持该过滤）；空态/清除补全 | 真实 GUI：选「遥感与地球观测」→ 列表仅该夹 6 篇；文件夹+收藏→空态；标签「推理」→ ReAct 1 篇；批注 tab 同夹 4 条（全库 21）；截图 `reports/screenshots-v07/02..05` |
| 状态栏可解释性 | 文案从英文 id 改为「未启用/降级：OCR」+ 悬停说明：“这些是可选能力，不影响论文阅读、检索、批注与翻译；OCR 未安装时扫描版 PDF 不提取文字；向量未就绪可运行 scripts/setup-embedding.sh” | 真实 GUI 截图 01；title 属性实测包含 OCR 原因与总说明 |

v0.7 验收：`test/v07.mjs` **24/24 pass, 0 fail, 0 not_run**；回归 v0.6 31/32 + 工具 harness 8/8、v0.5 42/43、v0.4 34/34、v0.2 26/26、lifecycle 12/0/1、v03 口径不变；数据 30 篇 / 21 批注 / 346 图 / 5 文件夹不变。

### 状态栏含义（现在）
- **OCR（可选，未安装）**：扫描版 PDF 不会额外做文字识别；文本型 PDF 的阅读、检索、批注、翻译不受影响。
- **向量检索**：本机 384d 语义模型已就绪（ready 时不显示降级）；若未安装会提示运行 `scripts/setup-embedding.sh`。
- **翻译**：Google/MyMemory 免费引擎链已配置（ready 时不显示降级）；单次翻译仍可能因网络/限流失败，失败会如实提示并可降级 LLM。

## 6.11 v0.8 迭代（2026-11-11 下午，用户截图反馈：仍有警告 + 文件夹选择框回弹 + 索引要自动更新）

反馈：1) 底部仍显示“未启用/降级：OCR”警告，且希望“有增删文献/批注/笔记就自动更新向量索引”；2) 侧栏选完文件夹后选择框变成“全部文件夹”、没法更换。

| 反馈 | 根因 & 修复 | 验证 |
| --- | --- | --- |
| 仍有警告 | v0.7 的动态 degraded 只把 OCR 标为 `severity:'optional'`，但 UI 仍把它渲染成橙色警告 | 状态栏只渲染**非 optional** 的能力缺失；OCR 等可选能力不再显示警告（仍保留在 `status.degraded` 供诊断/报告，不打扰用户） | GUI：底部不再出现警告（截图 01）；API `degraded=[{ocr, optional}]` |
| 向量索引要自动更新 | v0.5–v0.7 的索引只在 mount/手动 `embedding.index` 时重建，导入/批注/笔记变化后不更新 | `host/embedding.js` 新增**增量同步**：`syncSoon()` 防抖(0.9–1.5s) + 后台对账，只对**新增/文本变化**的 chunk 重新 embedding、删除失效 chunk；`embedding.status.sync` 返回 `pending/syncing/lastSyncedAt/last{changed,removed,latencyMs}`；`library.import` 完成后跟随 6s/18s 补同步（等页面/图处理完）；`library.update/delete/restore/purge/merge`、annotations/notes create/update/delete、operations.undo 均触发；同步期间 vector 通道保持 ready，不降级 | live 实测：新建批注 → `annotations 21→22, chunks 3526→3527, changed=1`；删除 → `21/3526, removed=1`；导入真实 PDF → `papers 30→31, pages 3129→3236, figures 346→359` 自动更新；删除+purge 测试论文/文件夹后自动回到 `30/3129/346/21, chunks 3526` |
| 文件夹选择框回弹/无法更换 | 筛选用 `discover.feed` 聚合数据被 `library.list` 结果整体替换，导致文件夹/标签选项列表与统计被清空 → 选择框回到“全部文件夹”且没有其他选项 | 抽屉始终并行拉取全局 `discover.feed` 作为「计数/文件夹/标签/最近图」来源；筛选时只用 `library.list` 替换论文 sections，保留全局 folders/tags/stats；FolderPicker 选项稳定，选中值不再回弹 | GUI：选「大语言模型与 Agent」后选择框显示该夹名，再切「遥感与地球观测」正常切换并更新列表（截图 02/03）；tab 计数稳定 |

v0.8 验证：`host/selftest.mjs` **PASS 357 checks**；live 定向抽查（状态/degraded、embedding sync、文件夹筛选组合、数据基线）通过；v0.7 API 套件 **24/24**（本轮改动前基线，本轮未重跑全量 v08 套件，已如实标注）；GUI 截图 `reports/screenshots-v08/01..03`。

## 6.12 v0.9 迭代（2026-11-11 下午，用户截图反馈：选区“跳着文字选”）

反馈：阅读器里拖动选择文段后，高亮/选中的词是跳着的碎片（如只选中部分行内单词），不符合“从起点到终点按文段顺序全选”的直觉。

| 根因 | 修复 | 验证 |
| --- | --- | --- |
| v0.3 几何选区用**拖拽矩形与单词 bbox 相交**来挑词；斜向拖动时矩形只覆盖部分行内区间，行尾/行首未覆盖的单词被跳过 → 高亮碎片、选词数偏少 | 改为**正常文本选择语义**：pointer-down 命中的词作为 anchor、pointer-up 命中的词作为 focus，选中 words 数组中两者之间**全部连续单词**（阅读顺序），再按行合并高亮 rect；仅当起止点落在页边距（找不到附近词）时才回退矩形算法；双栏内拖动仍只选本栏连续文本 | 真实 GUI：段首“The”斜拖到句中“environments.” → **33 词完整连续**（The potential ... interactive environments.），无跳词；双栏 PDF 左栏 abstract 拖动 → 顺序正确、不串右栏；截图 `reports/screenshots-v09/` |

实现：`shared.jsx` 新增 `wordIndexAt()`（点附近单词命中，容忍页边距），`page-canvas.jsx#selectionForPoints` 优先按 anchor/focus 索引区间构建选择；原有列隔离/旋转过滤/按行合并保留作为边界回退。

## 6.13 v0.10 迭代（2026-11-11 下午，用户截图反馈：已读/删除报错 + 新建文件夹输入框不消失）

| 反馈 | 根因 | 修复与验证 |
| --- | --- | --- |
| 点击“已读”提示 `操作失败：undo is not defined` | `core/library-state.js` 多处 `undo.push(...)` 注册撤销记录，但该文件**没有 import `undo`** → 运行时 ReferenceError（API 已成功，UI 报错） | 补 `import { undo } from './undo.js'`；GUI：点击行内“已读” → 正常提示「已更新阅读状态」，无报错（截图 01）；再点一次可切回未读 |
| 点击“删除”弹出 `HTTP 400`（两次） | 客户端文件夹写操作调用了 **Host 不存在的 `library.folders.create/update/delete/assign`**（Host 只有 `library.folders.tree`，写操作是 `library.collections.*`）→ 400 | 客户端改为调用 `library.collections.create/update/delete/assign`（参数 parentId/collectionId 对应）；GUI 实测：新建文件夹 →「已创建文件夹」；hover 文件夹行 → 删除两次 →「已删除文件夹（子夹已上移）」，全程 0 个 400（截图 03） |
| 误点“新建文件夹”后点击别处，输入框不消失 | 内联创建输入框只处理 Enter/Escape，没有 blur/外部点击处理 | 新建（根级/子级）与重命名输入框都加 `onBlur` + 文档级 `pointerdown` 外部点击关闭；GUI：展开输入框后点击页面空白 → 输入框自动消失（截图 02） |

验证：真实 GUI 读切换/文件夹新建/文件夹删除/外部点击关闭均通过、网络 0 个 ≥400 响应；`host/selftest.mjs` 357 checks 保持通过；数据 30 篇 / 21 批注 / 346 图 / 5 个文件夹（测试文件夹已删除，ReAct 阅读状态恢复原值）。

## 6.14 v0.11 迭代（2026-11-11 下午，用户反馈：模型下载渠道 + 设置入口 + 功能进设置）

用户反馈：OCR 等需要下载模型的能力要开放下载/安装渠道（包括索引、embedding 等），让用户在平台设置里选择安装并开启；此前没有设置按钮，各种功能也没进入设置。

### 6.14.1 设置中心（三处入口，统一面板）

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 论文中心顶栏齿轮 | 论文中心右上角（「设置」aria-label） | 打开插件级设置面板 |
| 会话右侧论文抽屉齿轮 | Pappers-Hall 抽屉标题栏 | 同一面板（论文中心未挂载也有效） |
| 阅读器顶栏齿轮 | 阅读器工具条 | 同一面板 |

面板为居中 962×722 弹窗（min(960px,92vw)×min(720px,88vh)），Esc/遮罩/「完成」关闭，内部滚动，无重叠；采用全局宿主单例，多入口只渲染一个面板。

### 6.14.2 功能都进了设置

- **能力与模型**：
  * 向量检索卡：状态/模型（MiniLM 384d）/大小（987.1MB）/已索引 3526 片段、`vectorSearch` 开关、「修复 / 重新安装」调 `models.install {kind:'embedding'}`（真实下载 venv+模型，进度/错误/取消/1.5s 轮询）、「重建索引」调 `models.rebuildIndex`。
  * OCR 卡（可选）：installed/available/enabled、引擎 `rapidocr-onnxruntime`、扫描页/已索引页；「下载并安装 OCR 组件」调 `models.install {kind:'ocr'}`（建独立 venv + pip 安装，真实进度/取消/失败原因）、「开启 OCR」开关、「建立扫描版索引」调 `ocr.index`（渲染无文字层页面→本地 OCR→写库→可搜索/阅读）。
- **翻译引擎**：Google / MyMemory / LLM 三个开关 + 回退开关 + 「测试翻译」（真实调用，显示引擎/耗时/译文/失败原因）；至少保留一个引擎，全关会被拒绝。状态按两维度显示（已开启 / 已开启·暂不可用 / 已关闭）。
- **索引与数据**：全文/向量通道、OCR 状态、翻译能力、`autoIndex` 开关、上次同步、重建索引；向量关闭时搜索不走向量通道但索引仍可维护。
- **关于与诊断**：插件版本、数据库 schema（7）、数据目录、论文/批注/图表计数、能力表，不含任何 API 密钥。
- 所有模型仅在用户点击安装时下载；未安装时基础文献管理/阅读/批注/翻译不受影响。

### 6.14.3 实现与验证

- Host 新增 `settings.get/update`（持久化、非法键忽略、operationId 幂等）、`models.install/cancel/rebuildIndex`、`ocr.index`、`translation.test`；schema v7（`paper_pages.ocr_text`）；OCR worker `host/ocr_worker.py`（stdio JSON-lines，RapidOCR）；翻译链、搜索链、增量索引均接入开关。
- 修复 verifier 发现的接线问题：`translation.fallbackEnabled=false` 此前未接入翻译链（仍会回退）；现已接入并实测——回退关 + 指定引擎已关闭时明确报错，不再偷偷换引擎。
- 验收：`test/v11.mjs` **33/34 pass、0 fail、1 not_run**（not_run 是按约不触发真实 embedding 重装）；回归 v07 24/24、v06 31/32+harness 8/8、v05 42/43、v04 34/34、v02 26/26、lifecycle 12/0/1 全绿；`host/selftest.mjs` **384 checks PASS**；真实 GUI 三入口/四区/安装进度/取消/测试翻译/Esc 全部通过。
- 数据：30 篇 / 21 批注 / 346 图 / 5 个文件夹不变；OCR 安装测试为真实启动后取消并清理（临时 venv 与任务记录已清），OCR 仍为未安装（由用户主动选择安装后开启）。

## 6.15 v0.12 迭代（2026-11-11 下午，用户反馈：“现在这个引用的UI丑爆了”）

用户截图：输入框上方是浅绿色全宽横条（“只改草稿，不自动发送 / 论文 3 项材料 / 已加入 / ×”），输入框里是灰色方块 `⟦Pappers-Hall 3 篇论文 · bundle=bn-…⟧`。

### 6.15.1 Dock 重设计

- 去掉独立“只改草稿，不自动发送”整行；提示缩为卡片内小字/tooltip。
- 每条引用变成**紧凑卡片**：半透明毛玻璃白底 + 1px 细边 + 圆角 12 + 轻阴影 + hover 上浮；左软色圆底图标；主标题「Pappers-Hall · N 项材料」、次行材料构成「3 篇论文」；右侧「加入草稿」主按钮 → 绿色淡底「已加入草稿」+ 撤销/×；移除按钮默认低透明、hover 显现；展开 chevron。
- 展开清单：类型图标 + 标题省略 + 类型/页码，行高约 34、hover 淡底、行尾移除；max-height 200 内部滚动；底部「仅加入草稿，不自动发送」小字 +「清空全部」。
- 多条卡片 8px 间距、最多显示 3 条 +「还有 N 条」；无 pending 不占空间；动效 respect `prefers-reduced-motion`；仅用 `--dsw-alias-*` token，类名前缀 `ph-`。
- 去重提示：引用路径不再同时 `push`+`notify` 两条长句；只保留一条简短「已加入草稿」（2.6s，带撤销）；自动插入成功不再额外弹通用 toast（由卡片徽标反馈）。

### 6.15.2 输入框引用 token 美化

- 协议文本不变：`⟦Pappers-Hall N 篇论文 · bundle=bn-…⟧`（Agent/tools 依赖 `bundle=bn-`），仅做视觉装饰。
- 新增 `core/cite-token.js`：MutationObserver 给 composer 内含 `bundle=bn-` 的**最内层文本持有元素**（真实 Lexical 是 `<span data-lexical-text>`）加 `ph-citetoken` class + tooltip；Lexical 重渲染自动重标 + 1.5s 兜底；只改 class/属性，不改文本、不影响光标/撤销。
- CSS pill：柔和主色淡底 + 1px 主色淡边 + 圆角 8 + `inline-flex` + 内边距 1–2px 8px + 12.5px + data-URI 书本 icon；覆盖原先灰底/等宽观感。
- 混合文本安全：只有元素文本**恰好是一个完整 token** 时才加 pill；用户在同一 span 后继续输入文字时自动移除 pill，避免整段文字被包成引用块。

### 6.15.3 验收

- 真实 GUI：引用 3 篇论文 → dock 紧凑卡片（收起/展开/清单/清空全部）、加入草稿 → 输入框 token 为 pill；在 token 后输入“请分析这段文字” → pill 自动移除、`<p>` 无 class、token 文本不变；引用 toast 仅一条短句；0 uncaught error；测试草稿与 pending 已清理。
- `node client/build.mjs` PASS（client.js 915,117 B）；v0.12 harness 21 项全 PASS（卡片/展开/清空/加入、token computed style、Lexical 重渲染重标、混合文本去标、提示不重复、0 uncaught error）。
- 数据 30 篇 / 21 批注 / 346 图 / 5 夹不变；版本 0.12.0。

## 6.16 v0.13 迭代（2026-11-11 下午，用户反馈：快速翻译慢/质量一般/不生效 + AI 面板 Markdown 原样显示）

用户截图：快速翻译卡显示“AI·deepseek-v4.1-flash · 11.3 s”、译文质量一般；AI 面板把 `## 一、…`、`**…**`、列表等 Markdown 原样显示；“对话界面能否沿用 DSH 的对话界面支持”。

### 6.16.1 快速翻译：真正快，绝不偷偷走慢 LLM

- 根因：旧「快速翻译」在免费引擎失败时会静默回退到 LLM（11.3s），用户只看到慢卡与一般译文。
- Host 新增 `translate.text {quick:true}`（=freeOnly:true）：**只走免费引擎 Google→MyMemory**，整体 deadline ≤6s；返回 `mode:'free'`、`freeOnly`、`suggestAi`、真实 `engine/latencyMs`。
- 免费引擎全部失败 → `status:'unavailable'`、`suggestAi:true`、可读 reason（“免费引擎暂不可用（限流/网络…），可改用 AI 精译”），**不调用 LLM**；quick 下显式请求 `provider:'llm'` 会被拒绝，绝不静默换引擎。
- 客户端「快速翻译」只调 quick 路径；卡片失败时头部显示「免费快速 · 2.2 s」（不再误显示 Google 引擎），正文给原因 +「重试 / 用 AI 精译」；成功卡也提供「AI 精译」入口。译文完整显示、不截断。
- 本机今日 Google/MyMemory 均 HTTP 429，实测 quick 失败路径 **2.2–2.35s** 返回（远低于 6s，且无 LLM 调用）；缓存成功路径 engine=google/cached/latency=0 正常。

### 6.16.2 AI 精译：质量与延迟

- Host `ai.translateText` prompt 升级 **translate-text-v2**：学术论文选段规则——逐句完整、不省略/不总结/不解释/不加料；术语准确；保留 ΔY、CA、GGCMs、CO2、R²、[12]、(Smith et al., 2020) 等符号/缩写/引用编号；数字单位不变；支持可选 `context:{paperTitle,section,page}`。
- fast 模式真实最低 reasoning effort（如实回 `fast/reasoningEffort`）、deadline≤9s、maxTokens 按长度估算（≥900）保证完整不截断。
- 实测：`ai.quickTranslate` fast=true、reasoningEffort=low、**7.3–7.8s**、promptVersion v2、译文完整保留 ΔY/CA/GGCMs；deep 模式 effort=max、7.7s。旧“11.3s 快速路径”不再出现。
- 客户端「AI 精译」卡显示真实引擎/延迟（缓存命中显示「AI 精译 · 缓存」，不再显示误导的 1ms），完整可复制/替换/发送；批注 popover 也可再「AI 精译」。

### 6.16.3 AI 面板 Markdown / 对话观感

- 新增零依赖 `reader/markdown.jsx`（纯 React 节点、无 `dangerouslySetInnerHTML`、原始 HTML 转义）：标题1–6、粗体/斜体、行内代码、代码块、无序/有序列表、引用块、分隔线、安全链接、简单表格、段落换行。
- AI 回答区改为 Markdown 排版：标题层级、要点列表、引用左边线、代码块/表格横向滚动、最大阅读宽度；assistant 角色行 + 模型/耗时（缓存命中显示「缓存 · 命中」）、来源 chips、复制/引用保留；用户提问保持右侧气泡；快速/深度模式切换不变。
- 实测：回答中 `##`、`**` 不再原样显示，渲染为 h2/strong/ul/blockquote；长答案可读性明显改善。

### 6.16.4 验收与数据

- 真实 GUI：快速卡 2.2s/免费快速/429 原因/AI CTA；AI 精译卡 6.2s（缓存）完整译文；AI 面板 Markdown 回答（无原始标记、缓存元信息）截图见 `reports/screenshots-v13/01..03`。
- verifier `test/v13.mjs`：**27/27 pass，0 fail，0 not_run**；回归 v11 33/34、v12 harness 21/21、v07 24/24、v06 31/32+harness、v05 42/43、v04 34/34、v02 26/26、lifecycle 12/0/1 全绿；host selftest **389 checks PASS**。
- 数据清理：GUI 测试中「替换选中」误创建的 2 条测试高亮已删除 → 30 篇 / **21 批注** / 346 图 / 5 夹；embedding 自动回到 21/chunks 3526。

## 6.17 v0.14 迭代（2026-11-11 下午，用户要求：快速翻译接入国内稳定实现）

用户：“快速翻译功能，你找找国内的稳定的这个实现方法，肯定有的，包括很多开源的都做过。”

### 6.17.1 选型：腾讯交互翻译（Transmart）

排查了常见免费/国内方案（Google 非官方、MyMemory、有道非官方、腾讯旧接口、阿里/火山需鉴权等），最终接入 **腾讯交互翻译（`https://transmart.qq.com/api/imt`）**：
- 国内网络直连、**无需注册/API Key**，HTTP JSON 简单；
- 是 **Bob 插件、Pot、沉浸式翻译类开源项目**长期使用的公开方案（non-official，但国内稳定性明显好于 Google/MyMemory）；
- 实测本机 **0.26–0.83 秒**返回学术段落译文，无需代理。

### 6.17.2 实现

- Host `ENGINES` 新增 `tencent`，默认链路顺序 `腾讯 → Google → MyMemory → LLM`；快速/免费模式（quick）默认 `腾讯 → Google → MyMemory`（≤6s，不调用 LLM）。
- 设置中的翻译引擎列表新增「腾讯交互翻译（免费）」开关，可单独启用/停用/测试；旧 Google/MyMemory 保留作为海外/备用。
- 客户端快速卡显示「腾讯交互翻译（免费） · 418 ms / 免费快速」+ 完整译文；成功后也有「AI 精译」入口；失败仍给原因 +「用 AI 精译」。
- 质量说明：免费引擎对学术术语/歧义仍不如 AI 精译（例如 rainfed 被译为“灌溉”），需要高质量时点「AI 精译」（v0.13 的学术 prompt/符号保留仍在）。

### 6.17.3 验证

- live：quick 腾讯 0.26–0.83s 成功（示例译文完整）；关闭腾讯后回退 Google/MyMemory（本机 429）→ 诚实 unavailable + suggestAi；恢复后可用；快速+provider=llm 仍被拒绝。
- `host/selftest.mjs` **389 checks PASS**（引擎目录/链路/quick 断言已同步加入 tencent，真实性断言未放宽）。
- GUI：快速卡腾讯成功（418ms/完整译文）、AI 精译卡、AI 面板 Markdown 保持；截图 `reports/screenshots-v14/01..03`。
- 数据 30 篇 / 21 批注 / 346 图 / 5 夹不变；无 schema 变更；版本 0.14.0。

## 6.18 v0.15 迭代（2026-11-11 晚，图表定位修正 + 全功能 QA 与 Bug 修复）

用户反馈：详情右栏「图表」每行的搜索按钮没有意义——这是当前论文自己的图表，点它应直接跳到文中位置；“所有功能全部测试一遍，Bug 全部修干净再交付”。

### 6.18.1 图表列表修正

- 详情「图表」每行**移除** search/找相似图按钮（全局「图片搜索」tab 保留其找相似功能，两处不再混用）。
- 整行（缩略图+标题+题注）可点击，click/Enter/Space = 在阅读器中打开该论文并跳到图表所在页；行尾仅保留「在文中定位」按钮；拖拽引用仍可用（drag guard 避免拖后误跳）。
- 阅读器按 `figures.list` 的 bbox 渲染临时高亮框（虚线主色边+「图表 Table 1」标签），约 4.6s 视觉淡出并**从 DOM 移除**；切换页面立即清除。

### 6.18.2 全功能测试（真实 GUI + API 全表面）

- **API 全表面**：`test/v15.mjs` 运行时枚举 **82 个 method 全部覆盖**（读/写/错误面/文件路由/82 method probes + 39 条链路 + 回归/数据 = 142 例）；结果 **139 pass、0 fail、3 not_run**（not_run 为安全原因：真实 metrics 网络写、真实 merge、真实模型安装/重建），methodCoverage 82/82；数据基线前后一致。
- **GUI 全功能扫测**：独立 QA 覆盖 **133 个验收项**（10 大区域：左栏/中栏/行交互/详情/阅读器/抽屉/dock/菜单/设置/响应式），结论 111 pass、10 open P2/P3、7 blocked（模型下载/metrics 写/彻底删除等只验可见性）、9 partial；数据基线完全恢复（30/21/346/5、trash 0、收藏 0、已读 12），临时夹具已清理。报告：`reports/v15-gui-qa.md`（198 张截图证据）。

### 6.18.3 QA 发现并修复的 Bug（v0.15）

| 级别 | Bug | 修复 |
| --- | --- | --- |
| P1 | 批量条「阅读状态」必失败（HTTP 400） | 客户端由 `library.update {ids,patch}` 改为逐篇 `library.update {id, patch:{read,readingProgress}}`；三状态实测 0 个 400、状态正确 |
| P1 | 图表高亮不消失（DOM 残留） | 导航事件计时器 + FigureHighlightOverlay 组件内本地 4.6s 过期（从 DOM 移除）+ CSS fade-out；实测 1.8s 存在、>4.6s 为 0 |
| P1 | 从抽屉打开设置，关闭后主面板被切到论文中心/抽屉关闭 | SettingsHost 外层加 bubble-phase stopPropagation（panel 自身先处理 backdrop/完成）；三入口实测关闭后仍在原界面 |
| P2 | 批量「移入回收站」无确认 | 二次点击确认（首次变「确认移入回收站」，4.5s 复位），首次不删除 |
| P2 | 800×700 左栏不可见且无法展开 | ≤980px 工具栏「展开左栏/收起左栏」+ 覆盖层+遮罩点击关闭；800/1100 实测可用、无横向溢出 |
| P2 | 详情「未分类」不能移出文件夹 | 改为按 `detail.collections` 中的自定义文件夹逐个 `library.collections.assign add:false`；picker 显示当前文件夹、清空后成员解除、无 400 |
| P2 | PDF 提示条“知道了”无效 | dismiss 记录首个 PDF 文件名而非整段草稿；同名保持隐藏、新 PDF 再提示 |
| P2 | 帮助宣称 ⌘⇧Z 重做但 Host 无 redo | 移除重做快捷键/文案，不再调用不存在的 `operations.redo`；保留 ⌘Z 撤销 |
| P2 | 左栏筛选框只过滤标签不过滤文件夹 | 筛选词传入 FolderTree，保留匹配文件夹及祖先并展开；无匹配空态、清空恢复 |
| P3 | 批量收藏只能收藏不能取消 | 按钮按选中项 favorite 状态切换「收藏/取消收藏」 |
| P3 | 翻译引擎链显示“腾讯→腾讯”/阅读器提示缺腾讯 | 修正 auto 链标签与英文文案，去重并显示腾讯 |
| P3 | 无关键词时语义近邻结果无标识 | 已限制语义近邻灌水（搜索 agent 由 30 条降为 7 条相关）；标注留待后续 |

### 6.18.4 验收与数据

- 版本 **0.15.0**；`host/selftest.mjs` **389 checks PASS**；v15 API 套件 **139/142 pass、0 fail**；QA GUI 复验最终构建：console/API 错误为 0（修复前批量阅读 400 已消除）。
- 数据最终恢复 **30 篇 / 21 活跃批注 / 346 图 / 5 文件夹（各 6 篇）/ trash 0 / 收藏 0**；QA/测试夹具与临时夹全部清理。
- 截图：`reports/screenshots-v15/01..04`（图表定位/高亮/相关搜索/窄屏左栏）。

## 6.19 v0.16：分类去封装，Agent 用基础工具像人类一样整理（2026-11-11）

用户反馈：所有处理应模仿人类；给 Agent 的应是基础工具，而不是封装过全的高层工具，尤其是分类任务；向量相似度只能作为参考。

- **移除会直接改库的 `papers_classify`**；新增只读参考 `papers_folder_hints`（返回相似度、margin、stable，明确 `referenceOnly`）。
- **新增基础工具**：`papers_list`（元数据+摘要列表）、`papers_abstracts`（单篇/批量快速读摘要，必要时自动校正摘要抽取）、`papers_get`（单篇完整信息+图表清单）、`papers_update`（基础元数据编辑）；配合既有 `papers_folders`（建夹/改名/移动）、`papers_get_passage`（读页）、`papers_get_figure`、`papers_annotate`，Agent 可完成从读到归类的全流程。工具数 15 → 19。
- **导入不再自动归类**：`library.import` / `papers_import_file` 默认 `classification.status="skipped"`；论文入库后由 Agent 阅读并决定文件夹（旧行为可显式 `autoClassify:true` 启用）。
- **系统提示更新**：明确“像人类图书管理员一样整理”——先读（标题/摘要/关键页）→ 归纳领域/方法/问题 → 设计 2–6 个可解释主题夹 → 用 `papers_folders` 落地；`papers_folder_hints`/`papers_related` 只是参考，不得单独决定；批量移动/删除先确认。
- **分类器修正**：LOO 打分（不再自己给自己算分）、移除自动 field 反馈、输出 `margin/stable`；`papers_import_file` 直接导入时也触发增量索引。
- 详见 `docs/CLASSIFICATION-PLAYBOOK.md`、`docs/CONTRACT-v16.md`；验收 `host/selftest.mjs` **394 checks PASS**。

## 6.20 v0.16.2 AI 精译：中档思考，不再静默降级到腾讯（2026-11-11）

- 阅读器「AI 精译」现在走 `translate.text {provider:'llm', fast:false}`，请求模型 **medium** 思考档；`translate.blocks` 的「AI 精译本页」同样 medium。
- `complete()` 支持 `reasoningEffort`：模型有 medium 用 medium；没有 medium 或没有思考选项时使用 DSH 默认档，**不伪造档位**；返回 `reasoningEffort`（实际）与 `reasoningEffortRequested`（请求）。
- **显式选择不静默降级**：`provider:'llm'` 不再自动拼腾讯/免费引擎兜底；LLM 未就绪时返回明确原因，而不是“选了 AI 精译却给腾讯”。显式 `tencent` 仍可正常使用。
- 当前模型 `opencode-go/deepseek-v4.1-flash` 只有 low/high/max，无 medium，因此实测 requested=medium、actual=max；换到支持 medium 的模型即使用 medium。
- 设置页在 LLM 关闭时提示「阅读器选择 AI 精译时仍会使用」；`host/selftest.mjs` **394 checks PASS**，版本 **0.16.2**。

## 6.21 v0.17：论文 + 笔记科研工作台（2026-11-12）

- **内容完整性**：乱码文本层（字体缺 ToUnicode）检测 + 按需 OCR 回退；`ai.ask`/`papers_get_passage`/翻译不再读乱码；选区/批注 quote 支持按 rects 区域 OCR 修复（ReAct p2 实测）。
- **笔记后端**：schema v8（只新增表）；`notes.*` 21 个 API；`note_docs`（content_md 永不因美化被覆盖、content_json 独立）、`note_folders`、`note_paper_links`、`note_revisions`（50 版快照）、`note_fts` + `note_embeddings` 双索引（索引含 content_json 语义纯文本）；撤销/回收站/purge/export；legacy `nt-` 笔记兼容。`selftest 419 checks`、`test/notes.mjs 104 checks`。
- **笔记前端**：阅读器右栏「双语」移除 → 目录/批注/笔记/AI；笔记与论文绑定、800ms debounce 自动保存 + 本地草稿兜底 + conflict 处理；AI 共同美化（同意弹窗 + 更素/更生动/更科学范 + 排版偏好 + 范围；只写 contentJson；节级 hash 保护未完成章节；恢复原文/历史版本）；独立笔记库（文件夹、搜索、0..N 论文关联、右侧论文面板边看边写）；区域/便签改右下角常驻浮动工具条 + 首启提示。
- **论文↔笔记双向**：论文找笔记（notes.list {paperId}）、笔记找论文（notes.get.paperLinks）；双索引独立。
- **Agent 工具**：新增 6 个原子笔记工具 `notes_list/get/create/update/search/link_papers`；工具总数 25。
- **无关联笔记的 AI 美化**：新增通用 `ai.complete`（不依赖论文上下文），独立笔记也能与 AI 共同美化；有论文关联时仍走 `ai.ask` 论文 grounding。
- 修复 `notes.create` 未调度向量索引；新笔记约 3 秒内自动进入 note_embeddings。
- 版本 **0.17.1**；真实库 6 篇 / 2 批注 / 77 图 / 2 论文夹不变；笔记数据为空（测试夹具已清理）。

## 6.22 v0.18：边写边美化 + 多样化表达 + 笔记树进论文库（2026-11-12）

- **自动美化开关**：笔记编辑器工具条可开启/停用；保存成功后按阈值（≥300 字或空闲 8s/≥60 字）只对「已完成且未美化/内容已变」的节做增量美化，未完成节不动，下次带上未美化部分；单并发、不阻塞写作、失败不覆盖 contentMd。
- **AI 方向浮层**：每次自动触发先由 AI 提出 3 个微调方向（direction+layout+是否配图+理由），非阻塞浮层展示，推荐项 10s 后采用、可忽略；首启一次说明；AI 不可用时内置三方向并标注。手动美化保留。
- **多样化表达**：NoteCards 改为连续文档（plain/accent/columns/figure 交替），减少每节重卡片；contentJson v2，block 支持 heading/paragraph/bullets/table/quote/callout/figure/columns；AI 少而精使用表格/两栏/配图。
- **论文配图**：从关联论文真实 `figures.list` 候选中选图，客户端强校验 figureId、图注/页码/图片 URL 全部来自候选；渲染真实裁剪图 + 真图注，可跳阅读器；无候选绝不编造。
- **笔记树进论文库侧栏**：论文库左侧新增「笔记」树（全部/文件夹/笔记列表），支持新建笔记、笔记文件夹新建/重命名/删除；点击笔记在论文库中栏内联编辑（左侧论文树与笔记树保持可见），不再用单独「笔记库」按钮。
- 版本 **0.18.0**；`host/selftest.mjs` 420 checks、`test/notes.mjs` 104 checks；笔记前端 harness-v2 67 PASS、回归 95 PASS、live AI 14 PASS。

## 6.23 v0.18.1：论文库侧栏精简（2026-11-12）

- 左栏移除：顶部「筛选收藏夹或标签」搜索框、刷新按钮、继续阅读/最近批注/最近阅读/未读/在读/已读/重复文献/图片搜索/收藏夹（0）等入口；保留 全部论文 / 最近添加 / 有批注 / 回收站。
- 图片搜索移到论文中心顶栏（图片图标）；论文搜索使用中栏工具栏的搜索框，不再在侧栏重复。
- 标签区仅在有标签时显示；笔记树保留（全部笔记 / 笔记文件夹 / 笔记列表 + 新建/管理）。
- 修复笔记树空态显示原始 key `notes.empty` 的问题；侧栏标题改为「笔记」。
- 版本 **0.18.1**；build PASS；数据基线不变。

## 6.24 v0.18.2：搜索回到顶栏 + 修复回收站橙色错位（2026-11-12）

- 论文搜索统一放到论文中心**顶栏**（始终可见，带加载态），中栏工具栏不再重复搜索框。
- 「图片搜索」改为顶栏**带文字按钮**「图片搜索」，不再是无标签图标。
- 移除顶栏语义索引状态药丸（全文/标签/AI 扩写/向量）；索引状态保留在状态栏/设置中，不再挤占搜索区域。
- 修复回收站提示条被当成 `.ph-center__body` 的第四列（显示在最右侧橙色框）的问题：提示条改为顶栏下方的整行横幅。
- 版本 **0.18.2**；build PASS；数据基线不变。

## 6.25 v0.18.3：自动美化改为纯字数触发 + 保真校验（2026-11-12）

- 自动美化不再等“停顿 8 秒”：保存成功后完全按**新增/修改字数**触发，累计约 **500–1000 字**才排版一次；不足 500 字不触发、不等待。
- 排版优先：提示词改为“恢复/强化排版结构为主，多样化表达为辅”，禁止为多样而拆句/卡片化；style/columns/figure 只在内容自然适合时使用。
- **信息零丢失校验**：美化结果若漏掉原文数字/单位/±、≈、≤、≥、%/引用编号，或正文被压缩超过一半，该节直接判为不可用并回退原文，不写入 contentJson。
- 新增 `test/notes-fidelity.mjs`（4 checks）：完整重排通过、漏数字拒绝、严重缩水拒绝。
- 版本 **0.18.3**；build PASS；selftest 420、notes test 104 PASS；数据基线不变。

### v0.15 仍存在的限制（如实）
- QA blocked 7 项：真实模型下载/重建索引、metrics 真实网络写、真实 merge、彻底删除等，出于数据安全未执行（仅验证可见性/历史证据）。
- partial 9 项：剪贴板读取（浏览器权限）、rail 缩略图/部分长列表表现、@ 论文候选插入等；不阻塞主流程。
- P3 未完全修：无关键词时的语义近邻结果仍可能出现少量“相关但不精确”的条目（已限制数量，未加视觉标识）；@ 触发时宿主 InputTriggerController 偶发一次 console exception（未能复现，疑其它 mention 源/重载竞态）。
- 帮助已不再宣称重做；Host 仍无 redo 能力（撤销可用）。

### v0.14 仍存在的限制（如实）
- 腾讯交互翻译是公开 Web 接口（non-official），可能变更/限流；UI 中如实标记 free+unofficial。
- 免费引擎质量中等：学术术语/长句/歧义不如 AI 精译；需要高质量请用「AI 精译」（7–9s）。
- 本次只加了免费引擎与设置项；v0.13 verifier 套件的“免费引擎全部失败”断言不再代表默认环境（腾讯可用），未重跑该套件，已用 selftest 389 + live 定向 + GUI 说明。
- 未接入需要 API Key 的官方翻译（百度/阿里/火山）——如后续需要更高配额/质量可再加设置项。

### v0.13 仍存在的限制（如实）
- 免费引擎（Google 非官方/MyMemory）受当日配额与网络影响：本机当前 429，故 quick 只能验证失败路径与缓存成功路径；免费译文质量取决于引擎，学术术语不如 AI 精译。
- AI 精译本身仍需 7–9s（LLM 生成），不是秒回；fast 模式 effort=low 但模型延迟波动时可能接近 9s。
- Markdown 渲染支持常见语法（标题/列表/代码/引用/简单表格），不渲染内嵌 HTML、图片/脚注；复杂表格可能横向滚动。
- quick 成功路径不缓存新译文（免费引擎 429 时）；恢复网络后首次会重新请求，之后走缓存。
- 本次为翻译/渲染补丁，未改 schema（仍 v7）；数据基线 30/21/346/5 夹。

### v0.12 仍存在的限制（如实）
- 协议 token 文本本身仍带 `⟦…⟧` 与 `bundle=bn-…`（Agent 解析需要），只做了视觉 pill；无法只隐藏括号字符而不改文本。
- pill 只在 token 独占其文本元素时显示；用户紧接 token 输入文字后自动恢复普通文本（避免整段被包）。
- 卡片「撤销」= 从 pending 列表移除该条，已插入输入框的 token 文本需手动删除（无宿主 unmark API）；「清空全部」仅清 pending。
- 本次为 UI 补丁：未重跑完整 API 套件（不涉及 host/API 变更），已用真实 GUI + v0.12 harness + 数据基线说明。

### v0.11 仍存在的限制（如实）
- 真实 embedding 重装未在验收中执行（会覆盖现网 1.03GB venv，且耗时）；安装代码/进度/取消路径真实，用户可自行点「修复 / 重新安装」。
- OCR 组件真实下载在验收中是“启动安装→取消”验证（约 100MB 级 pip 依赖），未完成整包安装；安装后 OCR 索引扫描版 PDF 的能力依赖该组件真实安装成功。
- 免费翻译引擎（Google 非官方、MyMemory 免费额度）可用性随网络/限流动态波动；设置中显示“已开启 · 暂不可用”时仍可点测试查看真实结果。
- 模型体积统计为目录遍历（10 分钟缓存）；OCR 未安装时显示“—”。
- 本版未做多模型选择（仅默认本地嵌入模型）；OCR 引擎固定 rapidocr-onnxruntime。

### v0.10 仍存在的限制（如实）
- 本次为交互修复补丁，未重跑完整 v0.10 回归套件；已用 GUI 定向验证 + selftest 357 说明。
- 文件夹删除采用“两次点击确认”（第一次变为确认文案）；子文件夹会按契约上移到父级，论文不随夹删除。

### v0.9 仍存在的限制（如实）
- PDF 断词（`acknowl- edged`、字距导致的 `A GENT B ENCH`）仍按 PDF 文字层原样保留；选区完整性已修复，但断词拼接属于文本抽取层问题（不影响翻译，翻译引擎会做规范化）。
- 跨双栏的斜向拖动会按阅读顺序区间选中两栏之间的文本（与多数 PDF 阅读器一致）；若只想选一栏，请在栏内拖动。
- 旋转侧边 stamp/页眉页脚仍会被过滤；选区以单词为单位，不包含标点间隙像素。

### v0.8 仍存在的限制（如实）
- 增量同步是**近实时防抖**（约 1–2s 后开始；导入等页面/图处理再补 6s/18s），不是同步阻塞；期间 vector 仍可用但新内容可能晚几秒可检索。
- 同步失败不阻塞主流程（例如 worker 未装/离线），`embedding.status.sync.last` 会记录错误；下次变更或重启会重试。
- 状态栏不再显示 OCR 可选警告；如需查看能力详情可看 `diagnostics.capabilities`（OCR 仍为 unavailable）。
- 本次为补丁版，未重跑完整 v08 回归套件；已用 selftest + live 定向检查 + v0.7 历史 24/24 说明。

### v0.7 仍存在的限制（如实）
- 翻译可用性依赖网络；免费引擎瞬断时状态会动态显示翻译降级，恢复后自动消失（不是静态误报）。
- OCR 确实未安装（本版不引入 OCR 引擎）；扫描版 PDF 仍可能没有可选中文字层。
- 图片 tab 的文件夹/标签过滤是客户端按允许 paperIds 过滤（Host figures.search 暂无 folder/tags 参数），超大库时首次会多一次 list 请求。
- 侧栏“有批注”chip 计数在筛选态使用 feed 统计，可能与批注 tab 条数略有差异（不影响列表筛选）。

### v0.6 仍存在的限制（如实）
- “+” 菜单的 4 个动作插入的是**指令模板**（不是直接发送），用户可补充主题；@ 插入 chip 消息内的自定义渲染依赖 DSH 默认处理（未注册 `conversation.user.text.node` 渲染器）。
- 完整 GUI「确认导入 → 自动归类」回合未在时限内跑完：测试用合成 PDF 的 `/Title` 元数据损坏，Agent 做了冗长核查并停在确认前；确认导入与自动归类已由工具隔离 harness（8/8）和 import API 真实验证，GUI 已真实验证“自主预览+先询问”这一段。
- PDF 预览标题仍可能取到 PDF 通用元数据（如 `Subject:`/`Title:`）而非正文标题，建议下轮过滤占位元数据并使用首页标题。
- 自动归类依赖本地 embedding 环境；未安装时 import 不阻塞、`classification` 返回 unavailable+reason；LLM 不可用时新建夹名走确定性回退。
- 批量删除/移动仍按 v0.3 规则先确认；Agent 删除/大量移动前由系统提示要求确认，但 UI 无强制二次确认。
- v0.5 的 field 只读、10 tools 旧契约已按 v0.6 变更（5 普通夹、15 tools）；旧版测试断言需按新契约更新，不是回归。

### v0.5 仍存在的限制（如实）
- 首次语义查询/索引需付模型加载 8–11s；索引完成前向量通道为 degraded；CPU 查询 20–55ms（本机）；换机器需重装组件并重建索引。
- 4 条中文查询中 `agent 推理与行动结合` 规则相关性 3/5（ReAct 排第 4），不是完美排序；语义分数是相对相似度，不是概率。
- 文件夹深度上限 6 层；同名文件夹仅允许不同父级；field 领域目录只读。
- 侧栏批注/图片 tab 的文件夹过滤沿用论文 feed 的过滤范围，未做跨类型文件夹过滤（Host annotations.feed 已支持 folderId/tags，可下轮接）；图片 tab 默认最近 6 图未做全库分页。
- 语义搜索对超长中文查询仍依赖单条 query 向量，未接入 AI 扩写英文再取 max（契约中为“可”，已记录）。
- v0.4 免费翻译限制不变（Google 非官方接口可能 429、MyMemory 额度/长度限制、免费译文仅阅读辅助）。

### v0.4 仍存在的限制（如实）
- **Google 翻译为非官方免费接口**（gtx），可能限流/变更；今日实测出现间歇失败并自动降级 MyMemory——UI 会显示实际使用的引擎，不冒充。
- MyMemory 匿名额度 + 单请求 450 字符（按句分段），长文/多段时质量与稳定性弱于 Google/LLM；可用“AI 精译”作高质量替代（非免费，消耗模型额度）。
- 免费引擎对换行/分段文本的输入规范化与质量校验已补（见 translate normalization），但学术术语/公式/引用编号仍可能误译；译文只作阅读辅助，不能当作权威翻译。
- 图片 tab 默认展示最近 6 张图，未做全库分页浏览；批注 feed 首屏 40 条，“加载更多”未接（Host 支持 before 分页）。
- LibreTranslate 仅展示“未配置”，自定义 URL/密钥输入尚未开放（需 Host config 入口）。
- 阅读器“替换选中”仍为页内译文浮层，不改 PDF；LLM 整页偶发部分段失败，显示原因+逐段重试，不伪造。
- 侧栏 tab 切换滚动位置已记录/恢复；深色主题抽检主要界面，未覆盖全部长尾。

### v0.3 仍存在的限制（不冒充完成）
- “快速翻译”依赖模型/provider 延迟（实测 2.4–7.8s，非稳定 ≤3s）；模型偶发空响应时 UI 如实显示原因并可重试，不编造译文。
- JCR 影响因子无免费来源：默认“未获取”，可手动填写；OpenAlex 的 2 年均被引/期刊 h-index 与 JCR IF 字段严格区分。
- 重复文献按 sha256/归一标题启发式识别；合并保留主条目，不自动选择“最佳”条目。
- 拖动到**子代理会话行**、跨窗口拖拽未支持；真实进程重启仍记 not_run（会终止会话）。
- 英文/中文引文样式依赖内置格式器，未接 CSL 引擎；GB/T 7714 为实用子集。
- 深色主题新组件已用真实 client.js + 深色 token harness 目检，但未覆盖全部 30 篇长尾页面。
- vector/OCR 通道仍 unavailable（与 v0.2 相同，如实展示）。

### v0.2 仍存在的限制（不冒充完成）
- “语义检索”是 **LLM 关键词扩展 + 可选重排**，不是 embedding 向量检索；本机仍未安装嵌入模型，`vector` 通道如实保持 unavailable。
- 跨页文字选择不支持；页内查找仅当前页；阅读位置暂存 localStorage（宿主无通用 settings API）。
- 部分 PDF 无 “Abstract” 标题时摘要用启发式（abstractSource=`pdf-heuristic`）；4 篇论文题注图抽取仍 partial。
- 中文批注自然语句检索仍受分词/无向量限制（比 v0.1 有 AI 通道但批注检索未启用 AI 扩写）。
- DSH 工具卡在真实聊天里的展示需 Agent 实际调用工具后出现，已用自定义 view 实现，截图见报告。
- 进程重启持久化仍按 profile patch 证据记为 not_run（未真实重启进程）。

## 7 已验证 / 未完成（诚实清单）

### 7.1 验证结果摘要（2026-11-10，实测）

| 项 | 结果 |
| --- | --- |
| 安装（`plugin_manager install_bundle`，link 本地包） | **applied**，无需重启；插件详情标题/描述/图标正常 |
| 30 篇测试 PDF 下载与版本核对 | **30/30 SHA-256 一致、30/30 页数一致**（合计 604 页），`verify_bundle.py --skip-visual-fixtures` PASS；见 `reports/papers.md` |
| 导入 30 篇 | **accepted=30 / duplicates=0 / errors=0**，5 领域各 6 篇；334 个图表裁切；26 篇 ready + 4 篇 partial（图注启发式定位，界面显示“部分完成”） |
| 论文中心/阅读器/图搜/抽屉 UI | 真实 GUI 截图（`reports/screenshots/` 01–05）；页面图、图裁切图、缩略图均由 Host 实时渲染 |
| Agent 工具 | 8/8 注册；`papers_get_figure` **真实 ImageBlock 进入当前模型**，模型从像素读出图内独有文字（见 `reports/tool-evidence.md`） |
| 抽屉→草稿 | 真实浏览器实测：抽屉多选 1 篇 → “引用所选” → Host 生成 bundle → 输入框上方材料组 → “加入草稿” → 草稿出现 `⟦Pappers-Hall 1 篇论文 · bundle=bn-…⟧`（只改草稿、不发送；截图 08/09） |
| 删除/恢复 | 删除后检索与工具读取立即拦截（HTTP 路由 404、`reader.open` 返回 not_found、`papers_get_passage/get_figure` 返回 unavailable）；恢复 epoch 严格递增；迟到写入不复活 |
| 开关 | 停用 **application: applied**；停用后侧栏入口/顶栏按钮/8 工具/HTTP 路由全部消失，boot graph 不再含插件模块；原生侧栏、对话、输入框、模型选择正常（截图 06/07）；启用后 library id 集合与数据一致 |
| 进程重启持久化 | **not_run**：重启会终止当前验证会话；证据为 profile patch 写入的 `- id: pappers-hall` + `disabled: true`（重启时按 patch 生效） |
| 自动验收 | **184 项：pass 99 / fail 60 / not_run 25**。import 45 项 44 pass（1 项书目导入为 opt-in not_run）；lifecycle 13 项 10 pass（2 项失败同属语义图搜缺口，1 项工具级证据见 `reports/tool-evidence.md`）；toggle 7 项 5 pass / 2 not_run（真实重启、浏览器人工项）；search 93 项 22 pass，失败全部归因于无 embedding/视觉语义通道与中文分词缺口，报告按原因分类，未篡改期望 |
| 检索质量（真实计算） | 60 题 Top5 命中 14（23.3%）、Top1 命中 7（11.7%）；30 条图检索按（论文+页+图号）命中 7。以上是**当前关键词通道的真实成绩**，不是 v0.2 目标值 |
| 机器重启/崩溃恢复、万篇规模、Windows/Linux | **not_run**（不在本机本版验证范围） |

详见 `reports/verify.md`（逐 case pass/fail/not_run）、`reports/test-results.json`、`reports/import-result.json`、`reports/tool-evidence.md`、`reports/screenshots/`。

### 7.2 已知限制（未完成，不得当成已通过）

- 跨既有会话行拖放：宿主无行级 drop 协议，未实现（本版只支持当前会话草稿）；
- 结构化引用 chip / `papers://` scheme：宿主未公开 ReferenceCodec 注册，未实现；改用材料令牌 + bundle；
- OCR、语义向量检索、图文对齐嵌入：本机未安装权重/运行时，界面显式降级；
- 机器翻译：本 profile 未启用 translator 服务，`papers_translate` 返回 unavailable；
- GROBID 结构化解析：未部署（poppler 文字层 + 图注启发式定位）；
- 页面文字层质量：部分 PDF 的图内矢量文字缺 ToUnicode，pdftotext 提取为乱码（如 ReAct p2 图内文字），页面图与图注仍可用；整页正文不受影响；
- 4 篇论文题注启发式未识别出图（partial），界面与报告如实标注；
- 性能：30 篇 3 分钟内完成导入；1 万/10 万篇未测；
- 跨平台：只在 macOS arm64 实测；Windows/Linux 未验证。

未完成/未验证（不得当成已通过）：
- 跨既有会话行拖放（等待宿主行级 drop 协议；本版只做当前会话草稿）；
- 结构化引用 chip / 自定义 `papers://` scheme（等宿主公开 ReferenceCodec 注册）；
- OCR、语义向量检索与图文对齐嵌入（本机未安装权重/运行环境，界面显式降级）；
- 机器翻译（本 profile 未启用 translator；有服务时自动使用）；
- GROBID 结构化解析、万篇级性能与并发压力（仅 30 篇功能回归）；
- Windows/Linux 实机验证（只在 macOS arm64 实测）。

## 8 开发与测试

```bash
# 语法/自测
node --check index.js
node host/selftest.mjs          # Host 领域自测（临时数据目录）

# 验收（需要插件已安装、GUI 在运行）
node test/run-tests.mjs --only import,search,annotations,lifecycle,toggle
node test/visual.mjs            # 真实看图（记录模型/executor 与图像证据）
```

目录结构：

```
pappers-hall-plugin/
├─ index.js            # Host 入口（Loader 只需这一个文件）
├─ cordis.patch.yml    # bundle patch：一行 insert
├─ host/               # Host 领域：storage/ingest/search/jobs/tools/api
├─ client.js           # Web Client 半包（单文件 lazy-CJS）
├─ locale/             # 插件管理页显示元数据（zh/en）
├─ icon.svg            # 插件图标
├─ docs/               # 契约、兼容性、依赖、安装细则
└─ test/               # 验收脚本
```
