import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/**
 * 生产环境通过 Nginx 代理到 /account-monitor 时，浏览器 Origin 是公网地址，
 * 而 Node 看到的 request URL 是 127.0.0.1:PORT，默认同源校验会误判为跨站。
 *
 * 在服务器 .env 里配置：
 *   PUBLIC_ORIGIN=https://your-domain.com
 * 多个来源用英文逗号分隔（例如 http 和 https、域名和 IP）。
 */
const allowedOrigins = String(process.env.PUBLIC_ORIGIN || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  ...(allowedOrigins.length ? { origin: allowedOrigins } : {}),
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
