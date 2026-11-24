# AI 问答网关

交易员页面右下角「问 AI」背后的转发服务。无依赖，同一份 `core.mjs` 可以部署到 Vercel Edge，也可以部署到 Cloudflare Worker。

```
浏览器（检索本页内嵌数据 → 取前 8 条片段）──POST──▶ 网关 /api/chat ──▶ 免费模型（失败就换下一家）
                         ◀──────── 纯文本流（回答里用 [n] 标出处）◀──
```

- **Key 只在网关的环境变量里。** 页面、仓库和 GitHub Actions 里都没有 Key。
- **前端改不了模型参数。** 系统提示词、模型和 `max_tokens` 都由服务端固定。
- **会自动换家。** 某家返回 429、5xx、鉴权失败或超时，就按 `PROVIDER_ORDER` 换下一家。
- **有基础防护：**
  - 只接受白名单来源：Pages 域名、本地 8765 端口、本地双击打开的文件。
  - 请求体限制在 32 KB 以内，问题不超过 600 字，片段不超过 10 条。
  - 同一 IP 每 10 分钟最多 20 次。这个限制只在单个实例内计数，比较粗。
- **花费上限：**
  - 免费模型只受各家的免费额度约束。
  - 如果把 DeepSeek 放进兜底，它按预充值扣费，充多少就是最多花多少。

## 1. 申请免费 Key（你自己注册，Key 不要发到聊天里）

| 提供方 | 申请地址 | 说明 |
| --- | --- | --- |
| Agnes（首选） | platform.agnes-ai.com | 第三方资料称完全免费、不需要信用卡，大约 20–30 RPM。以官方为准 |
| 智谱 GLM（备选，国内直连） | open.bigmodel.cn | Flash 系列免费，型号经常换代，用 `node check.mjs` 核实 |
| Groq / Gemini（可选） | console.groq.com / aistudio.google.com | 免费额度，海外服务 |
| DeepSeek（付费兜底） | platform.deepseek.com | 预充值，余额就是花费上限 |

## 2. 本地验证 Key

```bash
cd gateway
cp .env.example .env.local     # 填入 Key；.env.local 已被 git 忽略
node check.mjs                 # 逐家检查：Key 是否有效、默认模型 ID 是否存在、能否出字
node test.mjs                  # 单元测试（不联网）
node dev.mjs                   # 本地网关 http://127.0.0.1:8787/api/chat（MOCK=1 用假模型）
```

本地联调前端：

```bash
CHAT_ENDPOINT=http://127.0.0.1:8787/api/chat python3 tools/build.py
```

## 3. 部署

**Vercel（推荐）**

1. 在 Vercel 后台选 Add New → Project，导入 GitHub 仓库 `kol-knowledge-database`，Root Directory 选 `gateway`。
2. Framework 选 Other，构建命令留空。
3. 在 Environment Variables 里填入 `.env.example` 里同名的 Key。
4. 部署完成后，网关地址是 `https://<项目名>.vercel.app/api/chat`。打开 `…/api/health` 可以看到已启用的提供方，Key 不会显示。

**Cloudflare Worker（备选）**

```bash
wrangler deploy gateway/worker.mjs --name kol-gateway
```

然后用 `wrangler secret put AGNES_API_KEY` 等命令逐个写入 Key。

## 4. 接到网站上

把网关地址写进仓库根目录的 `site.config.json`：

```json
{ "chatEndpoint": "https://<项目名>.vercel.app/api/chat" }
```

推送到 main 后，GitHub Actions 会重新构建，交易员页面上就会出现「问 AI」按钮。`chatEndpoint` 留空时不显示按钮。
