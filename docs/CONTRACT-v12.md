# Pappers-Hall v0.12 契约（2026-11-11 下午：引用到对话 UI 重设计）

用户反馈：“现在这个引用的UI丑爆了” —— 截图显示：
1. 输入框上方有浅绿色全宽横条：「只改草稿，不自动发送 / 论文 3 项材料 / 已加入 / ×」；
2. 输入框里插入的引用 token 是灰色方块 `⟦Pappers-Hall 3 篇论文 · bundle=bn-...⟧`。

## 目标
- Dock 变成精致紧凑的材料卡片；token 变成柔和主色 pill；不改任何引用/插入协议与 Agent 行为。

## 1. Dock（client/src/surfaces/dock.jsx + core/styles.css）
- 移除独立 caption 行；提示改卡片内小字/tooltip（“仅加入草稿，不自动发送”）。
- 每条 bundle 一段紧凑卡片：白底/毛玻璃、1px 细边、圆角 12、轻阴影、hover 提升；左图标（软色圆底）；主标题「Pappers-Hall · N 项材料」，次行按材料构成「2 篇论文 · 1 张图」；右侧：
  - 未加入：主按钮「加入草稿」；
  - 已加入：绿色淡底状态「已加入草稿」+ 撤销/×；
  - 展开 chevron；移除按钮 hover 才显眼。
- 展开清单：每行类型图标 + 标题（省略号）+ 页码/类型；hover 淡底；行尾移除；底部「清空全部」；列表 max-height 200px 内部滚动、行高约 34。
- 多条 bundle 纵向 8px；最多显示 3 条 +「还有 N 条」；无 pending 时 dock 不占空间（PDF 提示逻辑保留）。
- 动效：fade/slide-in、展开高度过渡；prefers-reduced-motion 关闭；只用 --dsw-alias-* token，类名前缀 ph-。

## 2. 已插入 token（protocol 不变）
- Host token 文本保持 `⟦Pappers-Hall N 篇论文 · bundle=bn-...⟧`；Agent/tools 依赖 `bundle=bn-`。
- 在 composer `[data-composer-input="true"]` 内用 MutationObserver 给含 `bundle=bn-` 的文本 span 加 class `ph-citetoken`（仅 class，不改文本）；Lexical 重渲染后自动重标；不拦截编辑/光标/撤销。
- CSS：柔和主色淡底 + 1px 主色淡边 + 圆角 8 + inline-flex + padding 1–2px 8px + font-size 12.5 + 小图标（mask/data-URI）；覆盖 DSH 默认灰底/等宽观感；hover tooltip「已引用 Pappers-Hall 材料」。

## 3. 验收
- `node client/build.mjs` PASS；真实 GUI：dock 紧凑卡片/展开/已加入/移除/清空；token 视觉为 pill；0 uncaught error；pending 逻辑（captureInsertion/insertText、autoInsert、retry、markAdded）不变；数据无变化。
