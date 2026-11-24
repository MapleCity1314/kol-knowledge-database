// Cloudflare Worker 入口（备选部署方式）：wrangler deploy worker.mjs
import { handle } from "./core.mjs";

export default {
  fetch(request, env) {
    return handle(request, env, { ip: request.headers.get("CF-Connecting-IP") || "" });
  },
};
