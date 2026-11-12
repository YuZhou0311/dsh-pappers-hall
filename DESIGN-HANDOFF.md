# Pappers-Hall 前端设计交接（v0.20.0）

> 本轮只改视觉层与布局：设计变量、组件层级、控件归位、动效和无障碍细节。数据逻辑、Host、自动保存、AI 美化与方向浮层均未改动。
> **改完必须构建，并让 DSH 重新加载插件后刷新页面。**

## 1. 位置与基线

- 工作目录：`/Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin`
- DSH profile 安装方式是指向源码目录的 symlink：
  `/Users/zhouyu/.dsh/profiles/desktop/node_modules/dsh-pappers-hall -> ../../../../Project/Pappers-Hall/pappers-hall-plugin`
- 运行时加载构建产物 `pappers-hall-plugin/client.js`，不是 `client/src` 直接生效。
- 本轮开工前基线：提交 `2b82ecf`，标签 `ph-baseline-v0.19.3`（工作树干净）。
- 上一版基线：`572e231`（v0.18.3）。

## 2. CSS 的真实归属

| 范围 | 文件 | 说明 |
|---|---|---|
| 文献库 / 抽屉 / 输入框 dock / 会话工具卡 / 设置 / 通用原子组件 | `client/src/core/styles.css` | **唯一自动同步的 CSS**：`node client/build.mjs` 会把它写进 `core/styles.js` 的 `STYLES`，不要手改 `core/styles.js` |
| 笔记工作区 / 编辑器 / 文档卡片 / 笔记弹窗 | `client/src/surfaces/notes/styles.js` | 独立的 `NOTES_CSS` 模板（手写源，直接改这个文件） |
| 阅读器 | `client/src/surfaces/reader/styles.js` | 独立的 `READER_CSS` 模板（手写源，直接改这个文件） |

三者在同一个文档里注入，共用 `core/styles.css` 顶部 `:root` 的设计变量。新增界面请优先复用这些变量，不要再写死字号/圆角/时长。

> 注意：`notes/styles.js` 与 `reader/styles.js` 里**不能出现反引号或 `${`**——它们是模板字符串。

## 3. 本轮方向

Apple 式克制的「研究台」：中性表面、单一蓝色行动色（`#0071e3`）、SF Pro 界面字、阅读衬线（New York / 宋体）只用于长文正文；胶囊主按钮、发丝分隔、克制动效。浅紫只保留为 AI 标记，不再承担次要按钮。

完整的变量表、控件归位表、动效表和断点表见 [docs/DESIGN-v20.md](docs/DESIGN-v20.md)。

## 4. 本轮改了什么

| 界面 | 改动 |
|---|---|
| 全局 | 重建 token：11–26 字阶、4px 节奏、6/8/12/16/20/999 圆角、150/220/320ms 动效、单一蓝行动色、三级中性阴影；统一焦点环、滚动条、hover/press 底色 |
| 论文库顶栏 | 三列网格（品牌 / 居中搜索 / 行动）；导入上移为唯一主按钮；图片检索、重复文献、设置、刷新、快捷键收进「更多」；搜索框带 ⌘K 提示 |
| 论文库工具栏 | 只留左栏开关、排序、表格/卡片、结果数、右栏开关；排序改为带图标的安静下拉 |
| 左栏 | 新增「浏览」分区头；浏览/收藏夹/文件夹/标签/笔记统一 10.5px 分区标签、30px 行高、蓝色淡底选中；去掉彩色 nth-child 图标与 3px 色条 |
| 表格/卡片 | 44px 行高；标题 13px/600，原题 11px；选中 8% 蓝底 + 2px 左条；表头中性化吸顶；卡片 14px 圆角、hover 抬升 |
| 详情栏 | 新增标题区（题名/原题/作者年份期刊/打开/引用）；信息页改为纯元数据，移除与标题区重复的作者/年份/期刊；页签切换淡入 |
| 批量条 | 重排为底部浮动胶囊：计数 +「引用到对话」主按钮 + 次要动作组；≤1320px 次要按钮转图标，窄屏横向滚动；最后一行仍可滚出批量条 |
| 笔记 | 顶栏 56px；文件夹 220 / 列表 304 / 论文面板 320；列表行改轻卡片；编辑器文档头 26px 衬线标题、正文 760px 限宽 15.5px/1.85；卡片视图 860px |
| 阅读器 | 工具栏 58/44px 两行、滚动收缩 46px；缩略图栏 96px；画布中性底 + 纸张投影；右栏 356px、四页签胶囊化；工具条/批注卡/翻译浮层统一圆角与阴影 |
| 外围 | 抽屉行、草稿卡、设置面板、图片检索、命令面板、引用弹窗统一按钮层级、圆角、焦点与 hover；状态栏压到 30px |
| 动效 | 行/卡片 24ms 级联；页签气泡 280ms；面板 320ms；详情与阅读页 220–240ms 淡入上移；批量条 240ms 弹入；全部支持 `prefers-reduced-motion` |
| 适配 | 1320 / 1180 / 1120 / 1100 / 1000 / 980 / 820 / 760 / 640；表格逐级隐藏列，窄屏三栏变覆盖层，批量条横向滚动，笔记/阅读器单栏 |

