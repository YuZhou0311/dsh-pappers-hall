# 图片生成记录

生成日期：2026-11-13。使用 Codex 内置图片生成工具 `image_gen.imagegen`。以下保留实际提交的完整提示词；同一提示词再次生成的结果可能不同。

品牌方向来自项目需求：戴学士帽的 DeepSeek 风格蓝色小鲸鱼，简约、多边形、科研与学习意象。画面是新生成的品牌插画；产品界面另用 Chrome 实拍，不用生成图片替代实际功能。

## README 英文主视觉

成品：[查看英文图片](../assets/brand/readme-hero-en.png)。模式：内置图片生成工具，以中文开篇主视觉为编辑目标；非透明。

```text
Use case: text-localization
Asset type: English GitHub README hero for Pappers-Hall.
Input image is the edit target: preserve the ultra-wide composition, exact friendly polygonal scholar-whale identity, navy graduation cap and gold tassel, open notebook, research paper sheets, color palette, pale background, generous margins, divider and bottom badge. Preserve the blue Pappers-Hall title and top eyebrow.
Change ONLY the two Chinese text lines into clean English typography. Replace the large Chinese subtitle with exactly: "Your AI research workbench". It may fit across two carefully spaced lines beneath Pappers-Hall if needed, but must never overlap the whale or notebook. Replace the smaller Chinese line with exactly: "Read papers. Take notes. Connect ideas."
All other text remains exactly: "RESEARCH, IN ONE PLACE.", "Pappers-Hall", "DEEPSEEK HARNESS COMMUNITY PLUGIN", "PRE-RELEASE".
Keep the same refined minimalist editorial style and geometric illustration. All English spelling exact and crisp. Keep landscape aspect approximately 1920:819. Do not add other objects, text, borders, watermarks, or UI. Output opaque light background.
```

## README 开篇主视觉

成品：[查看图片](../assets/brand/readme-hero.png)。模式：全新生成；无参考图片；非透明。

```text
Use case: ads-marketing
Asset type: polished GitHub README opening hero for Pappers-Hall, a community plugin for DeepSeek Harness. Create a single ultra-wide horizontal artwork, approximately 2400 x 1000, aspect 2.4:1.
Primary request: A beautiful minimalist, polygonal academic DeepSeek blue baby whale wearing a dark navy graduation mortarboard with a tiny gold tassel. Flat vector-like origami shapes, about 9 large geometric blue facets, recognizable cute whale silhouette with small eye, gently upturned split tail, subtle smile, no limbs. The scholar whale floats above an open paper notebook on the right half. Two elegant floating academic paper sheets with abstract paragraph rules, a tiny chart, one highlighter stroke and a bookmark integrate research papers and learning notes into the same sculptural scene.
Style: exceptional Swiss editorial meets Japanese paper illustration. Precise, airy, quiet, sophisticated. Solid geometric facets, no plastic 3D, no excessive polygons, no gradients, no glow. White/very pale icy-blue background #F7F9FC, strong cobalt #4D6BFE, midnight #172C51, pale blue #DDE6FF; just one small apricot accent #E8AB67.
Composition: left 48% is carefully typeset text with generous breathing room. Right 52% is a large iconic whale, paper sheets and open notebook, with one extremely subtle pale-blue circular field behind. Beautiful visual hierarchy, all content safely inset 7% from edges. Thin editorial divider at bottom.
Exact text, render crisp and accurate:
Top small letterspaced: "RESEARCH, IN ONE PLACE."
Large main title: "Pappers-Hall"
Under title, large Chinese subtitle: "你的 AI 科研工作台"
Next small Chinese line: "读论文 · 做笔记 · 连接知识"
Footer left small: "DEEPSEEK HARNESS COMMUNITY PLUGIN"
Footer right small outlined tag: "PRE-RELEASE"
Constraints: all text should be elegantly aligned, never tiny, no other text. Whale must look like a scholarly interpretation of the DeepSeek whale, with graduation cap; community product, not official endorsement. A finished coherent campaign hero, no UI screenshot, no laptop, no heavy drop shadows, no rainbow, no watermark.
```

