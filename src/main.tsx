import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { AnswerWindow } from "./ui/AnswerWindow";
import { OverlayApp } from "./ui/OverlayApp";
import "./styles/app.css";

function getEntryView() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") || params.get("window") || params.get("page");
  document.documentElement.dataset.view = view || "main";
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
