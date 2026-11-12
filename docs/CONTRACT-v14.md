# Pappers-Hall v0.14 契约（2026-11-11 下午：国内稳定快速翻译引擎）

用户：“快速翻译功能，你找找国内的稳定的这个实现方法，肯定有的，包括很多开源的都做过。”

## 研究结论
免费、无需 Key、国内可稳定访问的公开翻译接口中，**腾讯交互翻译（Transmart，https://transmart.qq.com/api/imt）** 是国内开源客户端（Bob 插件、Pot、沉浸式翻译类项目）长期使用的方案：
- POST JSON `{header:{fn:'auto_translation'}, type:'plain', model_category:'normal', source:{lang,text_list}, target:{lang}}`；
- 返回 `{header.ret_code:'succ', auto_translation:[...]}`；
- 无需注册/API Key，国内网络直连，实测 0.26–0.83s；
- 公开 Web 接口，属 non-official（可能变更/限流），在 UI 中如实标记 free+unofficial。

## 实现
- Host `ENGINES` 新增 `tencent`（label 腾讯交互翻译（免费）），默认链路 `AUTO_CHAIN=['tencent','google','mymemory','llm']`；
- quick/freeOnly 链路默认 `tencent → google → mymemory`（可用设置开关逐项控制），≤6s，不调用 LLM；
- 请求分块 1800 字、网络重试/并发信号量/质量门禁复用现有实现；失败 reason 精确到 `tencent_<ret_code>`/http；
- settings 翻译 provider 列表新增 tencent，面板可开关/测试；
- 客户端快速卡显示「腾讯交互翻译（免费） · 延迟」+「免费快速」；失败仍给原因 +「用 AI 精译」；AI 精译保留。
- 质量说明：免费引擎学术术语/歧义不如 AI 精译（如 rainfed 可能译成灌溉）；需要高质量请点「AI 精译」。

## 验收
- 真实 live：quick 腾讯 0.26–0.83s 成功译文；关闭腾讯后回落 Google/MyMemory（本机 429）→ 诚实 unavailable + suggestAi；关闭全部 → invalid/suggestAi；显式 quick+llm 被拒绝；缓存复用。
- host/selftest **389 checks PASS**（引擎目录/链路/quick 断言已更新为含 tencent，未放宽真实性）；
- GUI：快速卡腾讯成功（418ms/完整译文/AI 精译入口）、AI 精译卡、AI Markdown 面板保持；
- 数据 30/21/346/5 夹不变，无 schema 变更。
