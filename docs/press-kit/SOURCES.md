# 来源与制作说明

制作日期：**2026-11-13**。

## 设计参考

阅读以下项目的 README，并在 Chrome 中查看其宣传图，用于参考信息层次、图文节奏与留白方式；本项目未复用其品牌插画或产品截图。

| 参考 | 使用的设计启发 |
| :--- | :--- |
| [dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) · [浅色开篇图](https://raw.githubusercontent.com/woniuniuniu/dsh-media-desk/main/docs/assets/hero-zh-light.webp) | 首屏先说明产品价值，品牌图与实际界面相互支撑 |
| [DS Bot 中文 README](https://github.com/Fei2411/DS-Bot/blob/main/README.zh.md) · [团队工作截图](https://raw.githubusercontent.com/Fei2411/DS-Bot/main/docs/images/team.zh.png) | 用真实工作场景解释功能，保持使用入口清楚 |
| [Huashu Design](https://github.com/alchaincyf/huashu-design) · [风格参考图](https://raw.githubusercontent.com/alchaincyf/huashu-design/master/assets/style-specimens/sheet-east.jpg) | 编辑式留白、简练的几何语言、明确的视觉主次 |

## 品牌插画

- 使用 **Codex 内置 `image_gen.imagegen`** 生成，未调用外部图片生成服务。
- 主视觉为全新生成；透明形象、竖版海报与分享封面以主视觉为参考，维持同一鲸鱼造型与配色。
- 英文主视觉以中文主视觉为编辑目标，仅将两行中文宣传语本地化为英文，保持角色、构图与品牌色一致。
- 实际完整提示词保存在 [IMAGE-PROMPTS.md](IMAGE-PROMPTS.md)。PNG 成品保持工具输出，不通过手绘替代生成结果。
- 小鲸鱼按项目需求借鉴 DeepSeek 蓝鲸意象，加上学士帽和多边形表现。它是本插件的社区项目形象，不表示 DeepSeek 官方授权、认可或赞助。

## 界面截图

- 浏览器：**Google Chrome**，通过原生浏览器界面操作与开发者工具的 **Capture screenshot** 导出。
- 状态：DSH **浅色模式**，关闭浏览器自动翻译，使用产品本身的中文界面。
- 视口：**1440 × 900**；导出：**2880 × 1800 PNG**。
- 截图来自用户提供的本地开发实例。公开材料不记录访问令牌、会话地址或本地个人路径。
- 四张截图均为实际界面，不使用图片生成工具伪造产品功能。原始 PNG 未修改界面像素。
- `workbench-card.png` 由 Chrome 导出 `feature-card.html`：真实笔记截图等比放入版式，配合已生成的鲸鱼与标题；它是宣传排版，原始截图另行保留。
- `conversation-light.png` 展示加入材料后的**未发送草稿**；未为拍摄生成或伪造模型回答。拍摄后已清空该草稿。

## 展示文献

主要展示 **Reflexion: Language Agents with Verbal Reinforcement Learning**，截图所用版本列出作者 Noah Shinn、Federico Cassano、Edward Berman、Ashwin Gopinath、Karthik Narasimhan、Shunyu Yao。论文与图表来源：[arXiv:2303.11366v4](https://arxiv.org/abs/2303.11366v4)。

截图中的论文页面、图表与示例阅读笔记用于解释阅读、笔记和引用工作流。论文内容属于其原作者；笔记里的实验数字描述论文研究内容，不是 Pappers-Hall 的性能宣传。

## 功能与发布口径

产品描述根据本地 `package.json`、客户端与 Host 实现、既有技术说明，以及实际界面核对。重点覆盖论文库、原始 PDF 阅读、图表、批注、并排笔记、笔记 Agent 与材料引用。

检查时 GitHub 的最近发布包为 **v0.24.23**，标记为 **Pre-release**；本地开发包版本为 **0.24.25**。README 安装示例使用实际发布过的包名，不承诺所有开发界面均已进入该发布包。下载入口使用 [Releases 列表](https://github.com/YuZhou0311/dsh-pappers-hall/releases)，不依赖可能跳过预发布的 `latest` 入口。

AI、翻译、网页检索、OCR 与语义检索等能力均说明相应模型或组件条件；没有将本地资料存储表述成“所有 AI 完全离线”。代码许可见 [MIT LICENSE](../../LICENSE)。
