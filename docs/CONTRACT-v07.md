# Pappers-Hall v0.7 契约（2026-11-11 下午：状态可解释 + 侧栏筛选修复）

用户反馈（截图）：
1. 底部状态栏“降级：vector, ocr, translation”不知道什么意思。
2. 对话右侧论文侧栏选择文件夹/标签/收藏后不能筛选论文。

## 1 Host：状态动态化
- `status.degraded` 原本是 mount 时静态数组；改为每次基于真实能力：
  * `vector`：仅当 embedding 组件缺失/未配置/索引未建才出现，reason 真实（setup-embedding.sh / index not built）；ready 时不得出现。
  * `translation`：DSH translator 或免费引擎链（google/mymemory/llm）至少一个可用 → 不出现，`diagnostics.capabilities.translation='ready'`（可加 `translationProviders`）。
  * `ocr`：保留（未安装 OCR），reason 改为用户可读“未安装 OCR 引擎（扫描版 PDF 不提取文字）”，并尽量标 `severity:'optional'`/`optional:true`。
  * `fts`：现有逻辑不变。
- `diagnostics.capabilities.vector/translation` 与 status 一致；selftest 同步且不放宽断言。

## 2 Client：侧栏筛选修复
- 论文 feed：useEffect 依赖补 `filters.folderId/favorite/tags`，hasFilters 同步；`library.list` 传 folderId/favorite/tags（AND），与 quick/reading/annotated/query 组合；清空筛选补齐。
- 批注 tab：`annotations.feed` 传 folderId/tags（Host 已支持），依赖同步。
- 图片 tab：folder/tags 激活时先 `library.list {folderId,tags,limit:500}` 取允许 paperIds，再客户端过滤 figures；空态提示。
- 笔记 tab：按允许 paperIds 过滤（notes 含 paperId）。
- 状态栏：channel id → 中文（vector 向量检索 / ocr OCR / translation 翻译 / fts 全文索引），文案“未启用/降级：…”，title 解释；OCR 标可选；vector ready 不显示。
- 侧栏所有筛选组合（文件夹+标签+收藏+搜索+阅读状态）生效；清除单个筛选可用。

## 3 验收
- v07 API：动态 degraded/capabilities、annotations.feed folderId/tags 过滤、library 组合过滤；回归 v06/v05/v04/v02/lifecycle/v03。
- 真实 GUI：对话右侧侧栏选文件夹→列表变为该夹论文（含后代）；标签/收藏组合；状态栏中文标签+tooltip；数据 30 篇/21 批注/346 图不变。
