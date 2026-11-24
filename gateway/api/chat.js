// Vercel Edge Function：部署后地址为 https://<项目>.vercel.app/api/chat
import { handle } from "../core.mjs";

export const config = { runtime: "edge" };

export default function handler(request) {
  return handle(request, process.env);
}
