import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { AnswerWindow } from "./ui/AnswerWindow";
import { OverlayApp } from "./ui/OverlayApp";
import "./styles/app.css";

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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {getEntryView()}
  </React.StrictMode>
);
