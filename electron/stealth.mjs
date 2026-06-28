import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export const STEALTH_PERSONAS = Object.freeze({
  none: { id: "none", label: "Second Chair", processTitle: "Second Chair", appName: "Second Chair" },
  terminal: { id: "terminal", label: "Terminal", processTitle: "Terminal ", appName: "Terminal " },
  activity: { id: "activity", label: "Activity Monitor", processTitle: "Activity Monitor", appName: "Activity Monitor " },
  settings: { id: "settings", label: "System Settings", processTitle: "System Settings", appName: "System Settings " }
});

export const DEFAULT_STEALTH_CONFIG = Object.freeze({
  enabled: true,
  persona: "terminal",
  defaultClickThrough: false,
  autoHideOnBlur: false
});

const CONFIG_FILE_NAME = "stealth-config.json";

function configFilePath() {
  return path.join(app.getPath("userData"), CONFIG_FILE_NAME);
}

export function loadStealthConfig() {
  try {
    const filePath = configFilePath();
    if (!fs.existsSync(filePath)) return { ...DEFAULT_STEALTH_CONFIG };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (error) {
    console.warn("[stealth] failed to load config, using defaults:", error?.message || error);
    return { ...DEFAULT_STEALTH_CONFIG };
  }
}

export function saveStealthConfig(config) {
  try {
    const filePath = configFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const normalized = normalizeConfig(config);
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  } catch (error) {
    console.warn("[stealth] failed to save config:", error?.message || error);
    return normalizeConfig(config);
  }
}

function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const persona = STEALTH_PERSONAS[source.persona] ? source.persona : DEFAULT_STEALTH_CONFIG.persona;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_STEALTH_CONFIG.enabled,
    persona,
    defaultClickThrough: typeof source.defaultClickThrough === "boolean"
      ? source.defaultClickThrough
      : DEFAULT_STEALTH_CONFIG.defaultClickThrough,
    autoHideOnBlur: typeof source.autoHideOnBlur === "boolean"
      ? source.autoHideOnBlur
      : DEFAULT_STEALTH_CONFIG.autoHideOnBlur
  };
}

export function resolvePersona(config) {
  if (!config.enabled) return STEALTH_PERSONAS.none;
  return STEALTH_PERSONAS[config.persona] || STEALTH_PERSONAS.terminal;
}

export function applyStealth(config) {
  const persona = resolvePersona(config);
  try {
    process.title = persona.processTitle;
  } catch (error) {
    console.warn("[stealth] could not set process.title:", error?.message);
  }

  try {
    if (typeof app.setName === "function") {
      app.setName(persona.appName);
    }
  } catch (error) {
    console.warn("[stealth] could not set app name:", error?.message);
  }

  try {
    if (process.platform === "darwin" && app.dock && typeof app.dock.setBadge === "function") {
      app.dock.setBadge("");
    }
  } catch (error) {
    console.warn("[stealth] could not clear dock badge:", error?.message);
  }

  try {
    if (typeof app.setAppUserModelId === "function") {
      app.setAppUserModelId(`ai.scchair.${persona.id}`);
    }
  } catch (error) {
    console.warn("[stealth] could not set app user model id:", error?.message);
  }

  return persona;
}

export function applyWindowTitle(window, config) {
  if (!window || window.isDestroyed()) return;
  const persona = resolvePersona(config);
  try {
    window.setTitle(persona.label);
  } catch (error) {
    console.warn("[stealth] could not update window title:", error?.message);
  }
}
