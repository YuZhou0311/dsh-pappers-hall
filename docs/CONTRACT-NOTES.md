# v0.17 笔记后端契约（Host 侧）

状态：已实现并通过隔离测试（schemaVersion **8**，插件版本 0.16.2 → 由 Lead 统一 bump）。
适用代码：`host/notes.js`、`host/db.js`、`host/store.js`、`host/api.js`、`host/apply.js`。
测试：`node test/notes.mjs`（隔离临时库）、`node host/selftest.mjs`（含 notes 集成断言）。

---

## 1. 设计要点

- **只新增、不改写**：笔记工作台使用独立表（`note_docs` 等），**不触碰**旧 `notes` 表（论文小笔记，id `nt-…`）与 `notes_fts`。旧库升级只 `CREATE TABLE IF NOT EXISTS`，不清数据、不改行。
- **用户原文永不丢失**：`content_md` 是用户自己的 Markdown/纯文本；`content_json` 是 AI 美化后的结构化布局（可为 `null`）。任何更新路径都不会用其一覆盖另一。
- **写入原子**：每个写操作在单个 `BEGIN IMMEDIATE` 事务内完成；更新前先写 `note_revisions` 快照（每篇保留最近 50 版）。
- **软删 + 显式 purge**：删除进回收站（`state='trash'`、`deleted_at`），只有显式 `notes.purge` 才物理删除；`purge` 默认要求笔记已在回收站（可 `force:true` 强制）。
- **双索引**：
  - 全文：`note_fts`（FTS5；不可用时自动降级 LIKE），索引文本 = 标题 + 原始 `content_md` + `content_json` 的语义纯文本。
  - 向量：独立表 `note_embeddings`，只在本地 embedding 组件可用时维护；不可用时诚实降级，不伪造。
- **可撤销**：所有写方法都带 `operationId` 幂等与 `operations` 日志；`operations.undo` 可撤销 create/update/delete/restore/restoreRevision/link/unlink/folders.*；`purge` 不可撤销（明确返回 `not_undoable`）。
- **命名**：wire 层请求/响应一律 **camelCase**；表内 snake_case 不暴露。

---

## 2. 迁移（schemaVersion 8）

`host/db.js`：

- `SCHEMA_VERSION = 8`，`migrate()` 在 v7 路径与同版本修复路径都会调用 `applyV8Schema(db, { fts5 })`（幂等）。
- 新增普通表：`note_docs`、`note_folders`、`note_paper_links`、`note_revisions`、`note_embeddings`。
- 新增 FTS 虚表：`note_fts(note_id UNINDEXED, title, content)`（FTS5 可用时）。
- `notes_fts`、`notes`、`papers`、`annotations` 等既有表完全不变。
- 导出 `NOTE_TABLES` 与 `applyV8Schema()` 供测试/诊断使用。

旧库验证（真实库副本，非 live）：v7 → v8 后 `papers=6 / annotations=2 / figures=77 / embeddings=724` 前后完全一致，重复 `migrate()` 返回 `migrated:false` 且不重复建表。live 插件需要 Lead 重新加载后才会执行该迁移。

---

## 3. 数据模型

### `note_docs`
| 列 | 说明 |
| --- | --- |
| `id` | `note-` + 12 位小写 hex |
| `title` | 标题（≤300 字符，可为空） |
| `content_md` | 用户原文，永不因美化而改写 |
| `content_json` | AI 结构化布局（JSON 文本，可 `null`） |
| `index_text` | 派生索引文本（标题 + content_md + content_json 语义纯文本），供 FTS/LIKE/embedding 共用 |
| `status` | `draft` \| `ready` |
| `folder_id` | 可空，指向 `note_folders.id` |
| `format_version` | 客户端布局版本（文本，可空） |
| `beautified_revision` | 已美化依据的 revision 或节级 hash（文本，可空，原样存） |
| `state` | `active` \| `trash` |
| `created_at`/`updated_at` | ISO 时间 |
| `revision` | 乐观并发版本，每次 update/restoreRevision +1 |
| `deleted_at` | 软删时间 |

