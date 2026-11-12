# Pappers-Hall 内部实现契约 (v0.1, 2026-11-10)

本文件是团队并行开发的唯一接口契约。**Host 与 Client 都以本文件为准，谁先实现谁先改本文件并通知 Lead。**

包名：`dsh-pappers-hall`。安装位置：当前工作区目录 `/Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin/`（通过 `plugin_manager install_bundle` 安装到 desktop profile）。
运行数据目录：`$DSH_HOME/pappers-hall/`（默认 `/Users/zhouyu/.dsh/pappers-hall/`，可用 config.dataDir 覆盖），与 profile、工作项目完全隔离。

## 0 分工与写作用域（避免冲突）

| 成员 | 写作用域 | 内容 |
| --- | --- | --- |
| lead | 根 `index.js`、`cordis.patch.yml`、`package.json`、`docs/`、`README.md`、`.gitignore` | Host 装配、插件生命周期/开关、安装与最终验证、交付文档 |
| host-engineer | `host/**`（不含 `host/README.md`） | domain/storage/ingest/search/jobs/figures/tools/api |
| client-engineer | `client.js`、`locale/**`、`icon.svg` | Web Client 全部界面（Smoke 版：单文件） |
| papers-scout | `../pappers_hall_devkit_lite/papers/pdf/**`、`../pappers_hall_devkit_lite/papers/inventory.json`、`reports/papers.md` | 下载、哈希核对、PDF 清单 |
| verifier | `test/**`、`reports/test-results.json`、`reports/verify.md` | 验收脚本与结果 |

冲突时以“先完成者”为准，改动别人的文件前先在团队任务里说明。

## 1 插件形态

- Host-only bundle 形态 + Client 半包：`package.json` 中 `dsh.bundle.patch` 与 `dsh.client` 同时声明。
- `cordis.patch.yml` 只有一行 insert：`id: pappers-hall`, `name: dsh-pappers-hall`, `config: { dataDir?: string }`。
- Host `index.js` 导出 `name`、`inject`、`Config`、`apply(ctx, config)`。
  - `inject = ['tools']`；其它服务一律用 `ctx.inject(['webServer','attachments','translator','subprocess'], cb)` 方式可选接入，缺失时降级而不是抛错。
  - 所有注册都必须包在 `ctx.effect(...)` 中并返回清理函数；停用后必须释放定时器、HTTP 路由、SQLite 连接和工具注册。
  - **停用后不得留下任何全局副作用**：不注册 slot、不写 session、不改 profile 配置、不残留 job 定时器（数据库文件保留，属用户数据）。
- Client `client.js` 是 `window.__ModuleLoader__.load({ id: 'dsh-pappers-hall', factory(require) {...} })` 形式的单文件；只允许 `require('react')`，不加载任何 DSH Client 包。所有 UI 文本经 `ctx.locale.register`（命名空间 `pappers-hall`）与 `t()`。
- UI 入口：
  1. `sidebar.panellist`（list，root）注册 `id: 'pappers-hall'`，`order: 20`，`label: () => t('panel.title')`，组件渲染 24px 图标；点击由 DSH 自动切到 main 面板。
  2. `main`（keyed，root）注册 `key: 'pappers-hall'`，渲染论文中心整页（含阅读器）。
  3. `ctx.sidebarRightTabs.register({ id: 'dsh-pappers-hall/drawer', kind: 'pappers-hall', title: () => t('drawer.title'), multiple: false })`；body 注册 `sidebar.right.pane.tab`，`key: 'dsh-pappers-hall/drawer'`。打开方式 `ctx.sidebarRight.openTab('pappers-hall')`。
     在 `conversation.session.header.corner` 加一个“论文抽屉”按钮（单组件，无 session 时自动不渲染）。
  4. `conversation.input.dock`（scope: session）注册 `id: 'pappers-hall-dock'`：显示待加入草稿的材料组，按钮用注入的 `inputActions.captureInsertion()/insertText(text, span)` 插入；**只改草稿，不提交**。
- 视觉：只用 `--dsw-alias-*` 主题 token（可用到的名字见 `cordis_inspect_query Theme.listTokens`），不硬编码亮/暗色背景；字号/间距沿用宿主。

## 2 Host ↔ Client 数据通道

Client 无 `host.call`（那是动态插件的能力）。采用**同源 HTTP JSON API**：

