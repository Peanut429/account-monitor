pnpm build

# 复制到服务器，只覆盖 .output，不动 .env
rsync -avz .output/ root@aomei:/data/web/account-monitor/