### 其它表
- `note_folders(id, name, parent_id, color, sort_order, created_at, updated_at)`：层级文件夹；删除时子夹与笔记上移到父级（根则变为未分类），**不删笔记**。
- `note_paper_links(note_id, paper_id, anchor_json, created_at)`：多对多；`anchor_json` 原样保存客户端锚点（如 `{page:3}`）。
- `note_revisions(id, note_id, revision, title, content_md, content_json, reason, created_at)`：快照，`reason ∈ create|update|beautify|restore`；每篇保留最近 50 条。
- `note_embeddings(note_id, chunk_index, text, vector BLOB, model, dims, updated_at)`：独立向量索引，唯一键 `(note_id, chunk_index, model)`。

---

## 4. 索引文本规则

`buildNoteIndexText({title, content_md, content_json})`：

1. 标题；
2. **原始 `content_md`**（保留用户 Markdown 原文）；
3. `contentJsonPlainText(content_json)`：递归提取标题/段落/分点/表格单元格/引用文本，忽略 `type/kind/id/style/attrs/color/icon/layout/…` 等 UI 键，去除 `#`、`**`、`__`、反引号、列表符号、表格竖线、HTML 标签等表现标记；重复文本去重。

因此：**美化前后检索语义一致**——UI 从 Markdown 切到卡片布局不会改变可检索内容。`note_fts`、`note_embeddings` 与 `notes.search` 的 LIKE 通道都使用该文本。

### 增量同步
- 每次 create/update/delete/restore/restoreRevision 提交后，`notes` 服务内部 1–1.5s debounce 调度 `syncIndexNow({ids})`，**不阻塞写入**；失败只写 state，不抛给客户端。
- 手动入口：`notes.indexSync {ids?}`（返回 `queued|unavailable`）、诊断 `notes.indexStatus`。
- 同步算法：分块（≤700 字符，重叠 60）→ `embedding.embedTexts` → upsert；删除不再存在/移入回收站的 chunk；其它模型的行在重嵌入时清理。
- 中文用 FTS + LIKE 双通道（unicode61 无法切分中文子串时由 LIKE 兜底）。

---

## 5. Wire API（`POST /pappers-hall/api`，`{method,params}`）

信封与错误码沿用现有约定：成功 `{ok:true,data}`；失败 `{ok:false,error:{code,message,detail?}}`，
`code ∈ invalid | not_found | conflict | unavailable`。

### 5.1 笔记 CRUD

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `notes.list` | `{folderId?, query?, paperId?, status?, includeTrash?=false, sort?='updated'|'created'|'title', limit?=50, offset?=0}` | `{items:[summary], total, limit, offset}`；`folderId` 含后代；summary 含 `id,title,status,folderId,folder,paperIds,paperCount,preview,revision,beautifiedRevision,formatVersion,hasContentJson,state,createdAt,updatedAt` |
| `notes.get` | `{id, includeTrash?}` | `{note:{id,title,contentMd,contentJson,status,folderId,folder,formatVersion,beautifiedRevision,revision,state,createdAt,updatedAt,deletedAt,paperLinks:[{paperId,title,titleZh,year,venue,state,anchor}],paperIds,preview,revisions:[{id,revision,title,reason,createdAt,contentMdLength,hasContentJson}]}}`；回收站笔记默认也可读 |
| `notes.create` | `{title?, content?|contentMd?, contentJson?, folderId?, paperIds?:[], status?='draft', formatVersion?, operationId?}` | `{note, operationId?}`；id `note-…`；初始 revision 0 并写 create 快照 |
| `notes.update` | `{id, patch:{title?, content?|contentMd?, contentJson?, folderId?, paperIds?:[], status?, beautifiedRevision?, formatVersion?}, expectedRevision?, operationId?}` | `{note, operationId?}`；每次成功 update revision+1；`expectedRevision` 不匹配 → `conflict` + `detail.currentRevision`；`contentJson:null` 仅清除美化 |
| `notes.delete` | `{ids:[…], operationId?}` | `{deleted:[ids], trashed:true, operationId?}`（软删） |
| `notes.restore` | `{ids:[…], operationId?}` | `{restored:[ids], operationId?}` |
| `notes.purge` | `{ids:[…], force?:false, operationId?}` | `{purged:number, ids, operationId?}`；默认要求先入回收站 |
| `notes.revisions` | `{id, limit?=50}` | `{noteId, items:[…]}`（新→旧） |
| `notes.restoreRevision` | `{id, revision, expectedRevision?, operationId?}` | `{note, restoredRevision, operationId?}`；先快照当前再恢复，revision+1 |

