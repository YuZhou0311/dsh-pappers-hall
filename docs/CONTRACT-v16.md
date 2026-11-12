# v0.16 契约变更：Agent 基础工具化（分类任务去封装）

## 1. 工具表面变化

- **移除** `papers_classify {paperIds, apply?}`（会按 embedding 阈值直接建夹/归类）。
- **新增基础工具**
  - `papers_list {folderId?, query?, limit?, offset?}` → `{status, total, items[]}`，
    item 含 `paperId/title/titleZh/authors/year/venue/tags/folders/read/favorite/figureCount/annotationCount/abstract(≤900 字)`。
  - `papers_abstracts {paperId?|paperIds?|folderId?|query?|limit?|offset?}` → `{status,count,items[]}`，
    item 含 `paperId/title/titleZh/year/venue/folders/tags/read/abstract/abstractSource/abstractCorrected`；
    单篇与批量共用同一工具，摘要不像摘要时自动从首页版式校正（read-only）。
  - `papers_get {paperId}` → `{status, paper:{...元数据/摘要/关键词/文件夹/图表清单/批注与笔记计数}}`。
  - `papers_update {paperId, patch}` → 直接改基础元数据（titleZh/authors/venue/year/doi/abstract/keywords/addTags/removeTags/read/readingProgress…）。
  - `papers_folder_hints {paperIds}` → **只读** `{status, referenceOnly:true, note, reason, threshold, suggestions[]}`；
    suggestions 含 `score/confidence/margin/stable/evidence/memberCountExcluding/secondFolderName/secondScore`。
- 工具总数 15 → 19；`diagnostics.agent.tools.length === 19`。

## 2. 导入行为变化

- `library.import` / `papers_import_file` **默认不自动分类**：
  `classification = {status:"skipped", reason:"agent-driven classification: …", applied:[], createdFolders:[]}`。
- 需要旧行为时显式传 `autoClassify: true`（仍可能因 embedding 不可用而降级，且不阻塞导入）。
- 导入成功后论文处于“未分类”，由 Agent 用 `papers_list/papers_get` 阅读后用 `papers_folders` 归类。

## 3. 系统提示变化

`plugin:pappers-hall-management` 增加“像人类图书管理员一样整理”的指令：
先读（`papers_list`/`papers_get`/`papers_get_passage`）→ 归纳领域/方法/问题 →
设计 2–6 个可解释的主题夹 → 用 `papers_folders` 落地；`papers_folder_hints`/`papers_related`
仅为 embedding 参考，不得单独决定分类；批量移动/删除需确认。

## 4. 保留的后端能力

- API `library.classify` 保留（只读建议 + 可选 apply），供未来 UI/内部使用；
  Agent 工具层不再暴露会直接写库的 classify。
- 分类器 `host/classify.js` 修正：LOO 打分、移除自动 field 反馈、输出 margin/stable。
- 增量索引：`papers_import_file` 直接走 ingest 时也触发 `notifyIndexChanged`。

## 5. 验收

- `host/selftest.mjs`：18 tools、导入默认 skipped、`papers_list/abstracts/get/update` 可用、
  `papers_folder_hints` 只读且无 embedding 时诚实降级；**394 checks PASS**。
- 稳定性报告：`reports/v16-classification-stability.md`。


## 6. v0.16.2 翻译契约补充

- `translate.text {provider:'llm', fast:false}`：请求 LLM 深译，`reasoningEffort:'medium'`（模型支持 medium 时）；返回值新增 `reasoningEffortRequested`，并保留 `reasoningEffort` 实际档位。
- 显式 provider 只请求该引擎，不自动跨引擎兜底；LLM 通道不可用时返回 `unavailable` + `reason`，不返回免费引擎结果。
- `translate.blocks {provider:'llm'}` 的整页精译同样请求 medium。
- `ai.quickTranslate` 作为 AI 精译兜底时使用 `fast:false`（深度）。


## 7. v0.17 笔记工作台（摘要，详见 docs/CONTRACT-NOTES.md）

- schema v8 只新增笔记表；`notes.*` 21 个 API（list/get/create/update/delete/restore/purge/revisions/restoreRevision/folders.*/link/unlink/search/export/indexSync/indexStatus）。
- content_md（用户原文）与 content_json（AI 美化结构）严格分离；每次 update 前写 revision 快照（50 版）；软删/回收站；purge 显式。
- 双索引：note_fts + note_embeddings；索引文本 = 标题 + content_md + content_json 语义纯文本。
- Agent 工具：notes_list/get/create/update/search/link_papers（原子，不自动美化）。
- 内容完整性：store.pageTextForAi 质量门禁 + OCR 回退；store.repairQuoteFromOcr 区域 OCR 修复批注/选区 quote。