- Client 端 `api(method, params)` → `fetch('/pappers-hall/api', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({method, params})})`，返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`；网络错误/404 时 UI 显示“插件未运行/已停用”的降级状态。
- Host 通过 `ctx.inject(['webServer'], ...)` 注册：
  - `{ kind:'prefix', path:'/pappers-hall/', handler(req,res) }`，`req.method==='POST' && pathname==='/pappers-hall/api'` 时读 JSON body；其它 GET 走静态资源路由（见下）。`req/res` 为 Node `IncomingMessage/ServerResponse`。同源 Cookie 由浏览器自带。
  - 文件：`GET /pappers-hall/page/<paperId>/<page>.png?width=1400`、`GET /pappers-hall/figure/<figureId>.png?width=900`、`GET /pappers-hall/thumb/<paperId>.png`、`GET /pappers-hall/pdf/<paperId>`（返回原始 PDF bytes）。全部 `Cache-Control: private, max-age=3600`，路径参数必须做白名单/数字校验，禁止路径穿越。
- 未装/停用插件时 `/pappers-hall/*` 不再由插件应答（实测 POST 被 SPA fallback 接走返回 405，资产路由 404；以“插件面消失”为准），DSH 原生功能不受影响。

### 2.1 API 方法（请求 `{method, params}`，全部可被 test harness 直接调用）

约定：ID 均为字符串。`paperId` 形如 `ph-<12hex>`；`versionId` 形如 `pv-<10hex>`；分页 `{offset=0, limit=50}`，返回 `{total, offset, limit, items}`。错误码：`not_found | invalid | conflict | unavailable | degraded | internal`。

**只读**
- `status` → `{plugin:{id,version,hostVersion,enabled}, storage:{dataDir,dbPath,dbBytes}, counts:{papers,trash,annotations,notes,figures,jobsPending}, index:{channels:{fts:'ready'|'degraded',vector:'unavailable'}, paperCount}, degraded:[{channel,reason}], jobs:{...}}`
- `library.list` params `{query?, field?, state?:'active'|'trash'|'all', read?, annotated?, sort?:'recent'|'title'|'added', offset?, limit?}` → items `PaperSummary`
- `library.get` `{id}` → `PaperDetail`（含 `sources[]`、`versions[]`、`metadataDiff[]`、`availableFields`）
- `search.query` `{q, scope?:'library'|'papers'|'body'|'notes'|'figures'|'annotations', filters?:{read?,annotated?,field?,yearFrom?,trash?}, offset?, limit?}` → `{items:[SearchHit], channels:[{name,status:'ok'|'degraded',note}], tookMs}`
  - `SearchHit = {kind:'paper'|'figure'|'annotation'|'note', paperId, title, titleZh?, page?, figureLabel?, snippet, reasons:[string], score}`
- `reader.open` `{id, page?}` → `{paper, version:{id,sha256,pageCount,sourceVersion}, pages:[{page,imageUrl,width,height,textChars}], currentPage, toc:[{title,page}], figures:[FigureRef], annotations:[Annotation], notes:[Note]}`
- `reader.page` `{id, page}` → `{page, width, height, imageUrl, text, blocks:[...]}`（text 为 pdftotext -layout 结果；blocks 可选）
- `annotations.list` `{paperId, versionId?}` → `[Annotation]`
- `figures.list` `{paperId}` → `[FigureRef]`
- `figures.search` `{q?, imageBase64?, mode?:'text'|'image'|'auto', limit?}` → `{items:[{figure,paper,page,reasons,score}], channels}`；无视觉嵌入时 `channels` 必须显式给出 `image: 'degraded'` 与原因，不得伪造相似度。
- `jobs.list` → `{items:[Job], summary}`
- `export.bibtex|export.csl|export.notes|export.locations` `{ids}` → `{filename, mediaType, content}`
- `diagnostics` → `{versions:[{name,version,license}], host:{dsh,node,platform}, capabilities:{pdfText,pageRender,figureCrop,dhash,fts,vector,ocr,translation}, dataDir, schemaVersion}`

**写入**（全部支持 `operationId` 幂等键，重复调用返回相同结果）
- `library.import` `{paths?:string[], uploads?:[{name,base64}], field?, format?:'pdf'|'bibtex'|'ris'|'csljson', operationId}` → `{jobId, accepted, duplicates:[{path,paperId,reason}], errors:[{path,code,message}]}`
- `library.update` `{id, patch:{titleZh?, displayTitle?, field?, tags?, authors?, venue?, year?, doi?, note?}, expectedRevision?, operationId}` → `{paper, revision}`
- `library.delete` `{ids, operationId}` → `{results:[{id,ok,state}], trashCount}`（软删→回收站；立即退出检索）
- `library.restore` `{ids, operationId}` → `{results, epoch}`（新生命周期 epoch）
- `library.purge` `{ids, operationId}` → `{results}`（物理删除；不可恢复）
- `annotations.create` `{paperId, versionId, page, quote?, text, rect?:{x,y,w,h}|null, color?, origin:'user_note'|'test_note'|'ai_explanation', operationId?}` → `{annotation}`
- `annotations.update|delete` `{id, ...}`
- `notes.create` `{paperId?, sourceRefs:[{kind,id,version?}], text, origin:'user_note'|'ai_explanation', title?, operationId}` → `{note}`
- `notes.delete` `{id}`
- `translate.title` `{ids, target:'zh'}` → `{results:[{id,titleZh,status:'translated'|'unavailable'}]}`（宿主无 translator 服务时返回 `unavailable`，不得伪造译文；已有 titleZh 来自书目时标 `from_metadata`）
- `translate.text` `{paperId, page, text?, target:'zh'}` → `{translation,status,provenance:{model?,sourceHash?}}`（同上，缺失时 unavailable）
- `references.commit` `{sessionId?, items:[{kind:'paper'|'figure'|'annotation'|'note', id, page?}], operationId}` → `{bundleId, display, token, materials:[...], scope:'reference_bundle'}`
- `references.resolve` `{bundleId, sessionId?}` → `{bundle, valid:[...], invalid:[...]}`（工具读取前必须校验）
- `jobs.pause|jobs.resume|jobs.retry {id}|jobs.cancel {id}` → `{job}`

**对象**
```
PaperSummary = {id,title,titleZh,displayTitle,authors:[{given,family}|{literal}],year,venue,field,fieldId,state:'active'|'trash',
  read:boolean,annotationCount,figureCount,pageCount,sha256,sourceVersion,license,addedAt,updatedAt,thumbnailUrl,
  processing:{state:'ready'|'pending'|'partial'|'failed',channels:{text,figures,index}},revision}
PaperDetail = PaperSummary & {abstract?,doi?,arxivId?,containerTitle?,publicationDate?,volume?,issue?,pages?,articleNumber?,
  sources:[{kind,url,retrievedAt}], versions:[{id,sha256,bytes,pageCount,sourceVersion,createdAt}], metadataDiff:[{field,manifestValue,pdfValue,status}], tags:[string], notes:[Note]}
FigureRef = {id,paperId,label,caption,page,width,height,imageUrl,thumbnailUrl,dhash,source:'caption'|'manual'|'user'}
Annotation = {id,paperId,versionId,page,quote,text,rect,color,origin,createdAt,revision,state:'active'|'trash'}
Note = {id,paperId?,title?,text,origin,sourceRefs,createdAt,state}
SearchHit = {kind,id,paperId,title,titleZh,page?,figureLabel?,snippet,reasons:[string],score}
Job = {id,kind,state:'queued'|'running'|'paused'|'succeeded'|'failed'|'cancelled'|'retry_wait',attempts,progress:{done,total,unit},error?,createdAt,updatedAt,idempotencyKey}
```

## 3 Agent 工具（Host 注册，前缀 `papers_`）

工具统一返回**纯 JSON 文本**（`papers_get_figure` 额外返回真实 ImageBlock）。来源范围：`scope='reference_bundle'` 时必须传 `bundle_id`，Host 校验 bundle 绑定的 session 与当前 Agent session 一致（`ctx.agents`/`ctx.sessions` 校验），失效/删除来源立即返回 `unavailable`。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `papers_search` | `{query, scope:'reference_bundle'|'library', bundle_id?, kinds?, limit?}` | `{items:[SearchHit], channels, scope}` |
| `papers_get_passage` | `{paper_id, page?, quote?, bundle_id?}` | `{paper:{id,title,titleZh}, page, text, depth:'fulltext'|'abstract'|'metadata_only', location:{page}, source_sha256}` |
| `papers_get_figure` | `{figure_id, bundle_id?}` 或 `{paper_id, page, bundle_id?}` | JSON 描述 + ImageBlock（图片经 `ctx.attachments.saveImage` + `output.render({type:'image',attachment:ref})`） |
| `papers_translate` | `{paper_id?, text?, page?, target:'zh'}` | `{translation, status, provenance}`（无 translator 服务时 status:'unavailable'） |
| `papers_propose_changes` | `{operations:[{op:'set_title_zh'|'add_tag'|'remove_tag'|'create_annotation'|'save_note', ...}]}` | `{proposal_id, operations:[{index,ok,conflict?}], preview}`（只登记不应用） |
| `papers_apply_changes` | `{proposal_id, operation_id}` | `{results:[...], undo_token}`（幂等） |
| `papers_cite` | `{paper_ids, style:'apa'|'bibtex'|'gbt7714'}` | `{citations:[{paper_id,text}], warnings}` |
| `papers_index_status` | `{}` | `{counts, index, jobs, degraded}` |

工具名/描述用英文（模型可读），参数用 JSON Schema。工具注册必须 `ctx.effect(() => ctx.tools.register(...))`。

## 4 数据与一致性

- SQLite（`node:sqlite` 的 `DatabaseSync`，WAL 模式，`user_version` 迁移）。FTS5 可用性启动时探测；不可用时派生 `LIKE` 通道并标 degraded。
- 表：`papers`、`paper_versions`、`paper_pages`、`figures`、`annotations`、`notes`、`tags`、`paper_tags`、`sources`、`jobs`、`job_steps`、`bundles`、`bundle_items`、`settings`、`events`；FTS：`papers_fts`、`pages_fts`、`figures_fts`、`annotations_fts`、`notes_fts`。
- 生命周期：`papers.state active|trash`，`papers.epoch` 单调递增；删除时 `epoch++`，旧清理任务写入前比对 `epoch`。
- 检索/工具读取必须 `WHERE state='active'`（回收站不可被检索/工具读取）；恢复给新 epoch。
- 后台队列：`jobs` 表 + 进程内 worker（`ctx.timer.interval`，1s 轮询）；幂等键唯一索引；租约 `lease_until`；重试 `attempts/max_attempts` 指数退避；检查点 `job_steps`。插件卸载：停 worker、abort 当前任务；启动时恢复 `running` 且租约过期的任务。
- 增量：导入/编辑写 job；`jobs.reconcile` 只修缺项；远端删除仅在完整扫描成功才判定，本项目不做外部扫描。

## 5 PDF 处理（poppler，已确认可用）

- `pdfinfo -f 1 -l 1 file.pdf` 取页数与信息；`pdftotext -layout -f N -l N` 取每页文本（页间 `\f`）。
- 页面图：`pdftoppm -png -r 110 -f N -l N`；带裁剪 `-x -y -W -H`（单位像素，基于 PDF 页面坐标×渲染比例）。
- 图定位：`pdftotext -bbox-layout` 解析 `<word xMin..>`；找 `Figure|Fig\.|Table` 题注行，将图注上方区域（与上一图注/段落边界之间，至少 30% 页高）作为候选 bbox；生成 figure 行（label、caption、page、bbox、PNG 缓存、dHash）。找不到时 figure 状态 `partial`，界面显示降级，不得伪造。
- dHash：页面/图裁切转 9×8 灰度（`pdftoppm -gray -scale-to-x 9 -scale-to-y 8`），比较汉明距离。图像检索用 dHash 近重复 + 图注 FTS，分别标 `visual_near_duplicate` / `caption_match` 原因。
- 所有外部命令走 `ctx.subprocess.spawn`（若可用）或 `node:child_process`；超时 120s；失败记录错误不阻塞其它页（`partial`）。

## 6 测试种子与开发数据

- 测试库与用户库隔离：`config.testMode` 或 API `library.import {field:'__test__'}`；报告里必须区分。
- `tests/seed_annotations.json` 导入为 `origin:'test_note'`，不得计入真实阅读。
- 测试 PDF 从 `../pappers_hall_devkit_lite/papers/pdf/` 导入；manifest 校验以 `papers/manifest.json` 的 `sha256` 为准。

## 7 完成标准（Lead 验收）

1. `plugin_manager install_bundle` 成功（`application: applied`），插件详情显示标题/描述/图标。
2. 刷新 Web GUI 后：侧栏出现“论文中心”入口；打开为空态页面；导入 30 篇→出现卡片与真实页面图；搜索、阅读、批注、图搜、回收站恢复可用。
3. 普通对话右栏出现“论文”tab；多选→“引用到对话”→草稿出现材料（不自动发送）。
4. Agent 工具可见且能用：`papers_search`、`papers_get_passage`、`papers_get_figure`（真实 ImageBlock）、`papers_index_status`。
5. `plugin_manager set_plugin enabled:false` → 侧栏入口/工具/HTTP 路由消失；原生 DSH（对话、插件页、设置）无报错；重启后仍保持停用；再启用恢复且不重复注册；数据保留。
6. `test/run-tests.mjs` 输出 `reports/test-results.json`，区分 pass/fail/not_run。
