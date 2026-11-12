# Pappers-Hall 验收测试（test harness）

纯 Node（无第三方依赖）的可重复验收脚本。所有请求走本机 DSH Web GUI 上插件注册的同源 HTTP 路由：

- JSON：`POST http://127.0.0.1:3080/pappers-hall/api`，body `{method, params}`，返回 `{ok:true,data}` / `{ok:false,error}`；
- 资源：`GET /pappers-hall/page|figure|thumb|pdf/...`。

插件路由是普通 `webServer` 命名路由，不经过 `/api` 的 Cookie admission，因此脚本直接用 `fetch` 调用；不需要、也不得复制用户 Cookie。

## 前置条件

1. DSH 桌面版运行中，插件 `dsh-pappers-hall` 已安装并启用（`plugin_manager` 由 Lead 执行）；
2. 30 篇 PDF 已下载在 `../pappers_hall_devkit_lite/papers/pdf/`；
3. Node ≥ 24（本机 v26）。

## 命令

```bash
# 1) 只校验 fixture（不调 API）：60/10/10/3 数量、manifest sha256、跨引用、suite 计划
node pappers-hall-plugin/test/run-tests.mjs --dry-run

# 2) 全量自动验收（import → search → annotations → lifecycle；toggle 读取已记录阶段）
node pappers-hall-plugin/test/run-tests.mjs

# 3) 子集
node pappers-hall-plugin/test/run-tests.mjs --only import,search
node pappers-hall-plugin/test/run-tests.mjs --only search --timeout-ms 60000

# 4) 单 suite（各自会落盘 test/.artifacts/<suite>.json）
node pappers-hall-plugin/test/import.mjs
node pappers-hall-plugin/test/search.mjs
node pappers-hall-plugin/test/annotations.mjs
node pappers-hall-plugin/test/lifecycle.mjs --lifecycle-paper C05
```

可选参数：`--api-base URL`、`--profile desktop`、`--timeout-ms`、`--import-timeout-ms`（默认 30 分钟，30 篇 PDF 的文本/版面/图裁剪需要时间）、`--bibliography`（额外测 BibTeX/RIS/CSL 导入去重；默认关闭以保持演示库干净，创建的条目会被清理）、`--lifecycle-paper`。

## 输出（唯一允许写入的 reports 文件）

- `reports/test-results.json`：环境 + 逐 case（case_id/输入/期望/实际/断言/pass|fail|not_run/耗时/证据）+ summary；
- `reports/import-result.json`：导入请求、作业、fixture→生产 id 映射、逐篇 sha256/page_count 核对、图锚点；
- `reports/verify.md`：人读报告（环境、指标、失败明细与排查建议、not_run 清单、数据隔离、复现命令）。

中间产物在 `test/.artifacts/`（dry-run.json、library-map.json、search-summary.json、annotations-map.json、annotations-result.json、lifecycle-result.json、toggle-state.json）。

## 插件开关（由 Lead 执行真实开关）

脚本没有修改 profile 的权限，开关分阶段取证：

```bash
# a) 启用状态基线（记录 library id 快照，供后续“数据保留/未重复注册”对比）
node pappers-hall-plugin/test/toggle.mjs --phase after-enable --note "baseline"

# b) Lead 用 plugin_manager 停用插件；若有重启，把动作记录成 evidence.json：
#    {"phase":"after-disable","actor":"lead","at":"...","actions":[{"tool":"plugin_manager","args":{...},"result":"applied"}],"restarted":true,"hostTools":[...]}
node pappers-hall-plugin/test/toggle.mjs --phase after-disable --evidence /tmp/disable-evidence.json

# c) Lead 重新启用（可重启后）再取证
node pappers-hall-plugin/test/toggle.mjs --phase after-enable --note "re-enabled" --host-tools-json /tmp/tools-after.json

# d) 汇总进 reports/test-results.json
node pappers-hall-plugin/test/run-tests.mjs --only toggle
```

脚本可自动断言：`GET /pappers-hall/` 插件标记、`POST /pappers-hall/api` 是否返回插件 JSON envelope（未挂载时落到 SPA fallback：GET 404 / POST 405，均视为“插件面消失”）、原生 GUI 静态资源 200、前后两次 enabled 快照的 library id 集合一致。Agent 工具注册/注销与侧栏 UI 截图无法从 HTTP 观测，标 `not_run`，需 Lead 提供 `--host-tools-json` 证据或人工截图。