## 透明学士帽小鲸鱼

成品：[查看图片](../assets/brand/scholar-whale.png)。模式：以开篇主视觉作为参考；transparent_background: true。

```text
Use case: logo-brand
Asset type: transparent mascot asset for Pappers-Hall, a DeepSeek Harness community research plugin.
Input image: reference for EXACT mascot identity, blue palette and faceted geometric style. Generate a new square 1024x1024 standalone mascot on genuinely transparent background.
Primary request: extract and faithfully redraw ONLY the cute scholarly blue whale wearing the navy graduation cap with small gold tassel from the reference hero. Same silhouette, face, tail, pale lower belly, broad origami polygon facets. Center it large with generous 12% transparent padding all around. Keep the exact recognizable friendly design.
Constraints: whale and graduation cap only. No book, no paper sheets, no circle, no shadow, no ground, no text, no framing. Crisp, minimal vector-like edges, flat faceted fills. Transparent outside mascot.
```

## 竖版发布海报

成品：[查看图片](../assets/social/launch-poster.png)。模式：以开篇主视觉作为参考；非透明。

```text
Use case: ads-marketing
Asset type: finished 3:4 portrait launch poster for Pappers-Hall, optimized for social sharing, 1536x2048 intended.
Input image: reference hero for exact scholar-whale mascot identity and brand palette. Preserve the mascot identity.
Create an exceptionally elegant minimal editorial poster on very pale icy white #F7F9FC. Big navy Swiss typography, cobalt blue highlights, lots of breathing room. Top thin small label "PAPPERS-HALL / PRE-RELEASE". Strong large Chinese headline in two left-aligned lines: "把论文读进去。" then "把知识留下来。". Under this, medium subtitle exactly "你的 AI 科研工作台".
The central large illustration is the same friendly faceted origami blue DeepSeek-style whale wearing a navy graduation cap with gold tassel, swimming above one open notebook. A floating research paper with tiny geometric chart at left, one highlighted note sheet at right. Minimal flat geometric polygons, no plastic, no photorealism. Give the central illustration ample room.
Bottom quarter has a beautiful thin-line 4-step horizontal editorial workflow, no rounded-card grid. Labels exactly "收集" "精读" "沉淀" "对话", with small geometric file, highlighter, notebook, speech symbols above, connected subtly.
Footer exact "Pappers-Hall" as wordmark, smaller "DeepSeek Harness 社区插件", and a fine outlined tag "开发中 · 预发布". Small URL "github.com/YuZhou0311/dsh-pappers-hall".
Constraints: accurate and clean Chinese glyphs, consistent typography; no fabricated interface, no fake data or performance claims; no dark background; all content comfortably within safe margins. No extra text, no watermarks.
```

## 横版分享封面

成品：[查看图片](../assets/social/social-preview.png)。模式：以开篇主视觉作为参考；非透明。

```text
Use case: ads-marketing
Asset type: GitHub social preview / landscape social sharing card, 2:1 aspect ratio, intended 1280 x 640 pixels.
Use the provided Pappers-Hall hero as the exact mascot identity and palette reference. Create a NEW elegantly composed 2:1 card, clean ivory/icy white background, cobalt blue and midnight navy type, small golden tassel accent. Flat polygonal scholar whale with graduation cap sits on right, encircled by a very delicate open orbit of three tiny symbols: research paper, open notebook, conversation bubble. The orbit is a graphic metaphor only, not a software screenshot.
Left 60% strong aligned typographic composition: small top label "PAPPERS-HALL"; large two-line Chinese headline "让研究，" / "连成一线。"; medium subtitle "论文 · 笔记 · AI 对话". Bottom left small "DeepSeek Harness 社区插件"; top right fine outlined badge "PRE-RELEASE".
Constraints: all text exactly as specified, lots of safe padding, correct Chinese, restrained editorial hierarchy. Do not add URLs, promises, stats, UI, buttons, or watermarks. Same faceted blue whale character as reference, no glossy 3D. Keep headline dark navy with second line cobalt. Whimsical yet academically sophisticated.
```
