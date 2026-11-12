# Pappers-Hall v0.6 契约（2026-11-11 上午：DSH 深度集成 + 自动文献管理）

v0.5 已交付。用户新需求：
1. **不要“领域”分类**：领域这一层直接并入普通文件夹（可编辑/嵌套），UI 不再有独立“领域”分组。
2. **DSH 直接做文献管理**：Agent 能自动分类导入的论文到合适文件夹；没有合适文件夹时自动新建；用户上传 PDF 时先询问“是否加入论文中心”，同意后自动归类存放。
3. **“+”号菜单插件选项**：聊天框 + 菜单里出现“论文中心”入口，可把论文中心 @ 进对话；Agent 自动调用插件工具（找相关论文、读大量文献、深度绑定科研任务）。

## 0 分工

| 成员 | 写作用域 |
| --- | --- |
| lead | 根/集成/文档/真实 GUI 与 Agent 验收 |
| host-engineer | host/**（v6 迁移、classify、tools、system prompt、import） |
| client-engineer | client/src/**（reader 除外；+ 菜单/@、领域移除、导入提示） |
| verifier | test/**、reports/v06-*.json、verify.md 追加 |

## 1 去掉“领域”层（Host + Client）

- 迁移 `user_version=6`：`UPDATE collections SET kind='folder' WHERE kind='field'`；此后所有文件夹同权（可改名/改色/移动/删除/嵌套，论文不随夹删除）；`library.collections.list`/`folders.tree` 不再返回 `kind:'field'`（无 field 只读逻辑；`papers.field` 列保留为文献元数据，但不再作为分类/UI 分组）。
- `field` 搜索过滤保留兼容（内部用），但 UI 不再展示“领域”。
- Client：左栏“我的文件夹”树包含全部文件夹（含原 5 个领域文件夹，可编辑）；删除独立“领域”分组/只读标记/field 相关 chips；侧栏/详情同样按普通文件夹处理。
- `discover.feed` 不再区分 field；`folderCounts` 一致。

## 2 自动分类（Host）

- 新 `host/classify.js`：
  * 文件夹画像：folder 内直接成员论文的 `embeddings(kind='paper')` 均值；空文件夹用文件夹名 embedding；缓存失效按 updated_at。
  * `suggest({paperIds, sessionId?})`：对每篇取 paper embedding（缺失则现算），与 folder 画像余弦；排序；阈值默认 **0.32**；最佳低于阈值 → 返回 `create` 建议（名称由 LLM 生成 2–8 字中文主题，失败用 title 关键词/venue 兜底，禁止空名）。
  * `apply({paperIds, folderId?, createName?, auto})`：assign（多对多）或先 create 再 assign；写 operations 可 undo；返回 `{applied:[{paperId,folderId,folderName,created,confidence}], createdFolders}`。
  * `import` 后自动分类：`library.import` 完成（acceptedItems）后对每篇新 paper 调 apply(auto=true)，把 `classification` 写进 import 结果；失败不阻塞导入，返回 classification.error。UI toast 展示“已归类到 X / 新建文件夹 Y（可撤销）”。
- API：`library.classify {paperIds, apply?:boolean}` → `{suggestions:[{paperId, folderId?, folderName?, score, action:'assign'|'create', newFolderName?}], applied?}`；server-side 校验；`library.folders.tree` 计数保持 v0.5 DISTINCT 语义。
- 文件夹为空且自动新建时检查同名（同父级）复用。
- 不伪造 confidence；embedding 不可用时 classify 返回 `status:'unavailable', reason:'embedding unavailable'`，import 不自动归类并在结果里注明。

## 3 Agent 工具与系统提示（Host）

新增 tools（保留现有 10 个）：
- `papers_overview {}`：库统计/文件夹树/标签/最近批注（≤每类摘要），供 Agent 建立上下文。
- `papers_folders {action:'tree'|'create'|'rename'|'delete'|'assign'|'unassign', id?/name?/parentId?/paperIds?/folderId?}`：文件夹 CRUD 与成员管理（调用 host store；返回新树；delete 论文不删；全部可 undo）。
- `papers_classify {paperIds, apply?}`：语义归类建议/应用（apply=true 时自动建夹/归类，返回 applied 与 confidence）。
- `papers_import_file {path, confirm?}`：
  * `path` 为 PDF 的绝对路径或相对 **workspace cwd** 路径；不存在/非 PDF/不可读返回 `{status:'invalid', reason}`；
  * `confirm !== true`：**只做预览**（读文件头/首页文本/DOI/标题猜测），返回 `{status:'needs_confirmation', kind:'paper'|'unknown', title, doi?, rows?, question:'这篇 PDF 看起来是论文《…》，要加入论文中心吗？'}`，**绝不写库**；
  * `confirm === true`：调用现有 ingest 导入，成功后自动 classify（§2）并返回 `{status:'imported', paperId, title, classification}`；重复论文返回 duplicate。
- `papers_related {paperId?|query?, limit?}`：语义相关文献（paper embedding 最近邻或 query 检索，排除自身），返回 topN 论文卡片（title/year/venue/score）。
- 工具描述必须写明使用时机（找文献/管理文件夹/导入 PDF/先确认）。
- **系统提示**：扩展 `host/apply.js` 的 MATERIALS_PROMPT（或新增 section，name 唯一 `pappers-hall:management`，order 用 FILE_REFERENCE+2）：
  * 用户问“找文献/推荐论文/这个主题有什么论文”→ 先 `papers_search`/`papers_related`（语义），必要时 `papers_get_passage` 读原文；不要凭空编造。
  * 用户上传/提及 PDF 路径或附件 → 调 `papers_import_file {path, confirm:false}` 预览；**必须先向用户确认**“是否加入论文中心”；同意后 `confirm:true` 导入；导入会自动归类（无合适则新建），把归类结果告知用户；拒绝则不导入。
  * 用户要整理文献/新建文件夹/移动论文 → `papers_folders`；需要 AI 归类 → `papers_classify`；操作后报告结果。
  * 引用论文 → `papers_cite`；不要修改用户数据前不确认（删除/大量移动先问）。
- `diagnostics` 增 `agent: {tools:[name...], promptSection:true}` 供验收（不泄露 prompt 全文）。

## 4 “+”菜单与 @ 论文中心（Client）

- 注册 `inputTriggers` 服务（package `@deepseek-ai/dsh-client-ui-input-trigger`）：
  * **slash source**（`trigger:'/'`, name:'papers', order 靠前）：候选 4 项——「论文中心：找相关文献」「论文中心：整理/新建文件夹」「论文中心：导入这篇 PDF」「论文中心：查看文献概览」；onPick 向输入框插入对应中文指令模板（如“请使用论文中心工具，在我论文库中查找与以下主题相关的文献：
”），用户点 + 即可看到并选择。
  * **@ source**（`trigger:'@'`, name:'papers'）：候选 = 最近论文（title/year/venue）、文件夹（folder）；查询时调 `search.query {scope:'papers', ai:false}` + `library.folders.tree`；onPick 插入 chip `{source:'papers', ref}`；`codec.serialize(ref)` 返回模型可读短串：`@论文中心(paper:ph-xxx)` / `@论文中心(folder:cl-xxx)`；系统提示词解释该 token 应调用 papers_* 工具（Host §3 已写）。
  * `openReference` 对 paper 打开阅读器、folder 打开论文中心筛选（尽力）。
- 输入框附件区：检测 draft 中 PDF 附件时显示提示条「检测到 PDF：发送后 Agent 会先询问是否加入论文中心」；不自动导入。
- 导入完成 toast：显示自动归类结果（文件夹/新建/未配置向量时的 reason）与撤销入口。
- 去掉领域 UI（§1）；保留 v0.5 所有功能。

## 5 验收（v0.6）

1. `test/v06.mjs`：迁移 v6（无 field kind、5 个原领域变普通文件夹、可删除/改名）、`library.classify`（assign/create、阈值、空库 unavailable、undo）、`library.import` 自动归类结果、`papers_import_file` 预览不写库/confirm 导入/重复、`papers_folders` 全 action、`papers_related`/`papers_overview` 结构、diagnostics.agent；回归 v05 42/43、v04/v03/v02/lifecycle。
2. 真实 GUI：左栏无“领域”分组、所有文件夹可编辑；+ 菜单出现论文中心 4 项、@ 候选论文/文件夹；发送 @ 引用后 Agent 能调用工具；上传 PDF 后 Agent 先询问、确认后导入+归类（真实会话验收，记录工具卡片）。
3. Host selftest PASS；README 写清自动归类逻辑/阈值/隐私与 DSH 集成用法；数据基线不动（30 篇/21 批注/346 图，测试夹清理）。
