# Pappers-Hall v0.5 契约（2026-11-11 凌晨：真实向量检索 + 文件夹体系）

v0.4 已交付。用户新需求：
1. **把向量检索正式做起来**（当前只有 FTS + AI 关键词扩写，`vector` 通道 unavailable）。
2. **文献组织改为 Zotero 式文件夹**：只保留一个“收藏夹”（收藏标记），系统支持创建**多个文件夹**（可嵌套）把文献放进去；侧边栏与搜索都支持用**文件夹**和**标签**筛选。

## 0 分工

| 成员 | 写作用域 |
| --- | --- |
| lead | 根/构建/集成/文档；已安装本机嵌入环境与 `host/embedding_worker.py` 原型 |
| host-engineer | host/**（任务 17 文件夹，任务 18 向量） |
| client-engineer | client/src/**（reader 除外） |
| verifier | test/**、reports/v05-*.json、verify.md 追加 |

## 1 文件夹与收藏夹（Host）

### 1.1 数据迁移（user_version=5）
- `papers` 增 `favorite INTEGER NOT NULL DEFAULT 0`。
- `collections` 增 `parent_id TEXT NULL`、`kind` 取值 `'folder'|'field'`：
  * 现有 custom collections → `kind='folder'`、`parent_id=NULL`；
  * 现有 5 个派生 field collections 保留为 `kind='field'`（只读“领域”目录，不允许用户删改，但可筛选）。
- 索引：`paper_collections(paper_id)` 已有；新增 `collections(parent_id)`。
- 迁移幂等；旧 v0.4 API 保持兼容（`library.collections.*` 仍可用）。

### 1.2 文件夹 API
- `library.folders.tree {}` → `{items:[{id,name,color,kind:'folder'|'field',count,children:[...]}], total}`；`count` 为该文件夹直接+后代论文数。
- `library.collections.create {name,parentId?,color?,operationId}` → 新文件夹（parentId 必须存在且 kind='folder'；深度限制 6）。
- `library.collections.update {id,name?,parentId?,color?,operationId}`：支持重命名/移动/改色；不能移动到自身后代；field 类型不可改。
- `library.collections.delete {id,operationId}`：只删文件夹；其子文件夹上移到父级（或提示？采用上移）；field 不可删。论文不删。
- `library.collections.assign {collectionId,paperIds,add,operationId}` 既有 API 保持（成员关系多人多）。
- `library.setFavorite {ids,favorite:boolean,operationId}`；可逆（operations 日志）。
- `library.list` / `library.get`：新增 `favorite`；`library.list` 新增过滤 `favorite:boolean`、`folderId`（**包含后代文件夹**）、`tags:[...]`（AND 匹配全部标签）；`collectionId` 保留并等价 folderId；排序 `sort:'favorite'` 可选。
- `search.query` 新增 `filters:{folderId?,tags?:string[],favorite?:boolean}`（或顶层同名字段，兼容两种）；结果只在过滤后的集合内返回（所有 channel 都遵守），`channels` 不因过滤而伪造。
- `discover.feed`：`stats.favorite`；新增 section `favorite:[PaperTile]`（收藏优先，最近添加）、`folders` 树或 `folderCounts`；`collections` 字段保留（兼容）。
- `annotations.feed` 可选支持 folderId/tags 过滤（若成本高可先不做，UI 标注）。
- 撤销：create/update/delete/assign/setFavorite 均写 operations（可 undo）。

## 2 真实向量检索（Host）

### 2.1 本机已就绪的嵌入环境（Lead 已安装，可直接用）
- venv：`~/.dsh/pappers-hall/embedding/venv/bin/python`
- 模型缓存：`~/.dsh/pappers-hall/models`，模型 **`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`**（384 维，多语言，中英跨语义；CPU 单条约 25–70ms，批量更快；加载约 8s）。
- 原型 worker：`host/embedding_worker.py`（stdio JSON-lines）：
  * 启动后先输出 `{"op":"ready","model":...,"dims":384}` 一行；
  * 请求 `{"id":1,"op":"embed","texts":[...]}` → `{"id":1,"ok":true,"vectors":[[...]],"dims":384,"model":"..."}`；
  * `{"op":"ping"}`、`{"op":"shutdown"}`；
  * 环境变量 `PAPPERS_EMBED_MODEL`/`PAPPERS_EMBED_CACHE` 可覆盖。
- Host 负责：按 `config.embeddingPython`（默认上述 venv python）spawn worker；懒启动/健康检查/超时/崩溃重启（≤2）；`dispose` 时 shutdown；worker 不可用时 vector 通道 `unavailable` + reason（并提示运行 `scripts/setup-embedding.sh`）。

### 2.2 索引与存储
- 新表 `embeddings`：`{id INTEGER PK, kind:'paper'|'page'|'figure'|'annotation', ref_id, chunk_index, paper_id, page, text, vector BLOB, model, dims, updated_at}`；唯一键 `(kind,ref_id,chunk_index,model)`；索引 `paper_id`。
- 索引内容：
  * paper：title + titleZh + abstract + keywords + venue（1 条/篇）；
  * page：`reader.page` 的 blocks 文本按 600–800 字符切块（overlap 80；只取正文 role=body/heading/caption，跳过页眉页脚）；
  * figure：caption + label + paper title；
  * annotation：quote + comment + paper title。
- `embedding.index {force?}`：后台 job（持久队列），分批 embed（batch 16，并发 1）；写库；幂等：同 `(kind,ref_id,chunk_index,model)` upsert；进度 `{papers,pages,figures,annotations}`；完成写 settings `embedding.indexVersion = 'v1:<model>:384'` + builtAt。mount 时：worker 可用且 indexVersion 不匹配 → 自动入队；失败可重试。
- `embedding.status {}` → `{available, configured, pythonPath, model, dims, indexVersion, building, counts:{papers,pages,figures,annotations}, lastError}`。
- `scripts/setup-embedding.sh`：创建 venv、pip install torch==2.2.2 sentence-transformers==2.7.0 "numpy<2"、预下载模型；README 写清（可选组件、占用空间约 1.2GB、CPU 推理、不联网也可用；未安装时诚实 unavailable）。

### 2.3 检索
- `search.query`：worker 可用时新增/启用 `vector` channel（status='ok'，含 model/latencyMs/k），对 query 做嵌入（中文直接多语言模型；同时若 AI 扩写开启，可对扩写英文再算一次取 max），与 FTS/LIKE/AI 通道用 **RRF** 融合；结果项加 `reasons:['vector_similarity']`（及 score）；scope=papers/pages/figures/annotations 各自支持；应用 §1 过滤（folderId/tags/favorite）。
- 语义查询示例验收：`"如何用强化学习做农业决策"`、`"agent 推理与行动结合"`、`"遥感影像预训练模型"`、`"气候变暖对作物产量的影响"` → 返回的 Top5 应相关（人工/规则判定，记录真实结果；不调期望）。
- 降级：worker 不可用 → `vector: unavailable` + reason；其余通道照常；不伪造向量结果。
- `diagnostics.embedding` 暴露状态；README 说明模型/维度/隐私（文本只在本机 CPU 模型内计算，不上传）。

## 3 客户端（文件夹 UI + 语义检索入口）

### 3.1 主面板文献库
- 左栏改“文件夹”体系：
  * **收藏夹**（单一智能视图，星标收藏，badge 数）；
  * **我的文件夹**：树形（可嵌套、展开/折叠、缩进、拖论文入夹、右键/... 新建子文件夹/重命名/改色/删除；删除子夹上移；显示直接+后代计数）；
  * **领域**（5 个 system/field 目录，只读，可筛选）；
  * 智能视图保留（全部/最近/未读/在读/已读/有批注/重复/图片搜索）。
- 新建文件夹入口（左栏 + “新建”顶部按钮），支持嵌套；拖拽论文行到文件夹（HTML5 DnD，已有 DnD 基建）；批量条“加入文件夹”改为选择文件夹树。
- 详情右栏“收藏夹”区改为：收藏星标按钮 + “文件夹”勾选列表（含层级）；标签编辑保留。
- 搜索过滤：主面板搜索旁加筛选 chips（文件夹▾ 树选择 / 标签▾ 多选 / 收藏 / 未读 等），与 library.list/search.query 过滤参数打通；URL/路由不必持久。

### 3.2 侧栏
- 顶部筛选 chips 的“收藏夹▾”改为“文件夹▾”（树选择，含“全部/未分类”）+ 标签▾；新增“收藏”chip。
- 分组：继续阅读 / 未读推荐 / 有批注 / **收藏夹** / 文件夹；点击文件夹可筛选论文 tab；批注/图片 tab 同步应用文件夹/标签过滤（Host 支持则用，否则本地近似并标注）。
- 新建收藏夹入口移除（单一收藏夹）；保留单一 收藏 切换（星标）。
- 搜索：跨 tab 搜索时应用当前文件夹/标签过滤；结果显示“文件夹/标签”匹配提示。
- 视觉与交互沿用 v0.4 设计系统；嵌套文件夹缩进 12px/层；拖拽放置高亮；空态引导“新建文件夹”。

### 3.3 搜索与语义检索入口
- 主面板与侧栏搜索结果展示通道 chips（全文/标签/AI 扩写/向量）；向量可用时显示“语义检索”标记与模型名+延迟；不可用时显示“向量检索不可用：运行 scripts/setup-embedding.sh”。
- 搜索框占位“搜索题目、作者、批注或描述语义…”；⌘K 命令面板加“语义搜索…”入口。
- 过滤 + 搜索组合可用（文件夹 + 标签 + 关键词 + 语义）。

## 4 验收（v0.5）

1. `node test/v05.mjs`：folders tree/create-nested/update-move/delete-promote/assign/favorites/filters（folderId 含后代、tags AND、favorite、search.query filters）、embedding.status/index/search（vector 通道 ok + reasons；worker 不可用降级）、语义查询真实 Top5 记录、回归 v04 34/34/v03 38/38/v02 26/26/lifecycle。
2. 真实浏览器：左栏文件夹树创建/嵌套/拖入/筛选；单一收藏夹；侧栏文件夹+标签筛选；搜索+文件夹+标签组合；语义检索通道显示与结果；截图 ≥12。
3. `host/selftest.mjs` PASS（含 folder/favorite/vector 降级）；README 写清嵌入组件安装/占用/隐私/降级。
