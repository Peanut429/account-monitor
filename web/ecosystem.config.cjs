/**
 * PM2 配置。
 *
 * 放在 /opt/changan-monitor/web/ecosystem.config.cjs，
 * 和 server/、public/、.env 同级。
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * 不需要在这里写 env：
 *   node_args 让 Node 先加载同目录 .env，再执行 server/index.mjs。
 */
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "changan-monitor-web",
      cwd: __dirname,
      script: path.join(__dirname, "server/index.mjs"),
      node_args: "--env-file=.env",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 3000,
      kill_timeout: 5000,
      time: true,
    },
  ],
};