### 5.2 笔记文件夹

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `notes.folders.tree` | `{}` | `{folders:[{id,name,parentId,color,sortOrder,count,directCount,children:[…]}]}`；`count` 含后代笔记 |
| `notes.folders.create` | `{name, parentId?, color?, operationId?}` | `{folder, operationId?}`；id `nf-…` |
| `notes.folders.rename` | `{id, name?, color?, operationId?}` | `{folder, operationId?}` |
| `notes.folders.delete` | `{id, operationId?}` | `{deleted, movedNotes, movedChildren, operationId?}`；子夹/笔记上移，不删笔记 |
| `notes.folders.assign` | `{folderId, noteIds:[…], operationId?}` | `{assigned, folderId, operationId?}` |
| `notes.folders.unassign` | `{noteIds:[…], operationId?}` | `{unassigned, operationId?}` |

### 5.3 论文关联（双向）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `notes.link` | `{noteId, paperIds:[…], anchor?:object, anchors?:{paperId:anchor}, operationId?}` | `{note, operationId?}`；论文必须存在 |
| `notes.unlink` | `{noteId, paperIds:[…], operationId?}` | `{note, operationId?}` |

- 笔记 → 论文：`notes.get` 的 `paperLinks`（含论文标题/年份/期刊摘要与 `state`）。
- 论文 → 笔记：`notes.list {paperId}`、`notes.search {paperId}`、Agent `notes_list/notes_search {paperId}`。
- 论文被 `library.purge` 时仅删除 `note_paper_links` 行，**不删除笔记**；`library.merge` 会把重复条目的笔记关联迁移到主条目（可 undo 还原）。

### 5.4 搜索 / 导出 / 索引

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `notes.search` | `{q, folderId?, paperId?, includeTrash?, limit?=20, offset?=0}` | `{items:[{noteId,id,title,snippet,folderId,folder,paperIds,status,updatedAt,channels:[…]}], total, query, limit, offset, channels:{fts,like,vector}, degraded:[{channel,reason}]}`；`q` 为空返回空集 |
| `notes.export` | `{ids:[…], format?:'md'|'json'|'both'='both'}` | `{items:[{id,title,filename,mediaType,content,jsonFilename,jsonContent}], format, exportedAt, count, markdown?, json?}`（不依赖 zip） |
| `notes.indexSync` | `{ids?:[…], operationId?}` | `{status:'queued'|'unavailable', queued, reason?, vector}` |
| `notes.indexStatus` | `{}` | `{fts:{available,indexedNotes}, vector:{configured,available,model,dims,indexedNotes,indexedChunks,ready,models,lastSyncedAt,lastError,last}, revisionLimit}` |

`snippet` 中命中词用 `[ ]` 包裹（FTS 通道）；`channels.vector` 为命中数或 `'degraded'`，降级原因在 `degraded[]`。

### 5.5 兼容：旧 `notes.create` / `notes.delete`

- `notes.create`：带 `text` 字段且无 `content/contentMd/paperIds/folderId` → **旧论文小笔记**（`nt-…`，行为与 v0.16 完全一致，空 `text` 仍返回 `invalid`）；否则 → 笔记工作台。Agent `notes_create` 工具与 v0.17 客户端都走工作台路径。
- `notes.delete`：`ids` 全为 `note-…` → 工作台软删；单个 `id` 为 `nt-…` → 旧逻辑；混用返回 `invalid`。
- 旧 `search.query scope:'notes'`、`export.notes`、bundle materials 完全不受影响。

---

## 6. Agent 工具（由 Lead 在 `host/tools.js` 实现，Host 只提供原子服务）

