const { contextBridge, ipcRenderer } = require("electron");

/**
 * @typedef {"main" | "overlay" | "answer"} DesktopWindowRole
 * @typedef {"shortcut:toggleOverlay" | "shortcut:toggleAnswer" | "shortcut:captureScreenshot" | "shortcut:hideOverlays" | "shortcut:toggleVisibility" | "shortcut:toggleInteraction" | "server:status" | "stealth:changed"} DesktopEventChannel
 * @typedef {{ isPackaged: boolean, platform: string, versions: { chrome: string, electron: string }, api: { baseUrl: string, healthUrl: string, managed: boolean }, shortcuts: Record<string, string> }} AppInfo
 * @typedef {{ id: string, name: string, thumbnail?: string, dataUrl?: string, appIcon: string | null }} CaptureSource
 */

const eventChannels = new Set([
  "shortcut:toggleOverlay",
  "shortcut:toggleAnswer",
  "shortcut:captureScreenshot",
  "shortcut:hideOverlays",
  "shortcut:toggleVisibility",
  "shortcut:toggleInteraction",
  "server:status",
  "stealth:changed"
]);

function assertEventChannel(channel) {
  if (!eventChannels.has(channel)) {
    throw new Error(`Unsupported desktop event channel: ${channel}`);
  }
}

const api = Object.freeze({
  /** @returns {Promise<AppInfo>} */
  getAppInfo: () => ipcRenderer.invoke("app:getInfo"),

  windows: Object.freeze({
    /** @param {DesktopWindowRole} role */
    toggle: (role) => ipcRenderer.invoke("windows:toggle", role),
    /** @param {DesktopWindowRole} role */
    show: (role) => ipcRenderer.invoke("windows:setVisible", role, true),
    /** @param {DesktopWindowRole} role */
    hide: (role) => ipcRenderer.invoke("windows:setVisible", role, false),
    hideOverlays: () => ipcRenderer.invoke("windows:hideOverlays"),
    /** @param {Extract<DesktopWindowRole, "overlay" | "answer">} role @param {boolean} enabled */
    setClickThrough: (role, enabled) => ipcRenderer.invoke("windows:setClickThrough", role, Boolean(enabled))
  }),

  capture: Object.freeze({
    /** @returns {Promise<CaptureSource[]>} */
    listSources: () => ipcRenderer.invoke("capture:listSources"),
    /** @param {{ sourceId?: string }} [options] @returns {Promise<CaptureSource>} */
    screenshot: (options = {}) => ipcRenderer.invoke("capture:screenshot", options)
  }),

  stealth: Object.freeze({
    /** @returns {Promise<{ config: any, personas: any[], shortcuts: Record<string, string>, overlayClickThrough: boolean }>} */
    get: () => ipcRenderer.invoke("stealth:get"),
    /** @param {Partial<{ enabled: boolean, persona: string, defaultClickThrough: boolean, autoHideOnBlur: boolean }>} patch */
    update: (patch) => ipcRenderer.invoke("stealth:update", patch || {}),
    /** @param {boolean} enabled */
    setClickThrough: (enabled) => ipcRenderer.invoke("stealth:setClickThrough", enabled),
    panic: () => ipcRenderer.invoke("stealth:panic")
  }),

  shortcuts: Object.freeze({
    /**
     * @param {DesktopEventChannel} channel
     * @param {(payload: unknown) => void} listener
     * @returns {() => void}
     */
    on: (channel, listener) => {
      assertEventChannel(channel);
      if (typeof listener !== "function") {
        throw new TypeError("Desktop event listener must be a function.");
      }

      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    /** @param {DesktopEventChannel} channel */
    removeAllListeners: (channel) => {
      assertEventChannel(channel);
      ipcRenderer.removeAllListeners(channel);
    }
  })
});

contextBridge.exposeInMainWorld("secondChair", api);
contextBridge.exposeInMainWorld("interviewCopilot", api);