## 判定口径

- 60 条题：`Top5` 命中 `expected_paper_ids` 为通过门槛，`Top1` 只记录指标；绝不在运行后改写期望。
- 图检索题：`figures.search` 必须命中「同一论文 + 1-based 物理页 + 图号（`Fig. 1`≈`Figure 1`）」，且返回的裁切图是可访问的真实 PNG；`channels` 必须显式声明 image/vector 通道 `degraded` 及原因。
- `figure_recall_and_understanding` 与 `visual_understanding.json` 的模型读图部分无法由 HTTP 证明，脚本只验证「真实页面图可产生、锚点图存在」，模型答案部分 `not_run` 并给出人工步骤。
- 批注：`origin` 必须为 `test_note`、页级定位（`rect:null`）、绑定文档 sha256；删除后列表与所有检索都不得再返回该 id。
- 生命周期：删除后 list/search/figure search 立即排除、资产 404、reader/tool 读取被拒（tool 部分 not_run）；恢复返回严格递增 epoch，重复 operationId 返回相同结果。
- 所有 not_run 都写原因，不伪装通过；失败保留原始断言与 actual。

## v0.3 API 验收（`test/v03.mjs`）

v0.3 增量契约（`docs/CONTRACT-v03.md` §1）的独立套件，风格与 `v02.mjs` 一致：

```bash
node pappers-hall-plugin/test/v03.mjs --dry-run   # 只打印 37 条用例计划 + 环境探测，不写数据
node pappers-hall-plugin/test/v03.mjs             # 真实运行（v0.3 host 重载后；0.2.x 会被 ENV gate 拒绝）
```

- 覆盖：期刊指标（`library.get.metrics` / `metrics.update` 手动 / `metrics.refresh` 显式联网或如实失败 / 禁止把 OpenAlex 2yr mean citedness 当 JCR IF）、`operations.recent`+`undo` 闭环（annotation/setRead/tags/delete/幂等/not_undoable）、`library.duplicates`+`merge`（含 undo）、`citation.format` 5 样式 + `citation.key` + `export.annotations` + `export.bibtex` 回归、AI fast 模式（fast/reasoningEffort/quickTranslate/ai.ask mode/cache 键不混/deep 耗时实测）、`library.list` reading 过滤与 citations/impactFactor 排序。
- AI/网络能力成功与如实失败都算 pass（失败必须带 reason/provenance，且不得伪造译文/指标）；无法观测的细分行为标 `not_run` 并写原因。
- 合并用例使用的重复条目是**运行时临时 fixture**：复制 C01 PDF 并追加字节改 sha256 后 `library.import`（复用 manifest 标题/DOI），套件结束前 `library.delete`+`library.purge` 清理（同时充当 not_undoable 证据）；不会 purge 用户数据。运行前后对比 papers/annotations/figures/trash/tags/collections 计数，数据保留断言见 `REF.data.preserved`。
- 输出：`reports/v03-api-results.json`（机读）；人读章节由验收者追加到 `reports/verify.md`。

## v0.4 API 验收（`test/v04.mjs`）

v0.4 增量契约（`docs/CONTRACT-v04.md` §1/§2/§5）的独立套件：

```bash
node pappers-hall-plugin/test/v04.mjs --dry-run   # 34 条用例计划 + 只读环境探测，不写数据
node pappers-hall-plugin/test/v04.mjs             # v0.4 重载后真实运行（0.3.x 被 ENV gate 拒绝）
```

