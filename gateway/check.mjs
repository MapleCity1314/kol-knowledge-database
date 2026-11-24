// node check.mjs —— 用 .env.local 里的 Key 逐个检查已配置的模型提供方：
//   1. GET /models 看 Key 是否有效、默认模型 ID 是否存在
//   2. 发一条很短的流式请求，确认真的能出字
// 只打印提供方名称、模型 ID 和状态，不打印 Key。
import fs from "node:fs";
import { PROVIDERS } from "./core.mjs";

const env = { ...process.env };
const f = new URL("./.env.local", import.meta.url);
if (fs.existsSync(f)) for (const line of fs.readFileSync(f, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const order = String(env.PROVIDER_ORDER || Object.keys(PROVIDERS).join(",")).split(",").map(s => s.trim()).filter(Boolean);
let any = false;
for (const id of order) {
  const U = id.toUpperCase(), key = env[`${U}_API_KEY`];
  if (!key) continue;
  any = true;
  const base = (env[`${U}_BASE_URL`] || PROVIDERS[id]?.base || "").replace(/\/+$/, "");
  const model = env[`${U}_MODEL`] || PROVIDERS[id]?.model;
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let line = `${id.padEnd(9)} ${model}\n`;
  try {
    const r = await fetch(`${base}/models`, { headers: H, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const ids = ((await r.json()).data || []).map(m => m.id);
      line += `  /models: ${r.status}，共 ${ids.length} 个模型；默认模型${ids.includes(model) ? "存在" : "不在列表里"}\n`;
      if (!ids.includes(model)) line += `  可选（含 flash/free/chat 的）：${ids.filter(x => /flash|free|chat|lite/i.test(x)).slice(0, 12).join(", ")}\n`;
    } else line += `  /models: HTTP ${r.status}\n`;
  } catch (e) { line += `  /models: ${e.name}\n`; }
  try {
    const t0 = Date.now();
    const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model, stream: true, max_tokens: 30, messages: [{ role: "user", content: "用一句话说明什么是止损。" }] }) });
    const txt = r.ok ? await r.text() : "";
    const out = [...txt.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`)).join("");
    line += `  对话: HTTP ${r.status}，${Date.now() - t0}ms${out ? `，回答：${out.slice(0, 40)}` : ""}\n`;
  } catch (e) { line += `  对话: ${e.name}\n`; }
  console.log(line);
}
if (!any) console.log("没有找到任何 *_API_KEY。把 Key 写进 gateway/.env.local（参考 .env.example）后再运行。");
