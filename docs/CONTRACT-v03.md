# Pappers-Hall v0.3 契约（2026-11-10 夜：UI 打磨 + 科研工作流）

v0.2 已交付。用户实测反馈（截图 3 张）要求 v0.3：

1. **大量 UI 重叠/尺寸不匹配**：多选批量条溢出到右栏并与收藏夹文字叠字；窄窗口右栏半透明导致中栏表头“标签/已读/批注”透出、详情标题与 tabs 重叠；标注弹层内容溢出。
2. **选段问题**：拖选文字时看不到选区高亮；选中后无法用 AI **非思考模式快速翻译**；没有**撤销**。
3. 论文信息要更多（**影响因子**等）。
4. 对照 **Zotero 常用插件**做功能（Better BibTeX、阅读清单、标签颜色、重复文献、标注导出、引文插入等）。
5. **把论文直接拖进指定对话**完成引用。
6. 继续深度美化、达到可融入科研生活的产品级。

本节只写 v0.3 增量；v0.2 契约（docs/CONTRACT-v02.md）仍有效。

## 0 分工

| 成员 | 写作用域 |
| --- | --- |
| lead | 根 index.js/package.json/docs/README/client/build.mjs/client/src/index.jsx/scripts/ 与集成 |
| host-engineer | host/** |
| client-engineer | client/src/core/**、i18n/**、surfaces/{center,drawer,dock,header-button,figure-search,panel-icon}.jsx、surfaces/library/**、surfaces/integration/** |
| reader-engineer | client/src/surfaces/reader/** |
| verifier | test/**、reports/test-results.json、reports/verify.md、reports/v03-*.json |

## 1 Host API 增量

### 1.1 期刊指标 / 论文信息（影响因子等）

- `papers.journal` 表（按期刊归一）：`{key, name, issn, publisher, impactFactor, impactFactorYear, fiveYearImpactFactor, quartile, source:'manual'|'openalex'|'crossref'|null, updatedAt}`
- `papers` 增列：`citation_count`, `citation_updated_at`, `keywords_json`, `metrics_json`（见下）。
- `library.get` 新增 `metrics`：`{impactFactor, impactFactorYear, fiveYearImpactFactor, quartile, issn, publisher, citationCount, citedByPercentile?, hIndex?, source, updatedAt, stale:boolean}`；`keywords:[string]`、`citationKey`、`publicationDate/volume/issue/pages`（有则返回）。
- `metrics.refresh {paperIds:[id], allowNetwork?:true}` → 逐篇：DOI → OpenAlex `works/doi:`（cited_by_count、源期刊 id）→ OpenAlex `sources/<id>`（`summary_stats.2yr_mean_citedness`、`h_index`、`i10_index`）→ Crossref（ISSN/publisher/volume/issue/page）。写入 provenance：`source:'openalex+crossref'`；**不得把 2yr mean citedness 冒充 JCR Impact Factor**，UI 文案用“2 年均被引（OpenAlex，非 JCR IF）”并保留 `impactFactor` 字段仅在手动/真实来源时展示。失败逐篇 `{id, status:'failed', reason}`（offline/404/无 DOI）。
- `metrics.update {paperId, fields:{impactFactor?, impactFactorYear?, fiveYearImpactFactor?, quartile?, issn?, publisher?, citationCount?, keywords?}}` → source='manual'。
- 缓存/限速：同一期刊 7 天内不重复拉取；网络失败返回 `{status:'unavailable', reason}` 不伪造。

### 1.2 撤销（undo）

- `operations` 日志表：`{id, kind, summary, target_json, created_at, undone, undone_at}`。
- 记录可逆操作：annotation.create/update/delete、library.setRead、library.update(tags/字段)、collections.assign、library.delete/restore、library.merge。
- `operations.recent {limit?:20}` → `{items:[{id,kind,summary,createdAt,undone}]}`
- `operations.undo {operationId}` → 执行逆操作；`undo` 自身幂等（operationId）；不可逆操作（purge）返回 `{status:'not_undoable', reason}`。
- 客户端 Cmd/Ctrl+Z 优先本地栈（含 operationId），本地无记录时用 `operations.recent` 回退；UI 需 toast“已撤销 + 操作摘要”。

### 1.3 重复文献 / 合并（Zotero Duplicate 插件对标）

- `library.duplicates` → `{groups:[{key, reason:'sha256'|'title', items:[PaperSummary]}]}`。
- `library.merge {primaryId, duplicateIds:[id], operationId}` → 合并 tags/collections/read/annotations（标注 paperId 改到 primary）、保留 primary 文件；其余进回收站（可 undo）。返回 `{primaryId, merged, trashed:[ids]}`。

### 1.4 导出 / 引文（Better BibTeX 对标）

- `citation.format {ids:[id], style:'bibtex'|'apa'|'gbt7714'|'ris'|'csljson'}` → `{style, content, count}`；BibTeX 保留可读 key（`yao2023react`）、`and` 连接作者。
- `citation.key {ids}` → `{keys:[{id, key, source:'authoryear'}]}`
- `export.annotations {paperId, format:'markdown'|'json'}` → `{content, count}`（Markdown 含页码、颜色、quote、comment、时间；供导出到笔记）。
- `export.bibtex` 保留兼容；`library.get` 新增 `citationKey`。

### 1.5 AI 快速模式（非思考）

- `translate.text` / `translate.title` / `translate.blocks` / `ai.ask` 新增可选 `fast:true`：
  - 通过 `llm.prepareCall(config, signal, (controls, model) => ...)` 选择该模型支持的最低 reasoning effort（优先 `none`/`minimal`/`low`；模型无 reasoning 则不动），并降低 maxTokens（翻译 ≤700、问答 ≤800）、deadline ≤12s；
  - 返回 `fast:true` 与 `reasoningEffort`（实际值或 null）；失败照旧带 reason。
- 新增 `ai.quickTranslate {paperId?, text?, page?, target:'zh', fast:true}` = translate.text 的快捷别名（供选中文字一键快速翻译，UI 期望 ≤3s 常见短句）。
- `ai.ask` 增加 `mode:'fast'|'deep'`（默认 deep）；fast 等价 fast:true。

### 1.6 其他

- `library.list` 新增过滤 `reading:'to-read'|'reading'|'read'`（映射 read 字段 + 进度），`sort:'citations'|'impactFactor'`（缺失值排后）。
- `library.update` 支持 `readingProgress`(0–100)、`keywords`、手动指标字段。
- `saved_searches`（可选）：`{id,name,query_json}` CRUD；若时间不够可延后并在报告标注。
- 迁移 user_version=3；以上全部幂等，旧数据不丢。

## 2 客户端修复与功能（验收点）

### 2.1 P0 布局 bug（对应截图）

1. **批量条不越界**：`.ph-batch` 必须相对中栏定位（中栏 `position:relative`），宽度 `max-width: min(720px, calc(100% - 32px))`，任何窗口宽度下不得进入右栏/左栏；窄窗口可换行/滚动；不与 statusbar 重叠。
2. **窄窗口右栏实心**：`<=1280px` 右栏为 overlay 时必须 `background: var(--dsw-alias-bg-base)`（或 layer-2 实色）并加左边框/阴影；中栏表头（标签/已读/批注）不得透出。
3. **详情头部**：标题最多 2 行 clamp（字号 ≤16px），原题 1 行省略；tabs 单独一行、sticky、实色背景；标题不得与 tabs/中栏表头重叠；关闭按钮固定右上。
4. **弹层约束**：标注 popover/右键菜单/颜色板/批量下拉一律 `max-height: calc(100vh - 24px)` + 内部滚动 + 视口翻转/位移；宽度 ≤340px；文本 quote 可折叠。
5. **尺寸系统**：详情/批量条/工具栏统一 12–13px 正文、26/28px 控件高、圆角 8/12；不再出现超大字/超大按钮。
6. 自查尺寸：1586×992、1280×800、1100×720、最小 960×640 四档无重叠、无横向滚动、无文字截断错位。

### 2.2 选段与快速翻译（阅读器）

1. **拖选实时高亮**：按下鼠标开始即用几何命中（word bbox 与拖动矩形相交）显示半透明选区覆盖层，随拖动实时更新；松开后弹出工具条；不得出现跨栏/跨页误选（当前 quote 混入远距离 affiliation 的 bug）。
2. **几何选区**：quote 与 rects 由命中的词重建（同行空格/跨行换行、每行合并 rect）；旋转/竖排词排除；工具条显示“已选 N 词”。
3. **快速翻译**：工具条第一个动作“快速翻译”（⚡ 图标）调用 `ai.quickTranslate`/`translate.text fast:true`，内联结果卡显示译文+模型+耗时（目标常见短句 ≤3s），可“复制/替换选中/发送到对话”；“解释/问 AI”仍走 deep 模式并在 AI 面板打开。
4. **撤销**：创建/改色/编辑/删除标注、发送到对话等操作后 toast 带“撤销”；⌘Z/Ctrl+Z 撤销最近一次（与 Host operations 打通）；重做可选（⌘⇧Z，能实现则做）。
5. **标注 popover 重做**：头部“高亮 · 第 N 页 · 时间”，quote 折叠区，评论编辑（自动保存+取消），颜色行，动作网格（复制引用/快速翻译/解释/问 AI/引用到对话/删除+撤销），适配窄屏。

### 2.3 论文信息（影响因子等）

- 详情右栏分节：基本信息 / 出版信息（期刊、ISSN、出版社、卷期页、日期、DOI/arXiv、许可、PDF 版本、文件信息）/ 计量指标（影响因子或 2 年均被引、分区、被引次数、h-index、来源与更新时间、“刷新指标”）/ 摘要 / 关键词 / 收藏夹 / 标签 / 图表 / 笔记 / 批注。
- 指标来源必须标注（手动 / OpenAlex / Crossref），JCR 影响因子缺失时显示“未获取（可手动填写或一键拉取）”而不是假数据；刷新失败显示原因。
- 手动编辑指标（影响因子、分区、被引）立即保存并在详情回显。
- 批量条新增“更新指标”（对选中论文）。

### 2.4 Zotero 常用插件对标（本版范围）

| 对标插件 | v0.3 实现 |
| --- | --- |
| Better BibTeX | 详情/批量复制 citation key、复制 BibTeX/APA/GB-T/RIS/CSL-JSON，导出 .bib |
| Zotero Reading List | 阅读状态（未读/在读/已读）智能视图 + 进度；行内状态点；批量设置 |
| Zotero Tag | 标签颜色（稳定 hash 调色板，深浅色可读）、标签选择器、按标签过滤 |
| Zotero Duplicate | “重复文献”智能视图 + 合并（主条目保留，合 tags/收藏/标注，其他入回收站，可撤销） |
| Zotero PDF Translate / 翻译插件 | 快速翻译（非思考）+ 双语段落翻译（v0.2 已有，补 fast 模式） |
| Annotation export / Markdown | 批注导出 Markdown/JSON（复制或下载） |
| Zotero Citation / Word 插件 | 快速引文对话框（⌘⇧C）：搜论文→选样式→插入引文 token 到当前会话草稿 |
| Drag & drop 到对话 | 库中论文/图/批注拖到会话输入区或对话区：松开即生成材料 bundle 并插入 token（不自动发送），有拖拽预览与放置高亮 |
| Zutilo/快捷键 | `?` 快捷键帮助、⌘K 命令面板（打开论文/切换视图/搜索/导入/更新指标/复制引文） |

### 2.5 拖拽到指定对话（重点）

- 库行、详情图表、阅读器选区/图支持 HTML5 DnD：`dragstart` 设置 `application/x-pappers-hall-material`（JSON：paper/page/figure/annotation/quote）+ 纯文本 fallback。
- 放置目标：会话页面（composer、conversation 区域）显示“松开以引用到当前对话”高亮遮罩；drop 时经 `references.commit` 生成 bundle → `pending` → 通过 `inputActions.captureInsertion/insertText` 插入 token 到 composer（不自动发送），toast 可撤销。
- 若拖到非对话区域：取消并提示“拖到对话输入框以引用”。
- 拖拽时源元素半透明+缩放；放置区脉冲动效；尊重 reduced-motion。

### 2.6 全局 UI 打磨

- 统一工具栏/批量条/详情/抽屉尺寸与间距；图标 14/16/18 三档；表格行 40px（紧凑 34）；hover/selected/focus 三态一致。
- 骨架屏、空态、错误态、离线/降级态统一；AI 内容标注来源与“AI 生成”。
- 微动效：弹层 spring、列表 stagger（≤10 行）、拖拽放置脉冲、撤销 toast 进度条；全部 CSS，无动画库，无硬编码颜色。
- 深浅色 + 1100px/1280px/1586px 目检；无 console error。

## 3 验收（v0.3）

1. `node test/v03.mjs`（新）：metrics/refresh（可离线降级）、operations/undo、duplicates/merge、citation.format、export.annotations、ai fast、library.list reading/sort。
2. `node test/v02.mjs` 26/26 不回退；`node test/run-tests.mjs --only lifecycle` 13/13；`host/selftest.mjs` PASS。
3. 真实浏览器截图：四档窗口宽度下布局无重叠；标注 popover 适配；选段实时高亮；快速翻译结果；详情指标区（含刷新/手动）；重复文献合并；拖拽到对话前后；撤销 toast；命令面板；深浅色各一组。
4. 所有 AI/网络能力失败路径如实降级（无编造 IF/译文/答案）。
