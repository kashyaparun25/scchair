import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { AnswerWindow } from "./ui/AnswerWindow";
import { OverlayApp } from "./ui/OverlayApp";
import "./styles/app.css";

declare global {
  interface Window {
    __SECOND_CHAIR_API_BASE_URL__?: string;
  }
}

function detectPlatform(): "darwin" | "win32" | "linux" | "web" {
  const bridge = (window as { secondChair?: { getAppInfo?: () => Promise<{ platform?: string }> } | undefined }).secondChair;
  if (bridge?.getAppInfo) {
    bridge.getAppInfo().then((info) => {
      if (info?.platform) document.documentElement.dataset.platform = info.platform;
    }).catch(() => {
      document.documentElement.dataset.platform = "web";
    });
  }
  if (typeof navigator !== "undefined" && /Win/.test(navigator.platform || "")) return "win32";
  if (typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "")) return "darwin";
  return "web";
}

function withApiBase(pathOrUrl: string, apiBaseUrl: string): string {
  if (!pathOrUrl.startsWith("/api/") && pathOrUrl !== "/api/bootstrap" && !pathOrUrl.startsWith("/ws/")) {
    return pathOrUrl;
  }
  return `${apiBaseUrl}${pathOrUrl}`;
}

async function configureDesktopApiRouting(): Promise<void> {
  const bridge = (window as { secondChair?: { getAppInfo?: () => Promise<{ platform?: string; api?: { baseUrl?: string } }> } }).secondChair;
  if (!bridge?.getAppInfo) return;

  try {
    const info = await bridge.getAppInfo();
    if (info?.platform) document.documentElement.dataset.platform = info.platform;
    const apiBaseUrl = info?.api?.baseUrl?.replace(/\/+$/, "");
    if (!apiBaseUrl || window.location.protocol !== "file:") return;

    window.__SECOND_CHAIR_API_BASE_URL__ = apiBaseUrl;

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string") {
        return originalFetch(withApiBase(input, apiBaseUrl), init);
      }
      if (input instanceof URL) {
        return originalFetch(input, init);
      }
      if (input.url.startsWith(window.location.origin) || input.url.startsWith("/api/")) {
        return originalFetch(new Request(withApiBase(new URL(input.url).pathname, apiBaseUrl), input), init);
      }
      return originalFetch(input, init);
    };

    const OriginalWebSocket = window.WebSocket;
    const wsBaseUrl = apiBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    window.WebSocket = class SecondChairWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const resolvedUrl = typeof url === "string" ? withApiBase(url, wsBaseUrl) : url;
        super(resolvedUrl, protocols);
      }
    };

    const originalOpen = window.open.bind(window);
    window.open = (url?: string | URL, target?: string, features?: string) => {
      const resolvedUrl = typeof url === "string" ? withApiBase(url, apiBaseUrl) : url;
      return originalOpen(resolvedUrl, target, features);
    };
  } catch {
    // Browser-only mode and denied desktop bridges should continue with normal relative URLs.
  }
}

function getEntryView() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") || params.get("window") || params.get("page");
  document.documentElement.dataset.view = view || "main";
  document.documentElement.dataset.platform = detectPlatform();
  if (view === "overlay") return <OverlayApp />;
  if (view === "answer" || view === "answer-window") return <AnswerWindow />;
  document.documentElement.dataset.view = "main";
  return <App />;
}

configureDesktopApiRouting().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {getEntryView()}
    </React.StrictMode>
  );
});
