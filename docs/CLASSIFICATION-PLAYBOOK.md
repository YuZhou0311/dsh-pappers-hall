# 论文分类 Playbook（Agent 版，v0.16）

> 设计原则：**插件只提供基础工具，分类由 Agent 像人类图书管理员一样完成**。
> 向量相似度只是参考，不是规则，更不是决策者。

## 为什么不再提供“一键 AI 分类”

旧版 `papers_classify` 把“读论文 → 定主题 → 建夹 → 归类”封装成一次调用，并用
embedding 阈值直接决定结果。独立复核（`reports/v16-classification-stability.md`）证明它会在小样本上
给出虚高置信度（论文自己参与文件夹画像、上次分类写入的 field 再次参与 embedding），
并把“作物模拟”和“遥感”这类邻近主题强行切开（k=3 silhouette 为负）。
因此 v0.16 起：

- 导入**不再自动归类**（`library.import` 默认 `classification.status = "skipped"`）。
- 不再提供会直接改库的 `papers_classify` 工具。
- `papers_folder_hints` 只读返回 embedding 相似度，标注 `referenceOnly: true`。
- Agent 用基础工具自行完成分类，并在回答中给出分组理由。

## 基础工具（Agent 的“手和眼”）

| 工具 | 用途 |
| --- | --- |
| `papers_list` | 列论文：标题/作者/年份/期刊/标签/文件夹/已读/图与批注数 + 摘要节选；分页/按文件夹/关键词过滤 |
| `papers_get` | 读单篇：完整元数据、摘要、关键词、文件夹、图表清单、批注/笔记计数 |
| `papers_abstracts` | **快速读摘要**：支持单篇 `paperId` 和批量 `paperIds`（也可按文件夹/查询）；只返回标题/年份/期刊/文件夹/摘要；摘要不像摘要时自动从首页版式校正 |
| `papers_get_passage` | 读具体页原文（判断方法/领域/贡献时用） |
| `papers_get_figure` | 取真实图表图片（图注、页面） |
| `papers_folders` | 文件夹树/新建/重命名/删除/assign/unassign（每次操作可撤销） |
| `papers_update` | 改基础元数据（中文标题、作者、年份、DOI、摘要、关键词、标签、已读/进度） |
| `papers_annotate` / `papers_get_annotations` | 写/读批注 |
| `papers_import_file` | 预览/导入 PDF（导入后保持未分类） |
| `papers_cite` / `papers_translate` | 引用格式、翻译 |
| `papers_search` / `papers_related` | 全文/语义检索；`papers_related` 是内容近邻参考 |
| `papers_folder_hints` | **只读参考**：论文与现有文件夹画像的余弦相似度、margin、stable；不产生任何写操作 |

## 人类式分类流程（Agent 应按此执行）

1. **盘点**：`papers_folders tree` 看现有结构；`papers_abstracts`（单篇或批量）先快速读摘要，再用 `papers_list` 看完整元数据。
2. **阅读**：逐篇用 `papers_get`（必要时 `papers_get_passage` 读引言/方法/结论），写下一句话：
   *研究对象、方法、数据、要回答的问题*。不要只看标题关键词。
3. **找轴**：按用户的真实研究领域/任务/方法划分，而不是按期刊或论文标题。
   常见轴：领域（如农业系统/遥感）、任务（预测/决策/评测）、方法（LLM Agent/强化学习）。
4. **定分类**：
   - 顶层夹通常 **2–6 个**，名字是主题词（如「大语言模型与 Agent」「农业与地球观测」），
     不要用单篇论文名当文件夹名；
   - 只有一篇的夹子要谨慎：除非确实是用户明确的独立方向，否则并入更宽的夹；
   - 同级夹之间尽量互斥、覆盖全部论文，不建空夹；
   - 边界论文要说明“为什么放这里、备选是哪里”。
5. **参考向量，不做决定**：`papers_folder_hints` 看相似度/`margin/stable`；
   只在两个候选难分时作为 tie-breaker，且必须结合第 2 步的阅读结论。
   `stable=false` 或 `margin<0.08` 时不得据此归类。
6. **落地**：用 `papers_folders create/rename/assign/unassign` 执行；一次批量移动前先向用户说明方案；
   删除文件夹前必须确认。所有操作可撤销。
7. **复核**：重新 `papers_folders tree` + `papers_list` 检查：有无空夹、单篇夹、未分类论文；
   向用户报告每个夹的划分标准与边界论文处理。

## 导入后的默认行为

`papers_import_file confirm:true` 只把论文入库并抽取结构/图表/索引，**不建文件夹**。
导入完成后 Agent 应告诉用户：“已导入，目前未分类；我可以读一遍并给出归类方案”。

## 例外

用户明确要求“按向量相似度自动分”时，才可以用 `papers_folder_hints` 的结果批量建议，
但仍要在回答里标明这是相似度结果、并让用户确认后再用 `papers_folders` 落地。
