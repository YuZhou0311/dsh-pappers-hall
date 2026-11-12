# Pappers-Hall v0.2 设计规格（视觉与动效）

本文件约束 v0.2 的界面语言，保证 Zotero 式效率与 DSH 原生观感一致。实现只允许使用 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-font-*` / `--dsh-content-font-*` 设计 token 与 `color-mix()`；类名前缀 `ph-`；纯 CSS 动效；尊重 `prefers-reduced-motion`。

## 1 视觉基调

- **安静的书房，而不是仪表盘**：大面积 `--dsw-alias-bg-base`，分栏之间用 `border-l1/l2` 细分隔线，不使用重阴影堆叠；卡片悬浮时才出现 `--dsw-alias-elevation-*`。
- **一个强调色**：链接/主按钮用 `--dsw-alias-state-business-primary`；语义色只用于状态（成功/警告/错误/已读）。批注颜色固定 5 色（黄/绿/蓝/红/紫），用 `color-mix` 生成 14% 底 + 60% 边。
- **字体层级**：页面标题 20/28 semibold；分栏标题 13/20 medium；正文 13/22；元信息 12/18 `--dsw-alias-label-tertiary`；数字/ID 用等宽 `--dsw-font-markdown-code-block`。
- **密度**：条目行高 44px（紧凑模式 36px）；三栏宽度：左 232px（可折叠）、中 flex、右 340px（可收起/可拖拽 300–480）。阅读器缩略图栏 132px。
- **圆角**：面板 12 (`--dsw-radius-lg`)；行/按钮 8 (`--dsw-radius-md`)；批注 4；胶囊 999。

## 2 关键布局

### 2.1 文献库（Zotero 对标）

```
┌ 论文中心 ────────────────────────────────────────────── 搜索 / 导入 / 视图切换 ┐
│ 左栏 232px            │ 中栏 flex                         │ 右栏 340px            │
│ 智能视图（带计数）      │ 工具条：搜索 排序 视图 新建收藏夹     │ 详情 tab：信息/笔记/标签/批注 │
│ 收藏夹（领域+自定义）    │ 表头：☑ 标题 作者 年份 来源 标签 已读 │ 题名/原题/译名（可编辑）      │
│ 标签（count, 多选AND）  │ 行：标题+原题两行、标签 chips、批注数  │ 作者/年份/来源/DOI/许可/版本   │
│                        │ 选中：行高亮 + 左侧 2px 强调条        │ 摘要（可展开）/标签编辑/收藏夹  │
└ 选中工具条（浮于中栏底部）：已选 N 篇 · 引用到对话 · 加标签 · 收藏夹 · 回收站 ┘
```
- 左栏与右栏顶部都有折叠按钮；拖拽分隔条宽 4px，hover 时变成强调色 1px。
- 中栏表头 sticky；条目 hover 背景 `interactive-bg-hover`，选中 `interactive-bg-active` + 左侧 2px 强调条；已读状态用 6px 圆点（未读实心强调/已读空心弱化）。
- 行进入动效：首次加载 `fade-up` 120ms，逐行 delay 12ms（最多 10 行）；筛选/搜索切换不重播 stagger，只用 80ms 淡入。

### 2.2 阅读器

```
┌ 返回 · 标题（滚动收缩为单行） · 页码 1/33 · 缩放 100% · 原文/对照/仅译文 · 引用 · AI ┐
│ 缩略图 132px │ 页面画布（连续滚动，页间距 16px，页阴影 hover） │ 右栏 360px：目录/批注/双语/AI │
└ 底部：进度条 + 当前页/总页数 ┘
```
- 页面容器：`background: --dsw-alias-bg-layer-1`，页面本身 `bg-base` + 1px 边框，`border-radius: 6px`。
- 文字层透明文字，选中高亮 `color-mix(--dsw-alias-state-business-primary 22%)`；高亮标注 14% 底 + 底部 2px 实色边；hover 提升到 22%。
- 标注 popover：280px 宽，`scale-in` 120ms ease-out，颜色行 5 个 18px 圆点，hover 放大 1.08。
- 双语：段落卡片（原文 13/22，译文 13/22 主题色略弱），段落间 14px；caption 用 12/18 + 斜体灰；顶栏“翻译本页”按钮右侧显示进度/模型名。
- 页切换：`fade-through` 160ms；滚动毛玻璃工具条：`backdrop-filter: blur(12px)` + 底部 border 渐显。
- 页内搜索：命中文字用 `<mark>` 样式（黄底 32%），当前命中加 2px 边框并 `scrollIntoView` 居中。

### 2.3 动效 token

| 名称 | 值 |
| --- | --- |
| 快 | 120ms `cubic-bezier(.2,.8,.2,1)` |
| 标准 | 180ms 同上 |
| 面板展开 | 220ms `cubic-bezier(.16,1,.3,1)` |
| 弹簧（工具条/弹层） | `cubic-bezier(.34,1.56,.64,1)` 180ms |
| 骨架 shimmer | 1.4s linear infinite，`translateX(-100%→100%)` |
| 减少动效 | `@media (prefers-reduced-motion: reduce)` 全部降为 opacity 即时切换 |

## 3 状态与文案

- 加载：骨架屏（左栏 5 行、中栏 8 行、右栏 6 行），不用转圈整页遮罩。
- 空态：一个 48px 线性图标 + 一句说明 + 一个主行动按钮；回收站空态提示“删除的论文会保留 30 天后可清理”。
- 错误：行内 banner + 重试；离线/插件停用：整页降级卡（“Pappers-Hall 未运行或已停用”，含插件管理入口说明）。
- 所有用户可见文案走 i18n（zh/en），中文优先；数字与单位用中文（篇/张/条/页）。
- AI 内容必须显示来源（页码/图号/模型）与“AI 生成，请核对原文”标识；不可用显示原因（如“未配置嵌入模型/模型不支持图像”）。

## 4 可访问性

- 所有交互控件可 Tab 到达、有可见 focus ring（`focus-ring`）；列表支持 ↑↓/Home/End/Enter/Space；弹层 Escape 关闭并还原焦点。
- 对比度：正文 ≥ 4.5:1；批注颜色只作辅助，不单独承载语义。
- 点击区域 ≥ 28×28；图标按钮带 `aria-label`。
