# Pappers-Hall v0.11 契约（2026-11-11 下午：设置中心 + 模型下载/安装渠道）

用户反馈：OCR 等需要下载模型的能力要开放下载/安装渠道（含索引、embedding），用户能在平台设置里选择安装并开启；现在没有设置按钮，功能也没进设置。

## 1. 可见设置入口
- 论文中心顶部工具栏右侧、对话右侧论文抽屉标题栏、阅读器顶栏：齿轮「设置」按钮（aria-label 设置），打开插件设置面板。
- 左侧栏「Pappers-Hall」区域增加「设置」项（可选，但三处入口至少一处始终可见）。
- 设置面板为居中大弹窗（宽 min(960px,92vw)，高 min(720px,88vh)），不遮死主界面、可滚动、Esc/关闭按钮关闭，无元素重叠。

## 2. Host API（全部经 /pappers-hall/api）
- `settings.get` → `{features, models, translation, index, diagnostics}`：
  - features: `{vectorSearch:boolean, ocr:boolean, freeTranslation:boolean, autoIndex:boolean}`
  - models.embedding: `{kind:'embedding', installed, available, enabled, configured, version, model, dims, sizeBytes, installable:true, supported:true, job:{id,state,progress...}|null, reason, setupScript}`
  - models.ocr: `{kind:'ocr', installed, available, enabled, engine:'rapidocr-onnxruntime', version, sizeBytes, installable:true, supported:true, job, reason, scanPages}`
  - translation: `{providers:[{id:'google'|'mymemory'|'llm', label, free, enabled, available, configured}], fallbackEnabled, order}`
  - index: 现有 `status.index` + `embedding.status.counts/sync`
  - diagnostics: version/dataDir/counts/capabilities（不泄露密钥）
- `settings.update {patch:{features?, translation:{providers?,fallbackEnabled?}}, operationId}` → 持久化（settings 表），返回 `settings.get`；非法键忽略并报告 `applied` 列表。
- `models.install {kind:'embedding'|'ocr', operationId}` → `{job, model}`；后台 job `kind:'model.install'`，事件写 jobs 日志：embedding 调 `scripts/setup-embedding.sh`（venv+torch+模型下载到 ~/.dsh/pappers-hall/models），OCR 建 `~/.dsh/pappers-hall/ocr/venv` 并安装 `rapidocr-onnxruntime`（模型随包，下载走 pip）；安装完成自动刷新状态；失败写 job.error_message，不破坏已有能力。
- `models.cancel {kind}` → 取消安装 job。
- `models.rebuildIndex {operationId}` → 复用 embedding.index job。
- `ocr.index {ids?, force?, operationId}` → 扫描版页面 OCR 索引 job（仅当 OCR 可用且开启）；结果 `{job}`；status 增加 `ocr: {available, enabled, pages, indexedPages}`。
- `translation.test {provider?, text?}` → `{ok, provider, translated, latencyMs, reason?}`（真实调用，不伪造）。
- 后端写操作一律 `operationId` 幂等；模型安装进度通过 `jobs.list` 轮询（客户端 1.5s）。

## 3. 功能开关语义
- vectorSearch=false：搜索不走向量通道；embedding 仍可安装；索引仍可重建；status 显示「向量检索已关闭」而非降级。
- ocr=false 或未安装：OCR 不处理任何页面；`diagnostics.capabilities.ocr='unavailable'`；设置中可安装/开启，开启后调用 ocr.index 才处理。
- freeTranslation/providers：影响 translate 链路（google/mymemory/llm），关闭后不调用；至少保留一个引擎，否则返回清晰错误。
- autoIndex：控制增量 embedding 同步（默认 true）。
- 不得伪报：安装失败/运行失败 must 显示真实 reason；模型大小/进度来自真实文件/日志。

## 4. 验收
- API：settings.get 全字段；settings.update 持久化并生效（vectorSearch off 后 search.query 不带 vector reasons）；translation.test 真调用；models.install 任务可启动/取消（真实安装视网络，至少状态/进度/错误真实）；OCR 安装状态真实（本机未装=installed:false）。
- GUI：三处入口可见；设置面板渲染无重叠；embedding/OCR 卡显示状态与安装按钮；点击安装进入进度状态；开关保存后刷新仍在；无 JS 错误；截图。
- 回归：不下调历史断言；数据 30/21/346/5 夹不变；不自动下载大型模型污染用户数据（用户主动点击才安装）。
