// KOL 知识库 · AI 问答网关（无依赖，Web 标准 Request → Response）
// 同一份代码可跑在 Vercel Edge、Cloudflare Worker 和本地 Node（dev.mjs）上。
//
// 职责：
//   1. 只接受白名单来源；限制请求体大小、问题长度、参考片段数量；粗粒度按 IP 限流
//   2. 服务端拼系统提示词，固定模型和 max_tokens（前端改不了）
//   3. 按顺序尝试免费模型；在首字节之前遇到 429 / 5xx / 鉴权失败就换下一家
//   4. 把上游 OpenAI 兼容的 SSE 转成纯文本流返回给前端
//
// Key 只从环境变量读取，绝不写进仓库或页面。

// 默认的提供方。模型 ID 来自第三方资料，拿到 Key 后请用 /models 核实，
// 可以用 <NAME>_MODEL / <NAME>_BASE_URL 环境变量覆盖。
export const PROVIDERS = {
  agnes:    { base: "https://apihub.agnes-ai.com/v1",           model: "agnes-2.5-flash" },
  zhipu:    { base: "https://open.bigmodel.cn/api/paas/v4",     model: "glm-4.7-flash" },
  groq:     { base: "https://api.groq.com/openai/v1",           model: "openai/gpt-oss-120b" },
  gemini:   { base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash-lite" },
  deepseek: { base: "https://api.deepseek.com/v1",              model: "deepseek-chat" },
};
const DEFAULT_ORDER = "agnes,zhipu,groq,gemini,deepseek";
const DEFAULT_ORIGINS = "https://maplecity1314.github.io,http://127.0.0.1:8765,http://localhost:8765,null";

const LIMITS = {
  body: 32_000,        // 请求体字节
  question: 600,       // 问题字数
  sources: 10,         // 参考片段条数
  sourceChars: 700,    // 每条片段字数
  history: 6,          // 历史消息条数（user/assistant 各算一条）
  historyChars: 1200,  // 每条历史消息字数
  maxTokens: 900,      // 回答上限
  perIp: 20,           // 每个 IP 每个窗口的请求数
  windowMs: 10 * 60_000,
  firstByteMs: 20_000, // 等上游首个响应的超时
};

const hits = new Map(); // 单实例内的粗限流；真正的花费上限靠免费额度 / DeepSeek 预充值余额

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Provider",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (status, obj, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

const clip = (s, n) => String(s ?? "").replace(/\s+\n/g, "\n").trim().slice(0, n);

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.t > LIMITS.windowMs) { hits.set(ip, { t: now, n: 1 }); return false; }
  rec.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > LIMITS.windowMs) hits.delete(k);
  return rec.n > LIMITS.perIp;
}

export function buildMessages({ name, question, sources, history }) {
  const refs = sources.map(s => `[${s.n}] ${s.label}\n${s.text}`).join("\n\n");
  const system = [
    `你是「KOL 知识库」里交易员「${name}」档案页的阅读助手。`,
    "你只能依据下面编号的【资料】回答，资料是从该交易员公开推文、思维模型和长文中检索出来的片段。",
    "规则：",
    "1. 用简体中文，先给结论，再分点展开；总长度控制在 300 字左右。",
    "2. 每个论点后面用 [编号] 标注出处，例如 [2] 或 [1][4]；只能引用资料里出现的编号，不要编造链接或推文 ID。",
    "3. 资料不足以回答时直说「档案里没有找到相关内容」，可以建议换个问法，不要用你自己的知识补充他的观点。",
    "4. 转述他的观点时说明是他的观点；不要给出买卖建议、目标价或仓位建议，必要时提醒内容不构成投资建议。",
    "",
    "【资料】",
    refs || "（本次没有检索到相关资料）",
  ].join("\n");
  return [
    { role: "system", content: system },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];
}

function validate(body) {
  const question = clip(body?.question, LIMITS.question);
  if (!question) return { error: "问题不能为空" };
  const name = clip(body?.name, 40) || "这位交易员";
  const sources = (Array.isArray(body?.sources) ? body.sources : []).slice(0, LIMITS.sources).map((s, i) => ({
    n: Number.isInteger(s?.n) ? s.n : i + 1,
    label: clip(s?.label, 120),
    text: clip(s?.text, LIMITS.sourceChars),
  }));
  const history = (Array.isArray(body?.history) ? body.history : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .slice(-LIMITS.history)
    .map(m => ({ role: m.role, content: clip(m.content, LIMITS.historyChars) }));
  return { name, question, sources, history };
}

function providerChain(env) {
  const order = String(env.PROVIDER_ORDER || DEFAULT_ORDER).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const chain = [];
  for (const id of order) {
    const U = id.toUpperCase();
    const key = env[`${U}_API_KEY`];
    const def = PROVIDERS[id] || {};
    const base = env[`${U}_BASE_URL`] || def.base;
    const model = env[`${U}_MODEL`] || def.model;
    if (key && base && model) chain.push({ id, key, base: base.replace(/\/+$/, ""), model });
  }
  return chain;
}

// 把 OpenAI 兼容的 SSE 流转成纯文本流
function sseToText(upstream) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return upstream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta;
          const text = delta?.content;
          if (text) ctl.enqueue(enc.encode(text));
        } catch { /* 忽略心跳或不完整行 */ }
      }
    },
  }));
}

async function callProvider(p, messages, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITS.firstByteMs);
  try {
    const res = await fetchImpl(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, messages, stream: true, temperature: 0.3, max_tokens: LIMITS.maxTokens }),
      signal: ctl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer); // 首字节已到，后续流式不再受这个超时限制
  }
}

export async function handle(request, env = {}, { fetchImpl = fetch, ip = "" } = {}) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map(s => s.trim());
  const okOrigin = allowed.includes(origin);
  const headers = cors(okOrigin ? origin : allowed[0]);

  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method === "GET" && url.pathname.endsWith("/health")) {
    return json(200, { ok: true, providers: providerChain(env).map(p => `${p.id}:${p.model}`) }, headers);
  }
  if (request.method !== "POST") return json(405, { error: "只支持 POST" }, headers);
  if (!okOrigin) return json(403, { error: "来源不在白名单" }, headers);

  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > LIMITS.body) return json(413, { error: "请求太大" }, headers);
  const raw = await request.text();
  if (raw.length > LIMITS.body) return json(413, { error: "请求太大" }, headers);

  const clientIp = ip || request.headers.get("CF-Connecting-IP") || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() || "anon";
  if (rateLimited(clientIp)) return json(429, { error: "提问太频繁了，请过几分钟再试" }, headers);

  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "请求格式不对" }, headers); }
  const v = validate(body);
  if (v.error) return json(400, { error: v.error }, headers);

  const chain = providerChain(env);
  if (!chain.length) return json(503, { error: "AI 服务还没有配置模型 Key" }, headers);

  const messages = buildMessages(v);
  const tried = [];
  for (const p of chain) {
    let res;
    try { res = await callProvider(p, messages, fetchImpl); }
    catch (e) { tried.push(`${p.id}:${e.name === "AbortError" ? "timeout" : "network"}`); continue; }
    if (res.ok && res.body) {
      return new Response(sseToText(res.body), {
        status: 200,
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Provider": `${p.id}:${p.model}` },
      });
    }
    tried.push(`${p.id}:${res.status}`);
    try { await res.body?.cancel(); } catch {}
  }
  return json(503, { error: "免费模型额度暂时用完了，请稍后再试", tried }, headers);
}
