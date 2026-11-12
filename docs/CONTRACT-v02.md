# Pappers-Hall v0.2 契约（2026-11-10 迭代）

v0.1 已交付并验收（见 `reports/verify.md`）。本轮针对用户反馈做 v0.2：**阅读器重做（真实 PDF 版面 + 直接标注 + 干净的双语对照）、Zotero 式文献管理界面（收藏夹/标签/详细信息）、AI 语义检索与按需翻译、加深与 DSH/Agent 的联动、动效与视觉打磨**。

本文件只写 v0.2 增量。v0.1 的 API 在不冲突处保持兼容。

## 0 分工与写作用域

| 成员 | 写作用域 |
| --- | --- |
| lead | 根 index.js、package.json、cordis.patch.yml、docs/、README、client/build.mjs、client/src/index.jsx、scripts/ |
| host-engineer | host/** |
| client-engineer | client/src/core/**、client/src/i18n/**、client/src/surfaces/{panel-icon,center,drawer,dock,header-button,figure-search}.jsx、client/src/surfaces/library/**、client/src/core/styles.css |
| reader-engineer | client/src/surfaces/reader/**（含 shell/toolbar/page-canvas/text-layer/annotation-layer/thumbnails/bilingual/ai-panel） |
| verifier | pappers-hall-plugin/test/**、reports/**（只写 test-results/verify/import-result/tool-evidence 相关） |

构建：`node client/build.mjs` → 根 `client.js`（lazy-CJS，esbuild）。**只有 lead 在最终集成时构建/重载插件**；工程师可在本地构建做语法检查，但不要用 `plugin_manager` 安装/启停插件。

## 1 Host API 增量（POST /pappers-hall/api）

### 1.1 阅读器结构（真实 PDF 版面，修复“对照没法看”）

`pdftotext -bbox-layout` 生成 flow/block/line/word 坐标；`pdftohtml -xml` 可补字号。坐标统一为**PDF 页面坐标（points，原点左上）**，客户端按 `renderedWidth/pageWidth` 缩放。

- `reader.page {id, page}` → `{page,width,height,imageUrl,widthPx,heightPx,text,blocks:[Block],annotationCount}`
  `Block = {id, role:'body'|'heading'|'caption'|'table'|'header'|'footer'|'list', bbox:{x,y,w,h},
            text, column:0|1, lines:[{bbox,text}], words?:Word[]}`
  规则：按阅读顺序由 flow/block 生成；两栏页用 x 中心分栏后按 (column,y) 排序；页眉/页脚按位置与字号降权；`words` 默认不返回（体积）。
- `reader.layer {id, page}` → `{page,width,height,words:[{t,x,y,w,h}], lines:[{x,y,w,h}]}`（给文字选择层用，坐标同上）
- `reader.pageText {id, page}` → 兼容 v0.1 纯文本
- `reader.outline {id}` → `{items:[{title,page,level}]}`（有目录用 PDF 大纲/启发式章节标题，没有则空）

### 1.2 标注（直接画在 PDF 上，可被 AI 读取/定位）

- `annotations.create {paperId, versionId?, page, kind:'highlight'|'area'|'note', quote?, rects:[{x,y,w,h}], color:'yellow'|'green'|'blue'|'red'|'purple', comment?, origin:'user_note'|'test_note'|'ai_explanation', operationId?}` → `{annotation}`
- `annotations.update {id, comment?, color?, expectedRevision?}` / `annotations.delete {id}`
- `annotations.list {paperId, state?}` → `Annotation[]`；`Annotation = {id,paperId,versionId,page,kind,rects,quote,comment,color,origin,createdAt,updatedAt,revision,state}`
- 坐标：相对页面 0–1 的归一化矩形（前端换算，避免缩放/分辨率依赖）；每页最多 200 条；同一页文本高亮可多 rect。
- 检索：`search.query scope='annotations'` 命中理由含 `annotation_match`，返回 page/rects。
- 工具：`papers_get_annotations {paper_id, bundle_id?}`（含 page/rects/quote/comment）、`papers_annotate {paper_id,page,kind,rects?,quote?,comment,color}`（Agent 可创建标注，origin='ai_explanation'）。

### 1.3 收藏夹、标签、详细信息

- `library.collections.list` → `{items:[{id,name,color,order,count,kind:'custom'|'field'}]}`；5 个内置领域集合来自 `field` 自动派生（不可删，kind='field'）。
- `library.collections.create {name,color?,operationId}` / `update {id,name?,color?,order?}` / `delete {id}`
- `library.collections.assign {collectionId, paperIds, add:true|false, operationId}` → `{results}`
- `tags.list` → `{items:[{name,count}]}`；`tags.rename {from,to,operationId}`；`tags.delete {name,operationId}`；`library.update {id, patch:{tags?:string[], addTags?:string[], removeTags?:string[]}}`
- `library.list` 新增过滤：`collectionId?`, `tag?`, `read?`, `annotated?`, `sort?:'recent'|'added'|'title'|'year'|'authors'`；返回 `PaperSummary`（同 v0.1）并保证 `tags:[string]`。
- `library.get` 返回 v0.1 全字段 + `abstract`、`abstractSource:'pdf'|'metadata'|null`、`fileInfo:{path,bytes,sha256,pageCount,sourceVersion,license}`、`tags:[string]`、`collections:[{id,name,color,kind}]`、`annotationCount`、`notes:[Note]`、`read`。
- 摘要抽取：从第 1 页 blocks 中定位 `Abstract`/摘要段（启发式），失败留空不伪造；`abstractSource` 标注来源。

### 1.4 AI（LLM 直连 Host，可用时降级）

Host 通过 `ctx.get('agentDefaultModel').currentSelection()` 取 provider/model，`ctx.get('llm').prepareCall/stream` 调用；`purpose:'pappers-hall'`；所有调用带超时（默认 25s）、并发上限 2、缓存（LRU+SQLite 表 `ai_cache`，键=任务+模型+prompt 版本+输入哈希）。**任何 AI 能力不可用时返回 `status:'unavailable'`/`'degraded'` 与原因，禁止编造。**

- `ai.status {}` → `{available, provider, model, limits:{maxInputChars,timeoutMs}, reason?}`
- `translate.title {ids:[paperId]}` → `{results:[{id,titleZh,status:'translated'|'from_metadata'|'unavailable',provenance:{model,promptVersion}}]}`（批量，逐篇缓存；人工译名优先，不覆盖 human 修改）
- `translate.blocks {paperId, page, target:'zh'}` → `{blocks:[{id,text,translation,status}], provenance:{model,promptVersion,sourceHash}, cached:boolean}`（按页段落级；不拆公式/引用编号；失败逐段标 unavailable）
- `translate.text {paperId?, text?, page?, target}` → 兼容 v0.1；有 AI 时 status='translated'
- `ai.ask {paperId?, page?, figureId?, quote?, blocks?:string[], prompt, includeImage?:boolean}` → `{status:'ok'|'unavailable'|'error', answer?, provider?, model?, sources:[{kind:'page'|'figure',page,figureId?,label?}], elapsedMs, reason?}`
  - `includeImage:true` 时把页面/图裁切 PNG 经 `ctx.attachments.saveImage` 作为 ImageBlock 一起发送（真实像素）；模型无图像能力时必须返回 unavailable 并说明。
  - 记录 `ai_events` 表（时间、模型、输入哈希、耗时、状态、来源），不存用户正文之外的内容。
- `search.query` 新增参数 `ai:'auto'|'off'`（默认 auto）：当可用且 query 含中文或关键词命中不足时，执行 **AI 扩写检索**（LLM 输出英文关键词/同义词 JSON）→ 走 FTS/LIKE 合并；对 Top-20 做 **AI 重排**（可选，只对前 20）；返回 `channels` 增加 `{name:'ai_expand'|'ai_rerank', status:'ok'|'degraded'|'off', model, note}`，`reasons` 加 `ai_semantic_expansion`/`ai_rerank`。缓存扩写结果；失败回落关键词通道并标注 degraded。
- 工具：`papers_translate` 走同一 AI 通道（保留 provenance），`papers_search` 新增 `ai?:boolean`。

### 1.5 其他

- `library.setRead {id, read:boolean}` 幂等。
- `library.import` 支持 `collectionId?`、`tags?`。
- `diagnostics` 增加 `ai:{available,provider,model}`、`renderer:{textLayer:true}`、`features:{collections,tags,annotationsV2,aiTranslate,aiSearch}`。
- 迁移：`PRAGMA user_version` → 2；新增 `collections/paper_collections/ai_cache/ai_events`；annotations 表加 `kind/rects_json/comment`（旧行默认 kind='note'、rects=[]）。

## 2 客户端模块图（esbuild 构建）

```
client/src/
  index.jsx                 # lead 已提供：apply/注册（不要改，除非 lead 同意）
  core/
    constants.js  api.js  pending.js  library-state.js  boundary.jsx  styles.js  icons.jsx  primitives.jsx  motion.js(i18n dicts in i18n/)
  i18n/zh.js  i18n/en.js
  surfaces/
    panel-icon.jsx  center.jsx  drawer.jsx  dock.jsx  header-button.jsx  figure-search.jsx
    library/shell.jsx  toolbar.jsx  collections.jsx  item-table.jsx  details.jsx
    reader/shell.jsx  toolbar.jsx  page-canvas.jsx  text-layer.jsx  annotation-layer.jsx
            thumbnails.jsx  bilingual.jsx  ai-panel.jsx  outline.jsx
    integration/turn-tail.jsx
```

- `center.jsx` 由 client-engineer 实现：内部状态 {view:'library'|'reader', paperId, page, source}；与 reader-engineer 的契约：
  `<ReaderShell t api pending onBack={} paper={} initialPage={} onAskInChat={(payload)=>} onToast={(kind,text)=>} />`
- reader-engineer 只写 `surfaces/reader/**`，使用 core/* 的 API；`ReaderShell` 为具名导出。
- 交互要求见下节；所有类名 `ph-` 前缀，颜色只用 `--dsw-alias-*`（允许用 `color-mix()` 生成层级），动效用 CSS transition/keyframes，不引入动画库。

## 3 交互与视觉要求（本轮验收点）

### 3.1 文献库（Zotero 对标）

- 三栏：左（收藏夹/标签/智能视图）· 中（条目表）· 右（详细信息）；可拖拽分隔条调宽（localStorage 仅存 UI 偏好）。
- 左栏：全部论文/最近添加/最近阅读/未读/已读/有批注/回收站；收藏夹（5 领域 + 自定义，可新建/重命名/改色/删除）；标签列表（count，点击筛选，支持多标签 AND）。
- 中栏：搜索框、排序（添加时间/年份/题名）、表头列（☑/标题+原题/作者/年份/来源/标签/已读/批注）、行内已读点、键盘上下 + Enter 打开、Cmd/Ctrl/Shift 多选、右键菜单（打开/引用到对话/加标签/加收藏夹/移入回收站）。
- 右栏：详细信息（题名/原题/译名可编辑/作者/年份/来源/DOI/arXiv/许可/PDF 版本/SHA 前12/页数/文件大小/摘要），标签编辑（回车添加、点 × 删除、自动补全已有标签），收藏夹勾选，已读开关，动作（打开阅读/引用到对话/导出引用/打开 PDF/在 Finder 中显示? 不实现 Finder，仅复制路径）。
- 空态/加载 skeleton/错误重试；批量操作条；拖拽条目到收藏夹；动效：列表 stagger 进入、hover 抬升、详情面板宽度过渡、选中检查动画。

### 3.2 阅读器（重点修复）

- 版式：左侧页缩略图（虚拟化、懒加载）、中间页面画布（连续滚动，虚拟化渲染邻近页）、右侧可切换：目录 / 批注列表 / 双语 / AI。
- 页面用 Host 渲染 PNG，叠加**文字选择层**（words/lines 坐标，透明文本，选中高亮）与**标注层**（归一化 rect，颜色半透明，hover 显示 quote/comment，点击弹 popover：改色/编辑批注/复制/删除/引用到对话/问 AI）。
- 选中文字 → 浮动工具条：高亮（颜色选择）/复制/翻译/解释/问 AI/引用到对话；区域标注模式（拖框）同样支持。
- **双语对照重做**：按 block 段落渲染卡片（原文段 + 译文段），列宽固定、行距舒适，不再用整页文本流；逐段“翻译”按钮 + 整页“翻译本页”；译文 unavailable 时显示原因，不伪造。
- 缩放（75%–200%，快捷键 ⌘+/⌘-）、适配宽度、页码跳转、`⌘F` 页内搜索（高亮命中）、阅读位置记忆（按 paper+page 存 Host settings）。
- 顶部工具条：返回、标题、页码、缩放、原文/对照/仅译文、引用到对话、打开 PDF、AI 面板开关；滚动时毛玻璃收缩动效。
- 页面切换用交叉淡入；批注 popover scale-in；缩略图当前页指示滑动。

### 3.3 与 DSH / Agent 联动

- 阅读器“问 AI”：打开 AI 面板，上下文 chips（当前页/选中文字/当前图），提问 → `ai.ask` 流式或一次性显示答案（带模型与页码来源、可点回原文位置）。
- “发送到对话”：把当前材料（论文/页/选区/图 + 批注）经 `references.commit` 生成 bundle，插入当前会话草稿（沿用 v0.1 pending store + composer dock；不自动发送）。
- 聊天回答来源卡：在 `conversation.chat.turnTail` 注册卡片，识别最近工具结果里的 Pappers-Hall 来源（paper/figure/page），显示“打开原文/第 N 页/图 X”，点击打开论文中心阅读器对应位置。
- 标注同步：阅读器创建的标注在抽屉“批注”tab、库右栏、`papers_get_annotations` 工具中一致可见。

## 4 验收（v0.2）

1. `node host/selftest.mjs` 通过（更新：blocks/layer、annotations v2、collections/tags、AI 降级、翻译缓存）。
2. `node client/build.mjs` 成功且产物可被 DSH 加载；`plugin_manager` 重载后无控制台崩溃。
3. 真实浏览器截图：Zotero 三栏库、条目详情（标签/收藏夹/摘要）、阅读器页面+文字选中+高亮标注、双语段落对照、AI 面板、抽屉/草稿联动。
4. 检索：中文语义查询在 AI 通道可用时 Top5 提升（真实统计，不调期望）；AI 不可用时明确降级。
5. 既有 v0.1 验收不回退（import/lifecycle/toggle 关键项）。
