# Pappers-Hall 阅读器（v0.4，`client/src/surfaces/reader/**`）

对标 Zotero / PDF.js 的 PDF 阅读体验：真实版面文字层、**几何命中选段 + 拖动实时高亮**、**免费翻译引擎链（Google → MyMemory → AI）** 快速翻译、直接标注 + 撤销、按段双语对照（逐段引擎标识 + AI 精译）、AI fast/deep 面板与对话联动。
本目录是 reader-engineer 的完整写作用域；`center.jsx` 只通过 `<ReaderShell>` 具名导出接入。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `shell.jsx` | `ReaderShell` 具名导出：状态编排（页面/缩放/侧栏/选区/标注/AI/搜索/阅读位置）、数据缓存、标注 CRUD、引用到对话、快捷键、错误边界、annotation 深链与 `navigation` intent |
| `toolbar.jsx` | 顶部两行工具栏：返回/标题/页码/缩放（75–200% + 适配宽度）/原文·对照·仅译文/区域标注/便签/页内查找/引用/打开 PDF/AI/侧栏开关；滚动收缩由根类 `ph-r-reader--scrolled` 驱动毛玻璃动效 |
| `page-canvas.jsx` | 连续滚动页面画布（选区结果卡显示引擎徽标/延迟、缓存与 AI 精译入口）：固定占位高度 + 视口 ±2 页虚拟化、缩放锚定不漂移、跨页跳转；**几何选区**（mousedown 起点→mousemove 对当前页 word bbox 相交→实时 `ph-r-selrect` 覆盖层→mouseup 重建 quote/rects，含列隔离）、浮动工具条（快速翻译/颜色/复制/解释/问 AI/引用）、区域拖框实时预览、便签落点 ghost 预览、视口翻转 popover、搜索命中、快速翻译结果卡与页内“替换选中”译文卡 |
| `text-layer.jsx` | 用 `reader.layer.words` 叠加透明可选中文字层（坐标 = PDF points ÷ 页面尺寸，按行高换算字号）；选择框经 `Range.getClientRects()` 归一化为 0–1 rects |
| `annotation-layer.jsx` | 标注渲染（高亮/区域/便签 pin）、hover 卡片、**v0.3 popover**（头部 类型·页码·时间、quote ≤4 行折叠/展开、评论自动保存+取消、颜色行、2×3 动作网格：复制引用/快速翻译/解释/问 AI/引用到对话/删除、340px 宽 + `max-height: calc(100vh - 24px)` 内部滚动）、右侧批注列表（颜色/类型筛选）、便签编辑器 |
| `thumbnails.jsx` | 左侧页缩略图：按真实页面比例定位、滚动窗口虚拟化、懒加载、当前页滑动指示条、点击跳转 |
| `bilingual.jsx` | 右栏“双语”tab：按 `reader.page.blocks` 逐段卡片，默认只显示 body/heading/caption（页眉/表格/页脚/期刊元数据/超短碎片自动隐藏，可一键显示）；段落级翻译进度（已翻译 N/M 段 + 失败数 + 进度条）、per-block 状态（等待/翻译中/译文/不可用原因+重试此段）、缓存小标、整页按钮“翻译本页→重新翻译/继续翻译” |
| `engines.js` | v0.4 翻译引擎适配：provider/engine 元数据读取与徽标（`Google 翻译 · 0.4 s` / `MyMemory` / `AI·model`）、引擎短标（G/M/AI/L/缓存）、语言检测兜底、`useTranslationPreference`（读取 center 注入的 translationStore，无则 translate.settings） |
| `ai-panel.jsx` | 右栏“AI”tab：上下文 chips（论文/当前页/选中文字）、**fast/deep 模式切换**（fast→`mode:'fast',fast:true`，答案带“快速”徽标）、`ai.ask`（含“带上页面图片”）、模型/耗时/可点击来源、复制回答、发送到对话草稿、不可用/错误如实展示 |
| `outline.jsx` | 右栏“目录”tab：`reader.outline.items` 缩进列表；Host 未解析页码（`page:null`）的条目显示但不可跳转 |
| `shared.jsx` | 自包含工具箱：API 适配（`api(method,params,{signal})` → data，兼容 `{ok,data}` envelope）、i18n 兜底、几何/标注归一化、`hitTestWords`/`pointRect` 几何命中、`buildWordSelection`（同行空格/跨行换行/每行 1 rect/旋转词排除）、`looksLikePageMetadata`、`useAsync`、`useElementSize`、`prefers-reduced-motion`、图标与小控件 |
| `undo.js` | 撤销适配层：优先使用 center 注入的 core undo context（`push({label,undo,operationId})`/`undoLast`/`redoLast`/`getSnapshot`/`subscribe`，全局 ⌘Z 由 client 安装）；无 external 时回退本地有界栈（含 redo），供独立 jsdom 测试/旧客户端使用 |
| `messages.js` | reader 本地 zh/en 兜底字典（154 个 key）；`t()` 缺 key 时使用，导出的 `READER_KEYS` 便于并入 `i18n/{zh,en}.js` |
| `styles.js` | 全部 `ph-r-*` 样式（只注入一次）；颜色只用 `--dsw-alias-*` token + `color-mix()`，动效纯 CSS，`prefers-reduced-motion` 全量降级 |