- 覆盖：翻译引擎链（`translate.providers` 结构与 engine 元数据诚实性：google=free+**unofficial**、mymemory=free、llm=非 free）、`translate.settings` GET/SET/非法值/fallback、`translate.text` 的 google/mymemory/llm/auto 真实结果与 provider 级缓存隔离、未配置 libretranslate 的如实失败/降级、`translate.detect`、`translate.blocks` 逐段 provider/status/cached/provenance 与整页耗时；`discover.feed` 结构/统计一致/分区字段/最近批注图/分类计数/延迟；`annotations.feed` 倒序/筛选/分页。
- 网络能力成功与如实失败都算 pass（失败必须 status+reason 且无编造译文）；engine 元数据若把非官方接口冒充官方则 fail。
- 数据安全：运行前捕获 `translate.settings` 并在 finally 恢复；测试批注（`origin:'test_note'`，green）在 finally 删除；不 purge 用户数据；翻译缓存条目按契约保留（报告记录）。
- 回归证据复用：`reports/v03-api-results.json`（38/38）、`reports/v02-api-results.json`（26/26）、`reports/v03-lifecycle-run.json`（13 例 12 pass/0 fail/1 not_run），本套件只读校验，不重跑以免覆盖。
- 输出：`reports/v04-api-results.json`；人读章节追加到 `reports/verify.md`。

## v0.5 API 验收（`test/v05.mjs`）

v0.5 增量契约（`docs/CONTRACT-v05.md` §1/§2/§4）的独立套件：

```bash
node pappers-hall-plugin/test/v05.mjs --dry-run   # 43 条用例计划 + 只读环境探测（含本机 embedding 环境检查），不写数据
node pappers-hall-plugin/test/v05.mjs             # v0.5 重载后真实运行（0.4.x 被 ENV gate 拒绝）
```

- FOLDERS：`library.folders.tree` 结构/嵌套/直接+后代 count；create（根/子/孙）/update（重命名/改色/移动）/移动进自身后代被拒/field 只读/delete 子夹上移/assign 多对多/undo 闭环；`library.list` 的 `folderId`（含后代）/`tags`（AND）/`favorite`/`collectionId` 等价过滤；`discover.feed` 文件夹树一致性。
- FAVORITES：`library.setFavorite`/`library.get.favorite`/`library.list favorite`/`discover.feed stats.favorite+favorite section`/undo。
- SEARCH FILTERS：`search.query filters {folderId,tags,favorite}` 组合（含顶层同名兼容）、结果全部满足过滤、channels 诚实（vector ok→latency/k；unavailable→reason）。
- EMBEDDING（真实向量）：`embedding.status`（model=paraphrase-multilingual-MiniLM-L12-v2/384d/indexVersion）、等待挂载索引或触发 `embedding.index`、counts（papers/pages/figures/annotations）、force 幂等、vector channel（status ok + reasons `vector_similarity`）、4 条契约 §2.3 中文语义查询 Top5 + 规则相关性、纯 FTS 对比（仅在 API 支持关闭向量通道时；否则如实 not_run）、`diagnostics.embedding`、scope=pages/annotations；worker 不可用时只接受 unavailable+reason。
- 数据安全：测试文件夹全部删除、测试标签移除、收藏恢复到运行前基线；不删除用户论文/批注；embedding 索引是真实功能数据、保留并记录。回归只读复用 v04/v03/v02/lifecycle 结果文件。
- 输出：`reports/v05-api-results.json`；人读章节追加到 `reports/verify.md`。

## v0.6 API 验收（`test/v06.mjs` + `test/v06-tools.mjs`）

v0.6 增量契约（`docs/CONTRACT-v06.md` §1–§3）的独立套件：

```bash
node pappers-hall-plugin/test/v06.mjs --dry-run   # 32 条用例计划 + 只读探测，不写数据
node pappers-hall-plugin/test/v06.mjs             # v0.6 重载后真实运行（0.5.x 被 ENV gate 拒绝）
```