| 工具 | 映射 | 说明 |
| --- | --- | --- |
| `notes_list` | `notes.list` | 参数 `folderId/paperId/query/limit/offset` |
| `notes_get` | `notes.get` | `noteId` |
| `notes_create` | `notes.create` | `title/content/folderId/paperIds` |
| `notes_update` | `notes.update` | `noteId/patch/expectedRevision`，patch 原样透传 |
| `notes_search` | `notes.search` | `q/folderId/paperId/limit` |
| `notes_link_papers` | `notes.link` / `notes.unlink` | `noteId/paperIds/action` |

工具层**不自动美化、不自动决定结构**；美化只允许客户端显式调用 `ai.ask` 后通过 `notes.update {patch:{contentJson,...}}` 写入，Host 不在工具/服务内部改写 `content_md`。

---

## 7. 撤销与幂等

- 写方法接受 `operationId`：同一次调用重试返回首次结果（缓存在 `settings`）。
- `operations` 日志新增 kind：`note.create|note.update|note.delete|note.restore|note.purge|note.restoreRevision|note.link|note.unlink|note.folder.create|note.folder.update|note.folder.delete|note.folder.assign|note.folder.unassign`。
- `operations.undo {operationId}`：
  - update/restoreRevision：恢复更新前的 title/content_md/content_json/folder/status 与论文关联，revision+1；
  - delete ↔ restore：状态互反；
  - create：移入回收站；
  - folder create/update/delete/assign/unassign、link/unlink：恢复原状；
  - purge：`not_undoable`。
- 撤销在 store 的同一事务内执行（`store.applyInverse` 分发到 `notes.applyUndo`），不嵌套事务。

---

## 8. 测试

```bash
node host/selftest.mjs      # PASS — 419 checks
node test/notes.mjs         # PASS — 104 checks
```

- `test/notes.mjs`：全新临时 dataDir（`mkdtemp`，绝不打开 `~/.dsh/pappers-hall`），插入 2 条合成论文行；覆盖 schema v8、CRUD、conflict、revision/restore/50 版上限、文件夹树/移动/删除上移、软删/恢复/purge、FTS/LIKE（中英）、content_json 语义文本、`note_embeddings`（确定性 stub embedder，无需下载模型）、论文双向查询、export、undo、operationId 幂等、旧 `notes.create {text}` 兼容、**真实 HTTP 路由**（`POST /pappers-hall/api`），以及 **v7→v8 旧库升级不丢数据**。
- `host/selftest.mjs`：迁移断言改为 `user_version=8`，新增 notes 工作台集成断言（与旧 `notes.create`/`search.query notes` 断言共存）。
- 真实库只读验证：复制 live 库到 `/tmp` 后跑 `migrate()`，v7→v8 数据计数不变（6 篇/2 批注/77 图/724 embedding），随后副本已删除；未触碰 live 库。

---

## 9. 已知限制 / 未完成项

1. **AI 美化不在 Host**：没有 `notes.beautify` 接口（刻意避免与客户端重复实现）；客户端用 `ai.ask` 生成 JSON 后走 `notes.update` 落 `content_json`。Host 负责节级 hash 原样保存与防覆盖。
2. **无 zip 导出**：`notes.export` 返回 md/json 内容（避免新增依赖），打包由客户端/浏览器完成。
3. **向量索引依赖可选本地模型**：未安装时 `channels.vector='degraded'` + `degraded.reason`，不影响 FTS/LIKE；安装后写操作自动增量同步，无需重建论文索引。
4. **中文 FTS 精度**：沿用默认 unicode61（无 trigram 表），中文子串由 LIKE 通道兜底；`snippet` 在 LIKE 通道不带方括号高亮。
5. **revision 去歧义**：`notes.restoreRevision` 按 revision 号取最新快照；同一 revision 的多个快照内容等价，当前不需要 snapshotId。
6. **live 生效需重载插件**：schema 迁移与新 API 在 Lead reload 后才会出现在运行中的 Host；本任务未自行 reload/未改 profile。
7. **客户端字段**：`contentMd/contentJson/paperLinks/folder` 等均为 camelCase；旧 snake_case 兼容由客户端 normalizer 自行处理。