## 集成契约

```jsx
import { ReaderShell } from './reader/shell.jsx'

<ReaderShell
  t={t}                       // ctx.locale.bind(NS)；已知 key 优先，缺 key 用本地兜底
  api={api}                   // (method, params, {signal}) => Promise<data>，失败 throw .code/.message
  pending={pending}           // core/pending.js store：add(result, fallbackMaterials)
  paperId="ph-…"
  initialPage={1}
  onBack={() => …}            // 返回论文中心
  onOpenPaper={(id, page) => …}  // 预留：跳转其他论文
  onToast={(kind, text) => …} // 'info'|'success'|'warning'|'error'；不传则本地渲染 toast
  sessionId="…"               // 可选：references.commit 的会话绑定
  paper={summary}             // 可选：先加载的 PaperSummary
  initialTab="annotations"    // 可选：outline|annotations|bilingual|ai
  annotationId="an-…"         // 可选：标注深链，加载后跳到该页并打开 popover
  navigation={navigation}     // 可选：core/navigation.js 单例；同论文跳转 intent 消费
  undo={undo}                 // v0.3：core/undo.js 单例（center 注入）；缺省时 reader 用本地撤销栈
  translation={translationStore} // v0.4：core/translation.js 单例（center 注入）；读取 settings.provider，切换后下次请求生效
/>
```

`navigation` 的契约：`getSnapshot()` 返回 `{route, intent, seq}`，`subscribe(fn)`，`consumeIntent()`。
ReaderShell 在 `route.view==='reader' && route.paperId===当前纸` 且 `seq` 变化时消费 intent，
执行 `goToPage(page)`；`annotationId` 打开对应标注；`kind==='figure'` 时提示“已定位到第 N 页”。

## Host 方法（v0.2，调用点）

- 读：`reader.open`、`reader.page`（blocks）、`reader.layer`（words/lines）、`reader.outline`、`annotations.list`、`ai.status`（AI 面板内）
- 写：`annotations.create/update/delete`（乐观更新 + 失败回滚）、`references.commit`（→ `pending.add`，不自动发送）、`library.setRead`（尽力而为）
- 翻译/AI：`translate.text`（选区快速翻译：`{provider:'auto',fast:true}`，失败降级 `ai.quickTranslate`/无 provider 旧接口；AI 精译 `{provider:'llm',fast:true}`）、`translate.blocks`（整页优先 `{provider:'auto'}`，AI 精译本页 `{provider:'llm'}`）、`translate.providers`/`translate.settings`（引擎偏好读取，缺 context 时降级）、`translate.detect`（中文选区不请求翻译）、`ai.ask`（含 `includeImage`、`mode:'fast'|'deep'`）
- 撤销：标注 create/update/delete 通过注入的 undo context 注册逆操作；发送到对话注册 pending.remove 逆操作；无全局 context 时本地栈 + 自带 ⌘Z/⌘⇧Z

## 结构缺失降级（host v0.1 或惰性生成中）

| 情况 | 表现 |
| --- | --- |
| `reader.page.blocks` 缺失 | 双语面板显示“版面结构生成中/不可用 + 重试”，绝不拼接 `text` 字段 |
| `reader.layer` 缺失/失败 | 页面角落显示“文字层生成中…/文字层不可用”，点击/选区自动禁用，标注与页面图仍可用 |
| `translate.blocks` 不可用 | 面板顶部显示 Host 原样 reason + 重试；逐段显示“本段翻译失败：reason”，不伪造译文 |
| `ai.status/ai.ask` 不可用 | 状态条与回答卡显示真实原因；输入禁用或如实报错 |
| `references.commit` 失败 | toast 报告原因，不静默 |
| API 404/网络失败 | 全屏“插件未运行或已停用”+ 重试 |

## 交互与快捷键

