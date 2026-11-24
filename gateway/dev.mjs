// 本地开发服务器：node dev.mjs  →  http://127.0.0.1:8787/api/chat
//   读取 gateway/.env.local（已被 .gitignore 忽略）里的 KEY=VALUE
//   MOCK=1 时不调用真实模型，返回一段带引用编号的假回答，用于联调前端
import http from "node:http";
import fs from "node:fs";
import { handle } from "./core.mjs";

const envFile = new URL("./.env.local", import.meta.url);
const fileEnv = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = { ...fileEnv, ...process.env };
const PORT = Number(env.PORT || 8787);

function mockFetch(_url, init) {
  const { messages } = JSON.parse(init.body);
  const n = (messages[0].content.match(/^\[(\d+)\]/gm) || []).length;
  const q = messages.at(-1).content;
  const parts = [
    `（本地模拟回答）关于「${q.slice(0, 20)}」，档案里检索到 ${n} 条资料。\n\n`,
    n ? `**结论**：他的核心看法集中在前几条资料里 [1]${n > 1 ? "[2]" : ""}。\n\n` : "档案里没有找到相关内容。\n",
    n > 2 ? `- 第一点，见 [3]\n- 第二点，见 [${Math.min(n, 4)}]\n` : "",
  ];
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      for (const p of parts) for (const ch of p.match(/.{1,6}/gs) || []) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`));
        await new Promise(r => setTimeout(r, 25));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
}

const mock = env.MOCK === "1";
const runEnv = mock ? { ...env, PROVIDER_ORDER: "mock", MOCK_API_KEY: "x", MOCK_BASE_URL: "http://mock", MOCK_MODEL: "mock" } : env;

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method, headers: req.headers, body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : body,
  });
  const out = await handle(request, runEnv, { ip: req.socket.remoteAddress, fetchImpl: mock ? mockFetch : fetch });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (!out.body) return res.end();
  for await (const c of out.body) res.write(c);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`gateway dev on http://127.0.0.1:${PORT}/api/chat ${mock ? "(MOCK)" : ""}`));
