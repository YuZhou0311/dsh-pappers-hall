# Pappers-Hall v0.13 契约（2026-11-11 下午：翻译质量/快速模式 + AI 面板 Markdown 对话化）

用户反馈（截图）：快速翻译质量一般、延迟高（“AI-deepseek-v4.1-flash · 11.3 s”），快速工具似乎不生效；阅读器 AI 面板回答把 `##`、`**`、列表等 Markdown 原样显示，文字根本看不了——“对话界面能否沿用目前 DSH 的对话界面支持”。

## 1. 快速翻译（免费引擎优先，真正快）
- Host `translate.text` 新增 `quick:true`（等价 `freeOnly:true`）：
  * 只用免费引擎链（google → mymemory；不含 LLM），整体 deadline ≤ 6s；返回 `{status, translation, provider, engine, latencyMs, fast:true, freeOnly:true, mode:'free', suggestAi?:true, reason?}`。
  * 免费引擎全部不可用/失败时：`status:'unavailable'`，`suggestAi:true`，reason 面向用户（如“免费引擎暂不可用（限流/网络），可改用 AI 精译”），**绝不静默回退到 11s 的 LLM**。
  * 非 quick 的 `translate.text` / `ai.quickTranslate` 行为保持（AI 精译），但 `ai.quickTranslate` fast 模式须真实使用最低 reasoning effort、deadline≤9s、maxTokens 足够完整（不截断）。
- 翻译质量（AI 精译）：
  * `ai.translateText` 的 system/prompt 改为学术论文选段规则：术语准确、保留 ΔY/CA/GGCMs 等符号缩写与引用编号、逐句完整、不省略、不解释、不添加原文没有的内容；可选 `context:{paperTitle, section, page}` 供术语参考。
  * 客户端把 paperTitle/page/选中上下文带入 quick/AI 精译请求。
- 客户端：
  * 「快速翻译」只调 `translate.text {quick:true}`；卡片显示真实引擎（Google/MyMemory）+ 延迟 + “免费快速”标签；不可用时显示原因与「用 AI 精译」按钮。
  * 「AI 精译」仍用 LLM（fast refine），显示“AI 精译”与延迟；不伪装其耗时。
  * 翻译卡文本完整显示（不截断），复制完整译文。

## 2. AI 面板 Markdown + DSH 对话观感
- 新增 reader 内 Markdown 渲染（无新依赖，React 节点安全渲染）：标题 1–6、粗体/斜体、行内代码、代码块、无序/有序列表、引用块、分隔线、链接、简单表格、段落/换行。
- AI 回答区按 DSH 对话样式排版：assistant 消息带角色行/模型与时延元信息，Markdown 标题/列表/代码有合适字号与间距，最大阅读宽度，代码块可横向滚动，引用块左边线；用户提问保持右侧气泡；底部模式切换（快速/深度）、来源 chips、复制/引用操作保留。
- 绝不把 `##`、`**` 等原始标记直接展示给用户；纯文本回答仍正常显示。

## 3. 验收
- Host：quick 真实调用延迟实测（目标 <6s；失败时 suggestAi+清晰 reason，不喷 LLM）；AI 精译 prompt 改进后输出完整、术语/符号保留；selftest 扩展 PASS。
- Client：真实 GUI 快速翻译卡（免费引擎/latency/引擎名）、AI 精译卡、AI 面板 Markdown 渲染（标题/列表/粗体/代码）、无 JS 错误；截图。
- 回归：不破坏 v0.11/v0.12/历史 API；数据 30/21/346/5 夹不变。