- MIGRATION：`diagnostics.schemaVersion=6`；`library.collections.list`/`library.folders.tree` 不再有 `kind:'field'`（全 folder）；原 5 个领域名仍在且为普通可编辑 folder；独立测试夹验证 delete 只删夹不删论文、计数一致（**不重命名/删除真实 5 个原领域文件夹**）。
- CLASSIFY：`library.classify {paperIds, apply:false}` → suggestions（assign/create、score、newFolderName）；阈值 0.32 语义（低于阈值必须 create）；`apply:true` 归类/新建夹 + membership 可查 + journal undo；embedding 可用时 unavailable 分支记 not_run（环境不允许破坏）。
- IMPORT：`library.import` 使用 devkit C02 的字节修改副本 → `classification`（applied folder/created/confidence）并验证论文进入该夹；重复导入 duplicate 不阻塞、无效路径 errors 不阻塞、前后论文数不变；fixture 结束后 delete+purge。
- TOOLS：`diagnostics.agent.tools` 含 `papers_overview/papers_folders/papers_classify/papers_import_file/papers_related`，`diagnostics.agent.promptSection=true`。工具行为由 `test/v06-tools.mjs` 在 **隔离 DB 副本** 上实测：`sqlite3 .backup` 复制真实库到临时目录 + 假 Cordis 上下文 `applyHost` 注册真实工具后直接 `execute()`——预览不写库（paper 数不变）、confirm 导入 +1 且自动归类、无效路径 invalid、folders 全 action、related 排除自身、overview 结构；活库只读校验前后论文数不变。
- 回归只读复用 v05 42/43、v04 34/34、v02 26/26、lifecycle 12/0/1、v03 口径（历史 38/38 + v0.4 路由变更 3 例已知变化 + 现场 llm-fast probe）。
- 数据安全：测试夹全删、classify 测试论文成员关系恢复基线、import fixture delete+purge、不 purge 用户数据、不重命名/删除原领域文件夹、embedding 索引保留；基线 30 篇/21 批注/346 图前后一致。
- 输出：`reports/v06-api-results.json`；人读章节追加到 `reports/verify.md`。

## v0.7 API 验收（`test/v07.mjs`）

v0.7 小版本（`docs/CONTRACT-v07.md`：状态可解释 + 侧栏筛选修复）的数据面套件：

```bash
node pappers-hall-plugin/test/v07.mjs --dry-run   # 24 条用例计划 + 只读探测，不写数据
node pappers-hall-plugin/test/v07.mjs             # v0.7 重载后真实运行（0.6.x 被 ENV gate 拒绝）
```

- STATUS（动态降级）：`status.degraded` 不再静态——embedding ready 时**不得**出现 `vector`（出现即 fail）；`index.channels.vector='ready'`；`diagnostics.capabilities.vector='ready'`；免费翻译链可用时 `capabilities.translation='ready'` 且 degraded 无 `translation`（可选 `translationProviders`）+ 现场 `translate.text` 探针；`ocr` 若保留需面向用户文案（含“未安装/扫描”）且 `severity:'optional'`/`optional:true`；fts 正常；degraded/channels/capabilities 一致性校验。
- FILTERS（侧栏筛选的数据面）：`annotations.feed {folderId}` 只返回该文件夹（含后代）论文的批注且条数 ≤ 无过滤；`{tags:[推理]}` 全命中、`['推理','LLM Agent']` AND 收窄、无效标签 0 条；`{query}` 全匹配；`folderId+tags+colors` 组合全满足；独立临时 root/child 文件夹验证**含后代**；`library.list` 的 folderId/tags/favorite 组合回归（收藏切换后恢复基线）。
- REF：v0.6 31/32(1 not_run) + 工具 harness 8/8、v0.5 42/43、v0.4 34/34、v0.2 26/26、lifecycle 12/0/1、v0.3 口径（历史 38/38 + v0.4 路由变更 3 例 + llm-fast probe）。
- DATA：30 篇/21 批注/346 图基线前后一致；**不动真实 5 个文件夹**（后代筛选用自建临时夹，结束后删除）；不 purge 用户数据；收藏恢复基线；embedding 索引保留。
- GUI：右侧侧栏选文件夹/标签/收藏后列表更新、状态栏中文文案+tooltip、清空筛选，由 Lead 做真实浏览器验收（本套件只测 API 数据面）。
- 输出：`reports/v07-api-results.json`；人读章节追加到 `reports/verify.md`。

## 数据隔离

测试导入的 30 篇论文、10 条批注、2 个显式已读标记、生命周期操作均记录在 `reports/import-result.json`、`test/.artifacts/annotations-map.json` 与 `reports/test-results.json`。脚本不删除用户数据；如需清理只按记录的测试 id 使用 `library.purge`。数据目录为插件私有 `~/.dsh/pappers-hall`（由 `status.storage.dataDir` 记录），不写入 profile、工作区、devkit 或 PDF。
