# 依赖与许可清单

日期：2026-11-10。本插件**不打包、不下载**任何第三方库；运行时只使用 Node 内置模块与系统外部程序。

## 1 运行时（Host，Node ESM）

| 依赖 | 版本/来源 | 用途 | 许可 |
| --- | --- | --- | --- |
| Node.js | 实测 v26.11.1（要求 `>=24`：`node:sqlite` 稳定可用） | 运行时 | Node.js 为 MIT |
| `node:sqlite` (`DatabaseSync`) | Node 内置 SQLite 3.53.4（实测） | 资料库、FTS5 检索、任务队列 | SQLite 公有领域（Public Domain） |
| `node:child_process` / `node:crypto` / `node:fs` / `node:path` / `node:url` / `node:zlib` | Node 内置 | 调用 poppler、SHA-256、文件缓存、PNG 解码 | MIT（Node.js） |
| 无 npm 依赖 | — | `package.json` 无 `dependencies` | — |

## 2 外部程序（用户环境提供，独立进程调用，不随插件分发）

| 程序 | 最小版本 | 用途 | 许可 | 缺失时行为 |
| --- | --- | --- | --- | --- |
| `pdfinfo`（poppler） | 任意可用版本（macOS 实测 25.x） | 页数/页面尺寸/元数据 | GPL-2.0-or-later | 导入降级为页数未知；阅读仍可打开首页 |
| `pdftotext`（poppler） | 同上 | 逐页文字层 | GPL-2.0-or-later | 文字检索/批注定位降级为无文字层，界面显示 `text: degraded` |
| `pdftoppm`（poppler） | 同上 | 页面 PNG 渲染、图表裁切、dHash 灰度图 | GPL-2.0-or-later | 阅读器显示“页面渲染不可用”，不伪造图片 |
| `sips`（macOS 可选） | 系统自带 | 图像缩放（仅当需要时） | 系统组件 | 可不用（pdftoppm 自带缩放） |

GNU GPL 的 poppler 通过命令行进程边界调用，本插件不链接其代码、不修改、不重新分发。用户可通过配置 `pdfTools` 指向自己的安装路径。

## 2.5 构建期依赖（v0.2 新增，仅开发）

| 依赖 | 版本 | 用途 | 许可 | 是否随插件分发 |
| --- | --- | --- | --- | --- |
| `esbuild` | 0.28.2（devDependency） | 把 `client/src/**`（JSX 多文件）打包为单文件 `client.js`（lazy-CJS、UMD 风格 banner/footer、external 仅 react/react/jsx-runtime） | MIT | **否**：只交付构建产物 `client.js`，安装后的插件运行不加载 esbuild、`node_modules` 不进入分发包 |

构建命令：`node client/build.mjs`（或 `npm run build:client`）；`--watch` 支持开发热构建。v0.1 的单文件手写 `client.js` 已被此管线取代（备份不随包分发）。

## 3 前端（由 DSH 宿主提供，不重复打包）

| 依赖 | 来源 | 许可 |
| --- | --- | --- |
| React（`react`） | DSH Web 模块表（宿主已经加载） | MIT |
| DSH Client 服务（`slots`/`locale`/`sidebarRight`/`sidebarRightTabs`/`layout`） | 宿主公开扩展点，只调用不打包 | 随 DSH 安装包 |

本插件不 `require` 任何 `@deepseek-ai/dsh-*` Client 包，不使用 CDN、不加载 UMD、不安装第二份 React。

## 4 数据与测试资料

| 内容 | 许可/说明 |
| --- | --- |
| 插件自身源码、`icon.svg`、文档 | MIT（见 `LICENSE`） |
| 30 篇测试论文 PDF | 不随插件分发；逐篇来源/许可/版本见 `../pappers_hall_devkit_lite/papers/licenses.md` 与 `papers/inventory.json` | 
| 开发包书目文件（BibTeX/RIS/CSL-JSON）、设计图 | 属开发包输入，不随插件再分发 |
| 用户论文与笔记 | 用户自有；插件只在本地 `$DSH_HOME/pappers-hall/` 存储，不上传任何外部服务 |

## 5 可选/未启用的依赖（如实记录，当前版本不使用）

| 能力 | 候选组件 | 状态 |
| --- | --- | --- |
| PDF 渲染 | PDF.js / pdfjs-dist | 未使用（首版用系统 poppler 渲染页面 PNG，避免新增 npm 依赖与版本锁定问题） |
| OCR | Tesseract | 未安装；界面显示 OCR 不可用 |
| 文本嵌入 | `intfloat/multilingual-e5-small`（384 维，MIT，固定 revision） | 未安装权重与 Python 运行时；检索降级为 FTS5 关键词 + LIKE（中文）通道 |
| 图表嵌入 | 见 `config/model_defaults.json`（需与文本塔对齐） | 未安装；图片检索降级为图注 FTS + dHash 近重复 |
| 机器翻译（v0.2） | DSH `llm` 服务 + 当前 Agent 默认模型（`agentDefaultModel.currentSelection()`） | **已启用**（v0.2）：`translate.title` / `translate.blocks` 走 LLM 直连，带 `sessionId`（OpenCode 路由 header）、超时/并发/缓存/逐段原因；模型不可用时如实返回 `unavailable`。旧的 DSH `translator` 服务当前版本不使用 |
| 语义检索（v0.2 替代方案） | DSH `llm`（中文→英文关键词扩写 + 可选 Top-20 LLM 重排） | **已启用**（v0.2）：`search.query` 的 `ai_expand`/`ai_rerank` 通道；这是“LLM 关键词扩展召回”，**不是 embedding 向量语义**；`vector` 通道仍如实 `unavailable` |
| AI 问答/看图（v0.2） | DSH `llm` + `attachments.saveImage` + 可图像模型 | **已启用**（v0.2）：`ai.ask` 可把页面/图裁切 PNG 作为 ImageBlock 发给模型；模型无图像模态时返回 `unavailable` 并说明 |
| GROBID | GROBID REST | 未部署；不影响打开 PDF 与批注 |
| DOI/Crossref | Crossref / DataCite REST | 本版不联网校验 DOI；书目以本地 manifest/导入文件为准，冲突字段可见（不静默覆盖） |
