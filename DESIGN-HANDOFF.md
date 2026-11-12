# Pappers-Hall 前端美化设计交接（v0.18.3）

> 给 opendesign / 前端设计代理：只改视觉层，不要改数据逻辑与 Host。**改完必须 build，并让 DSH 重新加载插件后刷新页面。**

## 1. 位置

- 工作目录：`/Users/zhouyu/Project/Pappers-Hall`
- 插件源码：`/Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin`（就是当前实际运行的插件，不是副本）
- DSH profile 里的安装方式是指向源码目录的 symlink：
  `/Users/zhouyu/.dsh/profiles/desktop/node_modules/dsh-pappers-hall -> ../../../../Project/Pappers-Hall/pappers-hall-plugin`
- 运行时加载的是构建产物 `pappers-hall-plugin/client.js`，不是 `client/src` 直接生效。

## 2. 设计入口（按优先级）

| 范围 | 文件 |
|---|---|
| 全局设计变量 / 所有 CSS / DSH design tokens | `client/src/core/styles.css`（**唯一 CSS 源文件**） |
| 通用原子组件/按钮/输入/图标 | `client/src/core/primitives.jsx`、`client/src/core/icons.jsx` |
| 论文库三栏与侧栏 | `client/src/surfaces/library/shell.jsx`、`collections.jsx`、`toolbar.jsx`、`item-table.jsx`、`folders.jsx`、`notes-sidebar.jsx`、`note-inline.jsx` |
| 笔记编辑器 / 卡片文档 / 对话框 | `client/src/surfaces/notes/editor.jsx`、`cards.jsx`、`dialogs.jsx`、`paper-panel.jsx`、`styles.js`（生成文件，勿手改） |
| 阅读器 | `client/src/surfaces/reader/shell.jsx`、`ai-panel.jsx`、`bilingual.jsx`、`markdown.jsx` |
| 字体/配色/token | 只用 `--dsw-alias-*` / `--ph-*` 等现有 token；不要引外部字体或新 npm 依赖 |

**样式单源已经接入构建**：`client/build.mjs` 每次构建会把 `styles.css` 自动同步进 `styles.js` 的 `STYLES` 模板。设计只需编辑 `styles.css`，不要手改 `styles.js`。

## 3. 构建、加载、验收

```bash
cd /Users/zhouyu/Project/Pappers-Hall/pappers-hall-plugin
node client/build.mjs          # 产出 client.js
```

然后让 DSH 重新加载插件（关闭再开启 `include:pappers-hall`），并**刷新浏览器页面**；客户端 bundle 不会热更新（除非同时跑 dev:web watcher，本环境没有）。

验收建议：
- 1440×900 与 1280×800 两档宽度看论文库三栏、笔记内联编辑、阅读器右栏；
- 深色模式看 token（当前截图多为浅色）；
- 不破坏空态/错误态/窄屏折叠；
- 交互选择器尽量保持不变，现有 harness 依赖部分 class 名与 aria/title。

## 4. 不要动

- `host/**`（笔记/论文存储、AI、OCR、翻译、API）。
- 数据流：`notes.update` 的 `contentMd` 与 `contentJson` 分离；自动保存、草稿、冲突、自动美化、AI 方向浮层逻辑。
- 不要改 `client/src/core/notes-api.js` / `notes-model.js` 的请求/数据结构，除非与后端对齐。
- 不要新增 `react`/`react/jsx-runtime` 之外的客户端 external 依赖（构建会拒绝）。

## 5. 当前已知视觉问题（可优先设计）

1. 论文库左栏信息密度偏高（文件夹、笔记树、标签），需要更清晰的层级/留白/折叠。
2. 笔记 v2 文档希望“排版为主、多样表达为辅”，减少卡片边框感，保持连续阅读节奏。
3. 阅读器右栏 AI/目录/批注/笔记四个 tab 的视觉一致性。
4. 小屏与深色模式未充分截图验证。

## 6. 交付回执

请把改动文件、build 结果、截图路径和 DSH 刷新后的验收结果发回 Lead；不要自行 purge 用户数据（当前 6 篇论文 / 2 批注 / 77 图 / 2 文件夹）。
