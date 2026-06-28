import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
  session
} from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSpawn, runtimeEnv } from "../scripts/runtime-env.mjs";
import {
  applyStealth,
  applyWindowTitle,
  loadStealthConfig,
  saveStealthConfig,
  STEALTH_PERSONAS
} from "./stealth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.join(__dirname, "..");
const appIconPath = process.platform === "darwin"
  ? path.join(appRoot, "build", "icon.png")
  : process.platform === "win32"
    ? path.join(appRoot, "build", "icon.ico")
  : path.join(appRoot, "build", "icon.png");
const dockIconPath = path.join(appRoot, "build", "icon.png");

const DEV_SERVER_URL = runtimeEnv("DEV_SERVER_URL", "http://127.0.0.1:5174");
const API_BASE_URL = runtimeEnv("API_BASE_URL", "http://127.0.0.1:5180");
const API_HEALTH_URL = runtimeEnv("API_HEALTH_URL", `${API_BASE_URL}/api/bootstrap`);
const SHOULD_START_API = runtimeEnv("SKIP_API_START", "") !== "1";
const SERVER_START_TIMEOUT_MS = 30000;
const packagedDataDir = () => path.join(app.getPath("userData"), "data");
const packagedResourcesDir = () => process.resourcesPath || appRoot;
const apiWorkingDirectory = () => app.isPackaged ? packagedResourcesDir() : appRoot;

const ALLOWED_DEV_ORIGINS = new Set([
  new URL(DEV_SERVER_URL).origin,
  new URL(API_BASE_URL).origin,
  "http://127.0.0.1:5180"
]);

const SHORTCUTS = Object.freeze({
  toggleOverlay: runtimeEnv("SHORTCUT_OVERLAY", "CommandOrControl+Shift+O"),
  toggleAnswer: runtimeEnv("SHORTCUT_ANSWER", "CommandOrControl+Shift+A"),
  captureScreenshot: runtimeEnv("SHORTCUT_SCREENSHOT", "CommandOrControl+Shift+S"),
  hideOverlays: runtimeEnv("SHORTCUT_HIDE_OVERLAYS", "CommandOrControl+Shift+H"),
  toggleVisibility: runtimeEnv("SHORTCUT_TOGGLE_VISIBILITY", "CommandOrControl+Shift+V"),
  toggleInteraction: runtimeEnv("SHORTCUT_TOGGLE_INTERACTION", "CommandOrControl+Shift+I")
});
const STARTUP_SURFACE = runtimeEnv("STARTUP_SURFACE", "main");
const validWindowRoles = new Set(["main", "overlay", "answer"]);

if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare");
}

const windows = {
  main: null,
  overlay: null,
  answer: null
};

let apiProcess = null;
let isQuitting = false;
let stealthConfig = loadStealthConfig();
let overlayClickThrough = stealthConfig.defaultClickThrough;
let cachedVisibilityBeforePanic = { overlay: false, answer: false };
let panicHidden = false;

applyStealth(stealthConfig);

function applyAppIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  try {
    if (!fs.existsSync(dockIconPath)) return;
    const image = nativeImage.createFromPath(dockIconPath);
    if (!image.isEmpty()) {
      app.dock.setIcon(image);
    }
  } catch {
    // Dock icon is best-effort; ignore failures.
  }
}

app.on("ready", () => {
  applyAppIcon();
  applyStealth(stealthConfig);
});