改动文件：

```
client/src/core/styles.css
client/src/core/styles.js            （由构建自动同步，勿手改）
client/src/core/primitives.jsx       （SearchInput 快捷键提示）
client/src/surfaces/library/shell.jsx
client/src/surfaces/library/toolbar.jsx
client/src/surfaces/library/details.jsx
client/src/surfaces/library/collections.jsx
client/src/surfaces/notes/styles.js
client/src/surfaces/reader/styles.js
client/src/i18n/zh.js / en.js
client.js                            （构建产物）
package.json / README.md / docs/DESIGN-v20.md
```

## 5. 构建、加载、验收

```bash
cd /Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin
node client/build.mjs          # 产出 client.js，并同步 core/styles.js
```

然后让 DSH 重新加载插件（关闭再开启 `include:pappers-hall`），并**刷新浏览器页面**；客户端 bundle 不会热更新。

按窗口宽度各看一遍（建议 1440×900、1280×800、1024×768，再拉到 760 以下）：

**论文库**
- 顶栏搜索是否居中、导入是否为唯一主按钮、「更多」菜单是否贴边不裁切。
- 左栏五个分区是否一眼可分；选中态、计数、折叠是否稳定。
- 表格表头与数据列在任何宽度下对齐；选中/悬停/已读圆点/批注计数可点。
- 批量条出现时最后一行仍可滚到可见位置；≤1320px 次要按钮转图标后是否仍可辨识。
- 详情栏标题区在长题名下是否换行而不撑破；打开/引用按钮是否可用。

**笔记**
- 新建 → 输入 → 自动保存 → 刷新后内容还在；列表与卡片视图切换不跳动。
- 26px 标题与 760px 正文在 1024 宽下是否溢出；窄屏文件夹/列表/论文面板覆盖层是否互相遮挡。

**阅读器**
- 标题滚动收缩、工具行收起后搜索仍可召回；缩略图栏 96px 下页码是否清晰。
- 右栏四页签是否一行放得下；选区工具条、批注浮层、翻译浮层是否贴边或被裁切。

**深色模式**
- 逐个界面切换：发丝线是否可见、hover 是否过亮、批量条毛玻璃是否发灰、PDF 纸张是否仍为白底。

**无障碍**
- 只用键盘走一遍主流程：Tab 焦点可见、Esc 关闭弹层、方向键在列表内移动。
- 系统开启“减少动态效果”后，界面不再有位移或缩放动画。

## 6. 回滚

```bash
git log --oneline                 # 基线 2b82ecf / 572e231
git diff 2b82ecf -- client/src
git checkout 2b82ecf -- .         # 整体回到 v0.19.3（随后重新 build）
```

## 7. 不要动

- `host/**`（笔记/论文存储、AI、OCR、翻译、API）。
- 数据流：`notes.update` 的 `contentMd` 与 `contentJson` 分离；自动保存、草稿、冲突、自动美化、AI 方向浮层逻辑。
- `client/src/core/notes-api.js` / `notes-model.js` 的请求与数据结构。
- 不要新增 `react` / `react/jsx-runtime` 之外的客户端依赖（构建会拒绝）。
- 不要删改现有 `ph-*` 类名、`aria-*`、`title`、`data-*`：`test/` 下的验收脚本依赖其中一部分。

## 8. 已知限制（如实）

- 本环境无法真实渲染 DSH，因此没有截图验收；视觉结论来自样式规则与断点推演，最终观感请在 DSH 里按第 5 节确认。
- 卡片网格的缩略图为 PDF 首页渲染，深色模式下纸张仍是白色（文档内容，不是界面底色）。
- 阅读器窄屏右栏仍为覆盖层，需要手动收起才能看到整页；未加遮罩，避免误触关闭。
- 批量条在窄屏采用横向滚动而不是“更多”折叠，保证所有既有按钮仍可直接点击。
- 较窄窗口首次打开时，笔记的文件夹（≤1250）/ 论文面板（≤1420）与阅读器右栏（≤1150）默认收起，避免盖住正文；顶栏按钮可随时展开。