- `⌘/Ctrl+F` 页内查找；`Enter`/`Shift+Enter` 下一处/上一处；`Esc` 依次关闭便签/批注 popover/标注模式/查找/选区
- `⌘/Ctrl+=` / `⌘/Ctrl+-` 缩放；`Alt+←` / `Alt+→` 上/下一页
- 选中文字（几何拖选，拖动过程实时高亮、工具条显示“已选 N 词”）→ 浮动工具条：**快速翻译**（第一个动作，内联结果卡：译文/模型/耗时/复制/替换选中/发送到对话）、5 色高亮、复制、解释、问 AI、引用到对话
- `⌘Z` / `Ctrl+Z` 撤销最近标注/引用动作（toast 也带“撤销”按钮）；`⌘⇧Z` 重做（本地栈；注入 core undo 后由全局快捷键统一处理）
- 工具栏“区域标注”拖框创建；便签模式点击页面落点；批注 popover 内改色/编辑/删除/复制/引用/问 AI/解释

## 自测（脚本在 /tmp，不随插件发布）

```bash
# 语法 + 依赖图（只检查，不写根 client.js）
# jsdom + 真实 React 组件冒烟（假 v0.2 API）：206 项断言
node /tmp/ph-reader-test/build.mjs && node /tmp/ph-reader-test/smoke.mjs
# 真实 Host 集成冒烟：挂载真实 API，覆盖 blocks/layer/outline/ai.ask/逐段翻译/几何选段/快速翻译/标注写删+undo/深链 popover
node /tmp/ph-reader-test/real-api.mjs
# 真实 Chrome 截图预览（真实 v0.2 数据）：
#   http://127.0.0.1:8899/preview.html?mode=default|selection|annotations|ai|scrolled
```

最近一次结果：`smoke` 228/228、`real-api` 67/67（Host schemaVersion=2，真实 blocks/layer/outline；**几何选区**：真实拖选实时覆盖层 + quote/rects 来自命中词且旋转 arXiv stamp 不进选区；快速翻译真实返回中文；AI deep/fast 真实回答；标注创建→真实 pending undo context 逆操作删除（无残留）；深链 popover v0.3 结构/动作网格；逐段 `translate.text` 批量化 + 缓存；Host 旧版面回填 pending 时自动刷新）。
v0.3 视觉自查截图（真实 Chrome + 真实 Host 页面数据）：`/tmp/ph-v03-shots/selrect.png`（拖动中实时选区+已选词数）、`selection.png`（工具条：已选 N 词/快速翻译/颜色/复制/解释/问 AI/引用）、`quick.png`（内联快速翻译卡：译文+引擎+耗时+复制/替换选中/发送到对话）、`popover.png`（popover：头部/折叠 quote/自动保存/颜色行/动作网格）。

v0.4 实测（2026-11-11，真实 Host v0.4 + 真实免费接口）：auto→Google 首次 0.3–1.8s、缓存 ~0ms；MyMemory 约 2.0s；LLM 精译约 3.1s；双语整页 auto 3/3 段由 Google 引擎完成（每段 G 小标），AI 精译本页走 LLM。非官方免费接口可能限流/变更：结果卡与 popover 始终显示真实 engine/latency，失败保留“重试 / 改用 AI 精译”。

v0.4 说明：免费引擎（Google gtx 非官方接口 / MyMemory 免费额度）由 Host 统一调用并返回真实 `engine/latencyMs/cached`；阅读器只展示元数据、从不伪造来源。免费接口可能限流/变更，失败时如实显示 Host 原因并保留“重试 / 改用 AI 精译”；LLM 精译（`provider:'llm'`）作为高质量兜底。

## 已知限制 / 风险

1. **阅读位置记忆**：v0.2 契约未暴露 Host settings 写接口，暂存 `localStorage`（`pappers-hall:reader-position:<paperId>`），换设备不同步；Host 提供 settings API 后可替换 `readReadingPosition`/`saveReadingPosition`。
2. **页内查找**只在当前页内匹配（契约要求）；跨页全文查找未实现；跨页文字选择未支持（选择范围跨页时不弹工具条）。
3. 旧 Host（v0.1）无 `blocks`/`layer` 时双语与选区不可用，属预期降级；需 Host 升级后重新加载页面。
4. `reader.layer` 单页 error 会缓存到下一次挂载，不自动重试（避免对不支持该方法的 Host 反复请求）；双语面板“重试”会同时失效重取 page 与 layer。
5. 页面文字层直接使用 Host 块文本渲染卡片；若 Host 抽取质量差（如字距过宽标题被拆成单字），卡片文本会照实显示——不在前端猜测清洗。
6. 标注 popover / 便签编辑器为页内绝对定位（不 portal），极端长页面底部仍可滚动查看；缩放时随页面一起缩放。
7. AI 面板一次问答只保留在组件生命周期内（切换论文/卸载即清空），不落库。