function isAllowedAppUrl(targetUrl) {
  if (!targetUrl) return false;

  try {
    const parsed = new URL(targetUrl);

    if (app.isPackaged) {
      return parsed.protocol === "file:";
    }

    return ALLOWED_DEV_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

function isAllowedDisplayMediaRequest(request) {
  const candidates = [
    request.securityOrigin,
    request.frame?.url,
    request.webContents?.getURL?.()
  ];

  return candidates.some((candidate) => isAllowedAppUrl(candidate));
}

function getTrustedWindowFromEvent(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) return null;
  if (!isAllowedAppUrl(event.sender.getURL())) return null;
  return senderWindow;
}

function broadcast(channel, payload) {
  for (const candidate of Object.values(windows)) {
    if (candidate && !candidate.isDestroyed()) {
      candidate.webContents.send(channel, payload);
    }
  }
}

async function isUrlReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, label, timeoutMs = SERVER_START_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError?.message || "no response"}`);
}

async function startApiServer() {
  if (!SHOULD_START_API || await isUrlReady(API_HEALTH_URL)) {
    return;
  }

  const prepared = app.isPackaged
    ? prepareSpawn(process.execPath, [
        path.join(appRoot, "dist-server", "http.mjs")
      ])
    : prepareSpawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:api"]);
  apiProcess = spawn(prepared.command, prepared.args, {
    cwd: apiWorkingDirectory(),
    env: {
      ...process.env,
      API_PORT: new URL(API_BASE_URL).port || "5180",
      SECOND_CHAIR_DATA_DIR: app.isPackaged ? packagedDataDir() : runtimeEnv("DATA_DIR"),
      SECOND_CHAIR_RESOURCE_DIR: app.isPackaged ? packagedResourcesDir() : appRoot,
      ELECTRON_RUN_AS_NODE: app.isPackaged ? "1" : process.env.ELECTRON_RUN_AS_NODE
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  apiProcess.stdout.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
  apiProcess.stderr.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));
  apiProcess.on("exit", (code, signal) => {
    apiProcess = null;
    if (!isQuitting) {
      console.error(`[api] exited unexpectedly with ${signal || code}`);
      broadcast("server:status", { state: "exited", code, signal });
    }
  });

  broadcast("server:status", { state: "starting", url: API_BASE_URL });
  await waitForUrl(API_HEALTH_URL, "local API");
  broadcast("server:status", { state: "ready", url: API_BASE_URL });
}

function stopApiServer() {
  if (!apiProcess || apiProcess.killed) return;
  apiProcess.kill("SIGINT");
  setTimeout(() => {
    if (apiProcess && !apiProcess.killed) apiProcess.kill("SIGTERM");
  }, 1000).unref();
}

function createWindow(role, options) {
  const isOverlayLike = role === "overlay" || role === "answer";
  const baseBackground = isOverlayLike ? "#00000000" : undefined;

  // Resolve a window icon that actually exists on disk so Electron doesn't
  // print warnings about missing .icns/.ico assets during development.
  const windowIcon = options.icon
    || (fs.existsSync(appIconPath) ? appIconPath : undefined);

  const window = new BrowserWindow({
    ...options,
    title: options.title || "Second Chair",
    icon: windowIcon,
    show: false,
    backgroundColor: options.backgroundColor || baseBackground,
    transparent: isOverlayLike ? true : Boolean(options.transparent),
    vibrancy: options.vibrancy,
    visualEffectState: options.visualEffectState,
    hasShadow: typeof options.hasShadow === "boolean" ? options.hasShadow : true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }

    return { action: "deny" };
  });
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    applyWindowTitle(window, stealthConfig);
  });

  applyOverlayWindowBehavior(window, role);
  applyWindowTitle(window, stealthConfig);

  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });

  window.on("closed", () => {
    windows[role] = null;
  });

  windows[role] = window;
  return window;
}

function applyOverlayWindowBehavior(window, role) {
  if (role !== "overlay" && role !== "answer") return;

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setSkipTaskbar(true);

  try {
    window.setContentProtection(true);
  } catch {
    // Not supported on every platform/window manager.
  }

  applyWindowTitle(window, stealthConfig);

  const enforceAlwaysOnTop = () => {
    if (window.isDestroyed()) return;
    try {
      if (process.platform === "darwin") {
        window.setAlwaysOnTop(true, "screen-saver", 1);
      } else {
        window.setAlwaysOnTop(true);
      }
    } catch {
      window.setAlwaysOnTop(true);
    }
  };

  window.on("show", () => {
    window.setIgnoreMouseEvents(role === "overlay" ? overlayClickThrough : false, { forward: true });
    setTimeout(enforceAlwaysOnTop, 50);
    setTimeout(enforceAlwaysOnTop, 200);
  });
  window.on("blur", () => {
    setTimeout(enforceAlwaysOnTop, 100);
    if (stealthConfig.autoHideOnBlur && !panicHidden) {
      window.hide();
    }
  });
}

function applyStealthToAllWindows(config) {
  for (const window of Object.values(windows)) {
    if (window && !window.isDestroyed()) {
      applyWindowTitle(window, config);
    }
  }
}

function setOverlayClickThrough(enabled, notify = true) {
  overlayClickThrough = Boolean(enabled);
  const overlay = windows.overlay;
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    try {
      overlay.setIgnoreMouseEvents(overlayClickThrough, { forward: true });
    } catch (error) {
      console.warn("[stealth] could not change click-through:", error?.message);
    }
  }
  if (notify) {
    broadcast("stealth:changed", { config: stealthConfig, overlayClickThrough });
  }
  return { clickThrough: overlayClickThrough };
}

function toggleOverlayInteraction() {
  return setOverlayClickThrough(!overlayClickThrough);
}

function panicToggleVisibility() {
  const wantHidden = !panicHidden;
  if (wantHidden) {
    cachedVisibilityBeforePanic = {
      overlay: Boolean(windows.overlay && !windows.overlay.isDestroyed() && windows.overlay.isVisible()),
      answer: Boolean(windows.answer && !windows.answer.isDestroyed() && windows.answer.isVisible())
    };
    for (const role of ["overlay", "answer"]) {
      const window = windows[role];
      if (window && !window.isDestroyed()) {
        try {
          window.setOpacity(0);
          window.hide();
        } catch (error) {
          console.warn(`[stealth] could not hide ${role}:`, error?.message);
        }
      }
    }
    panicHidden = true;
    return { visible: false, hidden: ["overlay", "answer"] };
  }

  for (const role of ["overlay", "answer"]) {
    const window = windows[role];
    if (!window || window.isDestroyed()) continue;
    const shouldShow = cachedVisibilityBeforePanic[role];
    if (shouldShow) {
      try {
        window.setOpacity(1);
        window.show();
        window.setIgnoreMouseEvents(role === "overlay" ? overlayClickThrough : false, { forward: true });
      } catch (error) {
        console.warn(`[stealth] could not restore ${role}:`, error?.message);
      }
    }
  }
  panicHidden = false;
  return {
    visible: true,
    overlay: Boolean(windows.overlay && !windows.overlay.isDestroyed() && windows.overlay.isVisible()),
    answer: Boolean(windows.answer && !windows.answer.isDestroyed() && windows.answer.isVisible())
  };
}

async function loadApp(window, desktopWindow) {
  if (app.isPackaged) {
    await window.loadFile(path.join(__dirname, "../dist/index.html"), {
      query: { view: desktopWindow }
    });
    return;
  }

  const url = new URL(DEV_SERVER_URL);
  url.searchParams.set("view", desktopWindow);
  await window.loadURL(url.toString());
}

async function createMainWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  const window = createWindow("main", {
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    title: "Second Chair",
    frame: false,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    titleBarOverlay: isWin
      ? {
          color: "#ffffff",
          symbolColor: "#111827",
          height: 40
        }
      : undefined,
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    backgroundColor: "#ffffff",
    transparent: false,
    hasShadow: true,
    roundedCorners: isMac ? true : undefined
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  await loadApp(window, "main");
  return window;
}

async function createOverlayWindow() {
  const isMac = process.platform === "darwin";
  const window = createWindow("overlay", {
    width: 460,
    height: 220,
    minWidth: 320,
    minHeight: 160,
    title: "Second Chair Overlay",
    frame: false,
    transparent: true,
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: isMac ? "active" : undefined,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: "#00000000",
    hasShadow: true
  });

  window.once("ready-to-show", () => {
    window.show();
  });
  await loadApp(window, "overlay");
  return window;
}

async function createAnswerWindow() {
  const isMac = process.platform === "darwin";
  const window = createWindow("answer", {
    width: 560,
    height: 680,
    minWidth: 420,
    minHeight: 420,
    title: "Second Chair Answers",
    frame: false,
    transparent: true,
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: isMac ? "active" : undefined,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: "#00000000",
    hasShadow: true
  });

  await loadApp(window, "answer");
  return window;
}

async function ensureWindow(role) {
  if (windows[role] && !windows[role].isDestroyed()) {
    return windows[role];
  }

  if (role === "main") return createMainWindow();
  if (role === "overlay") return createOverlayWindow();
  if (role === "answer") return createAnswerWindow();
  throw new Error(`Unknown window role: ${role}`);
}

async function setWindowVisible(role, visible) {
  const window = await ensureWindow(role);

  if (visible) {
    if (role === "overlay" || role === "answer") {
      window.setIgnoreMouseEvents(role === "overlay" ? overlayClickThrough : false, { forward: true });
      try {
        window.setOpacity(1);
      } catch {
        // Some platforms may not support opacity changes; ignore.
      }
      panicHidden = false;
    }
    window.show();
    window.focus();
  } else {
    window.hide();
  }

  return { role, visible: window.isVisible() };
}

async function toggleWindow(role) {
  const window = await ensureWindow(role);
  return setWindowVisible(role, !window.isVisible());
}

async function createStartupWindows() {
  if (STARTUP_SURFACE === "all") {
    await Promise.all([
      createMainWindow(),
      createOverlayWindow(),
      createAnswerWindow()
    ]);
    return;
  }

  if (validWindowRoles.has(STARTUP_SURFACE)) {
    await ensureWindow(STARTUP_SURFACE);
    return;
  }

  console.warn(`[windows] unsupported SECOND_CHAIR_STARTUP_SURFACE=${STARTUP_SURFACE}; opening main`);
  await createMainWindow();
}

function hideOverlayWindows() {
  for (const role of ["overlay", "answer"]) {
    const window = windows[role];
    if (window && !window.isDestroyed()) {
      window.hide();
    }
  }

  return {
    overlay: Boolean(windows.overlay && !windows.overlay.isDestroyed() && windows.overlay.isVisible()),
    answer: Boolean(windows.answer && !windows.answer.isDestroyed() && windows.answer.isVisible())
  };
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowedUrl = isAllowedAppUrl(details.requestingUrl || webContents.getURL());
    const isAppWindow = Object.values(windows).some((window) => window?.webContents === webContents);

    if (!allowedUrl || !isAppWindow) {
      callback(false);
      return;
    }

    if (permission === "media") {
      const mediaTypes = details.mediaTypes || [];
      callback(mediaTypes.length === 0 || mediaTypes.every((type) => type === "audio" || type === "video"));
      return;
    }

    callback(false);
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void (async () => {
      let didRespond = false;
      const deny = () => ({ video: null, audio: null });
      const respond = (selection) => {
        if (didRespond) return;
        didRespond = true;
        try {
          callback(selection);
        } catch (error) {
          console.error("[capture] display media callback failed", error);
        }
      };

      try {
        if (!isAllowedDisplayMediaRequest(request)) {
          respond(deny());
          return;
        }

        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 1, height: 1 }
        });
        const source = sources.find((candidate) => candidate.id.startsWith("screen:")) || sources[0];
        respond(source ? { video: source, audio: "loopback" } : deny());
      } catch (error) {
        console.error("[capture] display media request failed", error);
        respond(deny());
      }
    })();
  }, { useSystemPicker: false });
}

function registerGlobalShortcuts() {
  const registrations = [
    ["shortcut:toggleOverlay", SHORTCUTS.toggleOverlay, () => toggleWindow("overlay")],
    ["shortcut:toggleAnswer", SHORTCUTS.toggleAnswer, () => toggleWindow("answer")],
    ["shortcut:captureScreenshot", SHORTCUTS.captureScreenshot, () => captureScreenshot()],
    ["shortcut:hideOverlays", SHORTCUTS.hideOverlays, () => hideOverlayWindows()],
    ["shortcut:toggleVisibility", SHORTCUTS.toggleVisibility, () => panicToggleVisibility()],
    ["shortcut:toggleInteraction", SHORTCUTS.toggleInteraction, () => toggleOverlayInteraction()]
  ];

  for (const [channel, accelerator, action] of registrations) {
    const ok = globalShortcut.register(accelerator, async () => {
      try {
        const result = await action();
        broadcast(channel, { accelerator, result });
      } catch (error) {
        broadcast(channel, {
          accelerator,
          error: error instanceof Error ? error.message : "Shortcut action failed."
        });
      }
    });

    if (!ok) {
      console.warn(`[shortcuts] failed to register ${accelerator}`);
    }
  }
}

async function captureScreenshot(sourceId) {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: true
  });
  const source = sourceId
    ? sources.find((candidate) => candidate.id === sourceId)
    : sources.find((candidate) => candidate.id.startsWith("screen:")) || sources[0];

  if (!source) {
    throw new Error("No capturable screen or window source was found.");
  }

  return {
    id: source.id,
    name: source.name,
    appIcon: source.appIcon?.isEmpty() ? null : source.appIcon?.toDataURL() || null,
    dataUrl: source.thumbnail.toDataURL()
  };
}

ipcMain.handle("app:getInfo", () => ({
  isPackaged: app.isPackaged,
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  api: {
    baseUrl: API_BASE_URL,
    healthUrl: API_HEALTH_URL,
    managed: Boolean(apiProcess)
  },
  shortcuts: SHORTCUTS,
  stealth: stealthConfig
}));

ipcMain.handle("windows:setVisible", async (event, role, visible) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted window request.");
  if (!validWindowRoles.has(role)) throw new Error(`Invalid window role: ${role}`);
  return setWindowVisible(role, Boolean(visible));
});

ipcMain.handle("windows:toggle", async (event, role) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted window request.");
  if (!validWindowRoles.has(role)) throw new Error(`Invalid window role: ${role}`);
  return toggleWindow(role);
});

ipcMain.handle("windows:hideOverlays", async (event) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted window request.");
  return hideOverlayWindows();
});

ipcMain.handle("windows:setClickThrough", async (event, role, enabled) => {
  const window = getTrustedWindowFromEvent(event);
  if (!window) throw new Error("Untrusted window request.");
  if (!["overlay", "answer"].includes(role)) throw new Error(`Invalid click-through window role: ${role}`);
  if (role === "overlay") {
    return { role, ...setOverlayClickThrough(enabled) };
  }
  const target = windows[role];
  if (!target || target.isDestroyed()) throw new Error(`Window is unavailable: ${role}`);
  target.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
  return { role, clickThrough: Boolean(enabled) };
});

ipcMain.handle("capture:listSources", async (event) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted capture request.");
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon?.isEmpty() ? null : source.appIcon?.toDataURL() || null
  }));
});

ipcMain.handle("capture:screenshot", async (event, options = {}) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted capture request.");
  return captureScreenshot(typeof options.sourceId === "string" ? options.sourceId : undefined);
});

ipcMain.handle("stealth:get", () => ({
  config: stealthConfig,
  personas: Object.values(STEALTH_PERSONAS),
  shortcuts: {
    toggleVisibility: SHORTCUTS.toggleVisibility,
    toggleInteraction: SHORTCUTS.toggleInteraction,
    hideOverlays: SHORTCUTS.hideOverlays,
    toggleOverlay: SHORTCUTS.toggleOverlay,
    toggleAnswer: SHORTCUTS.toggleAnswer,
    captureScreenshot: SHORTCUTS.captureScreenshot
  },
  overlayClickThrough
}));

ipcMain.handle("stealth:update", async (event, patch) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted stealth update.");
  if (!patch || typeof patch !== "object") throw new Error("Invalid stealth patch.");

  const next = {
    ...stealthConfig,
    ...("enabled" in patch ? { enabled: Boolean(patch.enabled) } : {}),
    ...("persona" in patch && STEALTH_PERSONAS[patch.persona] ? { persona: patch.persona } : {}),
    ...("defaultClickThrough" in patch ? { defaultClickThrough: Boolean(patch.defaultClickThrough) } : {}),
    ...("autoHideOnBlur" in patch ? { autoHideOnBlur: Boolean(patch.autoHideOnBlur) } : {})
  };

  stealthConfig = saveStealthConfig(next);
  applyStealth(stealthConfig);
  applyStealthToAllWindows(stealthConfig);

  if (stealthConfig.defaultClickThrough !== overlayClickThrough && !windows.overlay?.isVisible()) {
    setOverlayClickThrough(stealthConfig.defaultClickThrough, false);
  }

  broadcast("stealth:changed", { config: stealthConfig, overlayClickThrough });
  return { config: stealthConfig, overlayClickThrough };
});

ipcMain.handle("stealth:setClickThrough", async (event, enabled) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted stealth update.");
  return setOverlayClickThrough(enabled);
});

ipcMain.handle("stealth:panic", async (event) => {
  if (!getTrustedWindowFromEvent(event)) throw new Error("Untrusted stealth update.");
  return panicToggleVisibility();
});

app.whenReady().then(async () => {
  configurePermissions();
  await startApiServer();
  await createStartupWindows();
  registerGlobalShortcuts();
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createStartupWindows();
  }
});

app.on("will-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  stopApiServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
