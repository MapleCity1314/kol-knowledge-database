# kol-knowledge-database · 复刻计划

> 目标：参照 [Trader-Archives](https://suoha888.github.io/Trader-Archives/)（[源仓库](https://github.com/suoha888/Trader-Archives)）做一套「推特 KOL 公开推文 → 去噪分类 → 在线阅读站 + 开源数据 + AI 问答」的知识库系统。
> 状态（2026-11-24）：P0–P2 已完成；P4 已上线 GitHub Pages（每天自动同步）；P3 AI 助手代码已完成并在本地用模拟模型跑通，等申请免费模型 Key 并部署网关（见 gateway/README.md）。

---

## 0. 原站拆解结论（已核实）

| 方面 | 观察到的事实 | 对我们的意义 |
| --- | --- | --- |
| 仓库内容 | 只有**产物**：根 `index.html` + 每位 KOL 一个目录（`index.html` / `data/` / `images/` / `docs/articles/`）。`.gitignore` 排除了 `analyze_kol_profiles.py`、`audit_all_subsites.py` 等脚本 | 采集、清洗、分类、建站的**流水线没开源**，要自己设计 |
| 模板 | `0xmagnolia/` 与 `cj/` 的 CSS **完全一致**（28.9 KB），JS 只差 `KOL_META` / `FALLBACK_TWEETS` / AI 配置三段 | 架构是「**一套模板 + 每 KOL 一份 JSON → 静态生成**」 |
| 页面结构 | 头部 KOL 卡 → 搜索框 → 快捷入口 → 「N 条核心原话/思维模型」 → 卷（6–7 个大板块）→ 节（13–28 个小节）→ 推文卡片（精选内嵌，其余「展开更多」）→ 全量推文检索 → 深度长文专区 → 右下角 AI 助手 | 照这个信息架构做 |
| 原始数据 | `*_tweets_ultra_raw.json`：第三方 X 抓取 API 的原样输出（`createdAt` / `isReply` / `conversationId` / `mentions` / 互动数等） | 需要选一个 X 数据源 |
| 加工后推文 | `*_tweets.json` 每条：`volumeId/Name`、`domainId/Name`、`topicId/Code/Title`、`roleOrder` + `roleLabel`（核心原则 / 实盘案例 / 踩坑避坑）、`qualityTier`（S/A/B/C）、`qualityScore`、`shortNote`、互动数、`local_images`、`tweetUrl`、`text` | 这就是 LLM 分类要产出的字段 |
| 规模示例 | magnolia：原始 1,249 → 清洗 781 → S/A 精选 331；6 卷 16 节；6 条思维模型 | 去噪大约砍掉 35–50% |
| 思维模型 | `mental_models.json`：`id/tag/topic_id/title/quote/summary/rules[]/evidence_tweet_ids[]` | LLM 提炼，并且必须挂原推证据 |
| RAG | `data/ai_rag_index.json` = `{v, slug, count, docs:[{k 类型, id, a 锚点, d 日期, t 标题, x 正文, w 权重}]}`，在**浏览器端**做关键词检索（含日期区间、排除 KOL 自身名字） | 检索在前端完成，后端只负责转发大模型 |
| AI 网关 | 前端向 Vercel Edge `/api/chat` 发 OpenAI 兼容的流式请求（`model / messages / stream:true`，SSE 返回），用的是 OpenRouter 风格的模型名 | 网关不开源，要自己写一个约 50 行的转发服务 |
| 授权 | 代码是 MIT；推文和图片版权归原作者；页脚写明「严禁商业牟利」 | 见第 6 节 |

---

## 1. 决策

1. **范围：✅ 已定 A（2026-11-23）**：数据照搬原站 15 位交易员；**前端按你的新设计重做**，不复刻原站排版。
   - 原站数据已经清洗和分类过（`tweets.json` / `featured` / `mental_models` / `ai_rag_index` / `articles` / `images`），可以**直接同步使用**，第 2 节的 ①–⑦ 流水线暂时不用写。
   - 体量：数据 JSON/CSV 约 205 MB（361 个文件），图片约 900 MB（5,517 张），旧版 HTML 约 18 MB（不需要）。原站仍在更新（最近一次推送是 2026-11-22），所以需要一个**同步脚本**。
2. **X 数据源**（范围 A 下暂不需要；以后要自己新增 KOL 时再定。默认选 ①）
   - ① 付费第三方 API（如 twitterapi.io 一类，按条计费，最稳）
   - ② 自建抓取（twscrape + 小号 cookie，便宜但会被封）
   - ③ 官方 X API（贵）
3. **分类用的大模型**：默认 Claude（Sonnet 负责分类打分，Opus 负责建目录和提炼思维模型）。
4. **部署**（默认先 1，再视情况上 2）
   1. 只在本地或公司服务器上私有使用
   2. GitHub Pages 公开
   3. Vercel
5. **AI 问答网关**：默认 Vercel Edge 或 Cloudflare Worker 转发到 Claude/OpenRouter，Key 只放在服务端。

---

## 2. 技术架构

```
kol-knowledge-database/
├── kols.yaml                  # KOL 名单：handle、slug、显示名、方向、是否启用
├── pipeline/                  # Python 流水线（uv 管理）
│   ├── fetch.py               # ① 抓 user_info + 全量时间线 → raw/<slug>/ultra_raw.json（增量）
│   ├── clean.py               # ② 去噪：剔除转推、他人对话回复、抽奖/寒暄/纯表情、重复内容；补全长推和串推
│   ├── media.py               # ③ 下载头像、横幅、配图到本地 images/
│   ├── taxonomy.py            # ④ LLM 读抽样 → 生成「卷 → 节」目录（6–7 卷 / 13–20 节），人工可改 taxonomy.yaml
│   ├── classify.py            # ⑤ LLM 批量给每条推文分配 topic / roleLabel / qualityTier / score / shortNote
│   ├── models.py              # ⑥ LLM 提炼 6 条思维模型（必须带 evidence_tweet_ids，并校验 id 真实存在）
│   ├── articles.py            # ⑦ X 长文 → docs/articles/*.md
│   ├── export.py              # ⑧ 导出 tweets / featured / mental_models / domains 切片（JSON + UTF-8-SIG CSV）+ ai_rag_index.json
│   └── build_site.py          # ⑨ Jinja2 模板 → site/<slug>/index.html + site/index.html 总门户
├── templates/                 # portal.html.j2、kol.html.j2、共用 CSS/JS
├── gateway/                   # AI 网关（Edge Function，流式转发，限流，Key 在服务端）
├── raw/  (gitignore)          # 原始抓取数据，不公开
├── data/<slug>/               # 加工后的数据（中间层，可重跑）
├── site/                      # 构建产物 = 部署目录
└── tests/                     # schema 校验、证据 id 校验、构建冒烟测试
```

**关键设计点**
- **每一步可单独重跑、有缓存**：LLM 结果按 `tweet_id + prompt 版本` 缓存，改目录后只重算受影响部分，避免重复花钱。
- **目录先由人审**：`taxonomy.yaml` 由 LLM 起草，人工改完再跑 classify。原站质量好主要就靠这一步。
- **页面性能**：S/A 精选直接内嵌在 HTML 里（首屏无需请求），全量推文 JSON 懒加载；图片 lazy-load。
- **RAG 照原站做**：先用前端关键词 + 日期检索（零后端成本）；不够用再升级为向量检索。

---

## 3. 分阶段实施

**范围 A 下的阶段安排**（取代原来的 P0–P5）

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| **P0 · 立项** | `git init`、`.gitignore`（排除同步下来的大文件）；在 Documents 的 `projects.json`、根 README、`03-research/README.md` 里登记 | 登记完成，JSON 和链接校验通过 |
| **P1 · 数据同步层** | `sync.py`：用 git sparse-checkout 只拉各 KOL 的 `data/`、`docs/`、`images/`（不拉旧 HTML），放进 `upstream/`（不进 git）；生成 `catalog.json`，汇总 15 人的元信息、统计数字和目录结构；记录同步到的上游 commit | 再次运行能增量更新；schema 校验全部通过 |
| **P2 · 新前端设计** | **按你的新想法**：先定信息架构和视觉方案，做 1 位 KOL 的可交互原型，确认后再推到 15 位 + 总门户 | 浏览器里实际打开并操作通过 |
| **P3 · AI 助手** | 前端检索 + 自建流式网关（Key 放在服务端）。实际实现**没有用**上游的 `ai_rag_index.json`：它的字段各家不一致（thankucrypto 是 `kol`/`n`），锚点也指向上游页面；改为直接检索页面内嵌的原推、思维模型、长文（切成约 500 字的块）和附录，BM25 + 中文二字切分。模型走免费提供方的回退链：Agnes → 智谱 GLM Flash → Groq / Gemini → DeepSeek（付费兜底） | 浏览器里问答能跳转到原推或小节 |
| **P4 · 部署与自动同步** | 部署；定时执行 sync → 重新构建 | 线上实际可访问并验证 |
| **P5（以后）· 自有 KOL 扩充** | 需要收录原站以外的 KOL 时，再实现第 2 节的 ①–⑦ 采集和分类流水线，产出与上游相同的 schema | — |

---

## 3.5 前端设计方向（草案，2026-11-23）

**参考（已在浏览器中实测）**

| 参考站 | 实测特征 |
| --- | --- |
| 早期 Anthropic（2022–2023 官网存档） | 暖米白底 `#FAFAF7`；正文用衬线字体 Tiempos Text（16–19px，深灰 `#40403E`）；标题用几何无衬线 Styrene（500 字重）；陶土色点缀 `#CC9B7A`；单栏窄排版（约 590–730px）；手绘插画放在圆角色块里；小号大写栏目标签（ABOUT / RESEARCH）；胶囊形分类标签 |
| Kimi 研究博客（kimi.com/blog） | 纯白底，黑色字用 90% 不透明度；居中标题配面包屑；大圆角头图卡片；列表是「1 张大卡 + 3 列小卡」；正文以无衬线为主，脚注和说明用 Lora 衬线，另加载了 Noto Serif SC；留白很多，几乎没有装饰 |

**本项目的设计语言**：融合两者。Anthropic 的「纸感 + 衬线正文」，加上 Kimi 的「克制留白 + 卡片网格」。

- **字体**
  - 中文正文：思源宋体 / Noto Serif SC。
  - 西文正文：Source Serif 4 或 Newsreader。这两款是 Tiempos 的免费替代，Tiempos 是商用字体。
  - 标题与界面文字：几何无衬线，选 Inter Display、Instrument Sans 这一类。
  - 数字和代码：JetBrains Mono / Geist Mono。
- **颜色**
  - 纸色底：约 `#FAF9F5`。
  - 墨色正文：约 `#3D3D3A`。
  - 一个陶土 / 赭石色作为唯一的强调色。
  - 涨跌、风险等状态色要压低饱和度。
- **版式**
  - 正文单栏，约 680px。
  - 宽屏时左侧放目录（卷 / 节），右侧边栏放脚注式注释（原推数据、时间、图片）。
- **组件**
  - 推文不做成「推特卡片」，而是排成「引文段落」：衬线正文、左侧细线、日期和互动数写成小号旁注。
  - 思维模型用大号衬线引语来呈现。
- **首页**：参照 Kimi 的研究列表，一位精选交易员放大卡，其余三列网格。卡片配色块、手绘风或抽象纹理的封面。
- **边界**
  - 只借鉴风格。不使用 Anthropic / Kimi 的商标、Logo、插画和 Styrene / Tiempos 等商用字体。
  - 中文 webfont 体积大，要按 unicode-range 切片加载（Google Fonts 会自动切片）；macOS 上可以先退回系统宋体（Songti SC）。

**待你确认**：参考图之外还有什么想法？有没有暗色模式？是电脑优先还是手机优先？「按人看」还是「按主题横向看」？

## 4. 成本粗估（以单个 KOL 约 3,000 条推文计）

- **抓取**：第三方 API 约 $0.15–0.5 / 千条，可以忽略。
- **LLM 分类**：约 3,000 条 × 约 300 token 输入，批量调用 + prompt 缓存，单 KOL 大约 $1–5。
- **思维模型 / 目录**：需要大上下文的调用 1–3 次，大约 $1–3。
- **AI 问答**：按调用量计费，需要设置限流。

---

## 5. 风险

- **X 抓取不稳定**：API 改版、账号被封。应对：数据源做成可替换的适配层；raw 数据长期保留。
- **LLM 分类漂移**：同一节里风格不统一。应对：固定 prompt 版本、few-shot 用人工审过的样本、抽检。
- **思维模型编造原话**：应对：`quote` 必须能在 `evidence_tweet_ids` 对应的原文中模糊匹配到，否则判为不通过。

---

## 6. 合规与品牌

- 原站代码是 MIT。如果借用它的 CSS/JS，要保留 MIT 版权声明。默认方案是**自己写模板，只参考信息架构和排版风格**。
- 推文和图片版权归原作者：保留原推链接，不做商业用途；是否公开部署由你决定。
- **不沿用**梭哈.AI 的品牌、头像（原站每个 `images/` 目录里都有 `suoha_avatar.jpg`）、文案和站主信息。
- 不直接调用原站的 AI 网关。
