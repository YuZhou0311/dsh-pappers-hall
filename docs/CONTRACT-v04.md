# Pappers-Hall v0.4 契约（2026-11-11 凌晨：免费翻译引擎 + 侧边栏发现式设计）

v0.3 已交付（v03 38/38、v02 26/26、selftest 256）。用户新反馈两条：

1. **接入免费、效果不错的论文翻译工具**（当前只有 LLM；希望有免费引擎、快且够用）。
2. **右侧 Pappers-Hall 侧边栏重新设计**：现在只是“论文列表 + 搜索框”，纯靠搜索/翻阅找文章和批注“太蠢”；要让人好找好文章和批注（发现式、分组、筛选、预览）。

本节只写 v0.4 增量；v0.3 契约（docs/CONTRACT-v03.md）仍有效。

## 0 分工

| 成员 | 写作用域 |
| --- | --- |
| lead | 根 index.js/package.json/docs/README/client/build.mjs/client/src/index.jsx/scripts/ 与集成 |
| host-engineer | host/**（新增 `host/translate.js` 或并入 ai.js；发现/feed API 在 store/search） |
| client-engineer | client/src/core/**、i18n/**、surfaces/{center,drawer,dock,header-button,figure-search,panel-icon}.jsx、surfaces/library/**、surfaces/integration/**、surfaces/settings/**（新） |
| reader-engineer | client/src/surfaces/reader/** |
| verifier | test/**、reports/v04-*.json、verify.md 只追加 v0.4 章节 |

## 1 Host：免费翻译引擎链

### 1.1 引擎与端点（无密钥、公开可用；已由 Lead 实测）

| provider | 端点 | 实测 | 说明 |
| --- | --- | --- | --- |
| `google` | `POST https://translate.googleapis.com/translate_a/single?client=gtx&sl=<src>&tl=zh-CN&dt=t`（`q` 表单编码，单 q/请求） | 200，短句/400+ 字长段均可用，质量好 | **非官方免费接口**，可能限流/变更；文档需注明 |
| `mymemory` | `GET https://api.mymemory.translated.net/get?q=…&langpair=en|zh-CN` | 200，免费额度（匿名有日限额/单次长度限制） | 作为 fallback；长文分段，单段 ≤450 字符 |
| `llm` | 现有 `ai.js` LLM（fast/deep） | 已可用 | 高质量 fallback/精译 |
| `libretranslate`（可选） | config `libreUrl`/`libreApiKey`（用户自建或公共实例） | 公共实例不稳定/可能 301 | 仅当配置 url 时启用，失败降级 |

- **禁止**把非官方接口包装成“官方服务”；`engine` 元数据如实返回（`google(unofficial-free)` 等）。任何失败返回 `status:'unavailable'` + `reason`，不伪造译文。
- 网络请求：UA 浏览器常见值；超时 6s（llm 保持 12s）；google/mymemory 并发 ≤2；重试 1 次（5xx/网络错误）；HTML 特殊字符用表单/URL 编码；不发送除待译文本外的用户数据。
- 长度：Google 单请求 ≤4500 字符（超出按句分段，保留段落边界）；MyMemory 单请求 ≤450 字符（按句切分，逐段拼接）；LLM 保持 6000 字符限制。

### 1.2 API

- `translate.providers {}` → `{preferred:'auto'|..., fallback:["google","mymemory","llm"]（实际降级链，数组）, fallbackEnabled:boolean, items:[{id,label,free,configured,unofficial?,available,lastLatencyMs,lastError}]}`（可用性检测尽量走缓存/超时短；不做真实 LLM 调用探测）。
- `translate.settings {provider?, fallback?}`（GET 无参 / SET 带参）→ `{provider:'auto'|'google'|'mymemory'|'llm'|'libretranslate', fallback:boolean}`（GET 与 SET 返回同一形状）；持久化 settings 表；默认 `{provider:'auto', fallback:true}`（顺序 google→mymemory→llm）。
- `translate.text {text, target:'zh', source?:'auto'|'en', provider?:'auto'|..., fast?, sessionId?}` → `{status:'translated'|'unavailable', translation, provider, engine:{id,label,free,unofficial?}, latencyMs, cached, reason?, chunks?}`；`provider:'auto'` 按 fallback 链，失败逐个降级；每个 provider 结果写 `mt_cache`（键 provider+源文本哈希），命中返回 `cached:true`。
- `translate.title {ids, provider?}` → 走同一引擎链（标题通常 Google 质量更好），返回 `provider/engine/latencyMs`；人工译名优先。
- `translate.blocks {paperId,page,target,provider?,fast?}` → 每段走引擎链（引擎结果即可，必要时 LLM 精译由 `provider:'llm'` 指定）；返回逐段 `{id,text,translation,status,provider,reason?}` 与 provenance；缓存复用。
- `translate.detect {text}`（可选）：简单语言检测（拉丁/汉字比例）避免中文再翻。
- 诊断：`diagnostics.translation` 增加 `providers` 状态；`ai.status` 保留。
- 失败/限流可观测：`mt_events` 表（时间/provider/字符数/耗时/状态）供统计；不进日志正文。

## 2 Host：发现/feed API（给侧边栏）

- `discover.feed {limit?}` → 一次返回：
  `{stats:{papers,unread,reading,read,annotations,tags,collections}, continueReading:[PaperTile], unread:[PaperTile], annotated:[PaperTile], collections:[{id,name,color,count}], tags:[{name,count,color?}], recentAnnotations:[AnnotationFeedItem], recentFigures:[FigureTile]}`
  - `PaperTile`：`{id,title,titleZh,authors,year,venue,tags,read,readingProgress,annotationCount,figureCount,lastReadAt,addedAt,citationCount,impactFactor,hasPdf}`；
  - `AnnotationFeedItem`：`{id,paperId,paperTitle,page,kind,color,quote,comment,createdAt}`；
  - `FigureTile`：`{id,paperId,paperTitle,page,label,captionThumbUrl,imageUrl}`。
  - 规则：continueReading=最近 `last_read_at` 的 5 篇（有阅读记录）；unread=未读按添加时间倒序 5；annotated=批注数最多 5；sections 内不重复（可重复出现在不同 section 但 UI 需标）。
- `annotations.feed {limit?, paperId?, colors?, kinds?, query?, before?}` → 跨论文批注流（按时间倒序），每条含 paperTitle/page/quote/comment/color/kind/createdAt；支持颜色/类型/论文筛选与分页（before=createdAt）。
- `library.tiles {ids?}`：批量 PaperTile（侧边栏刷新用，可选）。
- `discover.feed` 走索引查询，<100ms（30 篇规模）。

## 3 Client：右侧 Pappers-Hall 侧边栏重设计（用户点名）

目标：**发现式找文章/找批注**，不再是“搜索框 + 平铺列表”。验收在真实 GUI 目检。

### 3.1 结构

```
┌ Pappers-Hall 侧栏 ────────────────────────────── ⚙ ┐
│ [搜索论文/批注/图…]  （⌘F 聚焦）                        │
│ [论文] [批注] [图片] [笔记]   带计数 badge             │
│ 快捷筛选 chips: 全部·未读·在读·有批注·收藏夹▾·标签▾      │
├ 内容区（按 tab 切换，可滚动，分组 sticky 小标题）────────┤
│ 论文 tab：继续阅读 / 未读推荐 / 有批注 / 收藏夹          │
│   行：缩略图(48×64) + 中文题名 + 原题(1行) + 作者·年·来源 │
│       + 状态点(已读/在读) + 批注数 + 标签 chips          │
│       hover 操作：打开阅读器 / 引用到对话 / 展开详情      │
│   分组标题右侧“查看全部 →”切到论文中心对应视图           │
│ 批注 tab：筛选颜色/类型/论文；按论文分组折叠；            │
│   条目：颜色条 + quote(≤2行) + 页码 chip + 评论(1行)     │
│       + 时间；操作 打开定位/引用到对话/复制              │
│ 图片 tab：2 列缩略图 + 图注；筛选论文；点击打开图搜       │
│ 笔记 tab：现有笔记列表（保持）                           │
├ 底部操作条：已选 N → 引用所选 / 打开论文中心 / 清空       │
└ 页脚：引擎状态?? 统计（论文/批注/图）与刷新 ─────────────┘
```
- 标题栏：`Pappers-Hall` + 设置齿轮（打开翻译引擎设置 sheet：引擎选择、测试按钮、fallback 开关、引擎来源/延迟展示、免责声明“非官方免费接口可能不稳定”）。
- 交互：tab 切换保留滚动位置；筛选 chips 可多选组合；搜索跨 tab（论文/批注/图分别高亮），空态给“去论文中心导入/新建收藏夹”；加载 skeleton；行 hover 抬升；列表 stagger（≤10）；键盘 ↑↓/Enter；`Esc` 清搜索。
- 尺寸与 v0.3 设计系统一致（12–13px、控件 26、行高 56–64、缩略图圆角 4、颜色 token、`ph-` 前缀、reduced-motion）。宽度自适应（右栏 320–420）。
- 状态：数据来自 `discover.feed` / `annotations.feed` / `library.list`；失败/离线降级为“插件未运行”卡片；不阻塞原生 DSH。
- 与主面板联动：点击条目 = `navigation.openPaper({paperId,page,annotationId})` + `layout.selectPanel(PANEL_ID)`；引用 = 现有 pending/dock 流程（不自动发送）；“打开论文中心”切主面板库视图。
- 便捷：拖拽行到对话仍然可用（沿用 v0.3 DnD）。

### 3.2 论文“好找”增强（主面板 + 侧栏共用的智能视图）

- 新增/完善智能视图：继续阅读、未读、在读、有批注、最近批注、重复文献（已有）、收藏夹/标签树（已有）；主面板左栏加“继续阅读”与“最近批注”入口；表格行显示缩略图列（可选，宽度紧张时省略）。
- 排序新增“最近阅读/批注数/被引次数”（v0.3 已有 citations）。

## 4 Client：翻译引擎接入（阅读器）

- `translate.providers`/`translate.settings` 读取引擎；详情/阅读器显示当前引擎。
- 选区“快速翻译”默认走**免费引擎链**（auto：google→mymemory→llm），结果卡显示 `Google 翻译 · 0.4s`（或 MyMemory/LLM）；提供“AI 精译”次要按钮（走 llm fast/deep，结果替换当前卡片，注明来源）。
- 双语“翻译本页”：优先免费引擎逐段（快，通常 <3s/页）；可选“AI 精译本页”（逐段 LLM，慢）；每段显示引擎小标（G/M/AI）；失败段显示原因+重试。
- 设置 sheet 中可切换引擎并即时生效（阅读器/侧栏共享 settings）。

## 5 验收（v0.4）

1. `node test/v04.mjs`（新）：translate.providers/settings、google/mymemory 真实或离线降级（记录真实结果）、fallback 链（强制 provider 失败→自动降级）、缓存、engine 元数据不冒充、discover.feed/annotations.feed 结构与筛选、数据一致；回归 v03 38/38、v02 26/26、lifecycle 12/0/1 不回退。
2. 真实浏览器：新侧边栏论文/批注/图片/笔记四 tab、筛选、分组、hover、设置 sheet 引擎测试；快速翻译免费引擎真实结果与延迟；双语整页免费引擎；截图 16+。
3. 所有网络能力失败如实降级；README/docs 注明非官方免费接口风险与数据边界。
