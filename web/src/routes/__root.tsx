import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import "../styles/global.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Changan Monitor" },
      { name: "description", content: "6 平台账号 72 小时帖子监控" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div className="empty">
      <div className="empty-title">页面不存在</div>
      <div className="empty-desc">检查一下地址，或者回到账号总览。</div>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="empty">
      <div className="empty-title">页面加载失败</div>
      <div className="empty-desc">{String(error)}</div>
    </div>
  ),
});

function RootComponent() {
  return (
    <RootDocument>
      <header className="app-header">
        <div className="app-header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark" />
            <span>Changan Monitor</span>
            <span className="brand-sub">账号监控 · 72h</span>
          </Link>
          <nav className="nav">
            <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "active" }}>
              账号总览
            </Link>
            <Link to="/manage/accounts" activeProps={{ className: "active" }}>
              账号管理
            </Link>
          </nav>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
