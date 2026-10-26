import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

const APP_BASE = "/account-monitor";

export default defineConfig({
  base: `${APP_BASE}/`,
  server: {
    port: 3000,
    host: "127.0.0.1",
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    tanstackStart({
      router: { basepath: APP_BASE },
    }),
    nitro({ baseURL: `${APP_BASE}/` }),
    // React 的 vite 插件必须在 Start 之后
    viteReact(),
  ],
});
