# kol-knowledge-database · KOL 知识库

把推特实战交易员的公开推文整理成可以系统阅读的档案站。数据同步自
[suoha888/Trader-Archives](https://github.com/suoha888/Trader-Archives)（MIT，15 位交易员），前端重新设计：
纸色底 + 衬线正文（参考早期 Anthropic 官网与 Kimi 研究博客的克制排版）。

线上地址：<https://maplecity1314.github.io/kol-knowledge-database/>
（`.github/workflows/pages.yml`：每次推送 main、每天 10:17 北京时间、或手动触发时，自动同步上游 → 构建 → 发布 GitHub Pages。）

交易员页面右下角有「问 AI」阅读助手：在本页档案里检索，用免费模型回答，并用 [n] 标注出处，点击可以跳到原推。网关的部署说明见 [gateway/README.md](gateway/README.md)。

## 用法

```bash
python3 tools/sync.py      # 增量同步上游数据到 upstream/（约 83 MB，不含配图）
python3 tools/build.py     # 生成 site/：首页 + 15 个交易员页
open site/index.html       # 直接双击打开即可，无需起服务
```

- `tools/sync.py --images`：同时镜像全部配图（约 900 MB）。不加时页面直接从 GitHub 加载图片。
- `tools/sync.py --only cj 0xsun`、`tools/build.py --only cj`：只处理部分交易员。
- 每个交易员页都是**单文件**（数据内联），拷到任何地方都能打开；本地图片缺失时自动回退到 GitHub。

## 目录

| 路径 | 内容 |
| --- | --- |
| `tools/sync.py` | 上游同步（GitHub tree API + git blob sha 增量比对），记录在 `upstream/_sync.json` |
| `tools/build.py` | 解析上游名录卡片与小节导语，整理数据，生成 `site/` 与 `site/catalog.json` |
| `templates/base.css` | 共用设计变量（颜色、字体、明暗模式）与基础组件 |
| `templates/portal.html` | 首页模板：精选大卡 + 三列网格，封面是每位交易员的真实月发推量曲线 |
| `templates/kol.html` | 交易员页模板：目录 / 思维模型 / 卷→节→角色分组 / 长文 / 附录 / 搜索 |
| `upstream/`、`site/` | 可重建产物，不进 git |
| `PLAN.md` | 计划与设计决策 |

## 版权

代码借鉴的上游为 MIT；推文与图片版权归各原作者。仅供学习研究，不构成投资建议。
