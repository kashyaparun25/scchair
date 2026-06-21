import { useEffect, useState } from "react";
import { EyeOff, GripHorizontal, MonitorDot, ShieldCheck, TerminalSquare } from "lucide-react";

type StealthPersona = {
  id: string;
  label: string;
  processTitle: string;
  appName: string;
};

type StealthConfig = {
  enabled: boolean;
  persona: string;
  defaultClickThrough: boolean;
  autoHideOnBlur: boolean;
};

type StealthInfo = {
  config: StealthConfig;
  personas: StealthPersona[];
  shortcuts: Record<string, string>;
  overlayClickThrough: boolean;
};

type StealthBridge = {
  get: () => Promise<StealthInfo>;
  update: (patch: Partial<StealthConfig>) => Promise<{ config: StealthConfig; overlayClickThrough: boolean }>;
  setClickThrough: (enabled: boolean) => Promise<{ clickThrough: boolean }>;
  panic: () => Promise<{ visible: boolean }>;
};

type ShortcutBridge = {
  on?: (
    channel:
      | "shortcut:captureScreenshot"
      | "shortcut:toggleAnswer"
      | "shortcut:toggleOverlay"
      | "shortcut:hideOverlays"
      | "shortcut:toggleVisibility"
      | "shortcut:toggleInteraction"
      | "stealth:changed",
    listener: (payload: unknown) => void
  ) => () => void;
};

type DesktopBridge = {
  stealth?: StealthBridge;
  shortcuts?: ShortcutBridge;
};

function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window.interviewCopilot || window.secondChair) as DesktopBridge | undefined;
}

const PERSONA_ICONS: Record<string, typeof TerminalSquare> = {
  none: ShieldCheck,
  terminal: TerminalSquare,
  activity: MonitorDot,
  settings: ShieldCheck
};

const PERSONA_NOTES: Record<string, string> = {
  none: "Use the normal Second Chair app and window name.",
  terminal: "Use Terminal-style app and window labels.",
  activity: "Use Activity Monitor-style app and window labels.",
  settings: "Use System Settings-style app and window labels."
};

function describeShortcut(accelerator: string | undefined): string {
  if (!accelerator) return "—";
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
  return accelerator
    .replace(/CommandOrControl/g, isMac ? "⌘" : "Ctrl")
    .replace(/\+/g, " ")
    .replace(/Shift/g, "⇧")
    .replace(/Alt/g, "⌥");
}

export function StealthPanel() {
  const [info, setInfo] = useState<StealthInfo | null>(null);
  const [status, setStatus] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const bridge = getDesktopBridge();
    setIsDesktop(Boolean(bridge?.stealth));
    if (!bridge?.stealth) return;

    let cancelled = false;
    bridge.stealth
      .get()
      .then((payload: StealthInfo) => {
        if (cancelled) return;
        setInfo(payload);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : "Stealth settings unavailable.");
      });

    const unsubscribe = bridge.shortcuts?.on?.("stealth:changed", (payload) => {
      const next = payload as { config: StealthConfig; overlayClickThrough: boolean } | undefined;
      if (!next) return;
      setInfo((current) => (current ? { ...current, config: next.config, overlayClickThrough: next.overlayClickThrough } : current));
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  if (!isDesktop) {
    return (
      <section className="settings-section settings-section-wide">
        <header className="panel-header">
          <div className="panel-header-icon"><ShieldCheck size={18} /></div>
          <div>
            <span className="eyebrow">Window controls</span>
            <h3>Low-profile overlay</h3>
          </div>
        </header>
        <p className="settings-note">
          Window labels, click-through, quick hide, and overlay shortcuts run inside the Second Chair desktop app.
          Launch via <code>npm run dev:desktop</code> or the one-line installer to use them.
        </p>
      </section>
    );
  }

  if (!info) {
    return (
      <section className="settings-section settings-section-wide">
        <header className="panel-header">
          <div className="panel-header-icon"><ShieldCheck size={18} /></div>
          <div>
            <span className="eyebrow">Window controls</span>
            <h3>Low-profile overlay</h3>
          </div>
        </header>
        <p className="settings-note">{status || "Loading window controls..."}</p>
      </section>
    );
  }

  const { config, personas, shortcuts, overlayClickThrough } = info;

  const update = async (patch: Partial<StealthConfig>) => {
    const bridge = getDesktopBridge();
    if (!bridge?.stealth) return;
    setStatus("Saving...");
    try {
      const result = await bridge.stealth.update(patch);
      setInfo((current) => (current ? { ...current, ...result, personas: current.personas, shortcuts: current.shortcuts } : current));
      setStatus("Saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Window control update failed.");
    }
  };

  const panic = async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.stealth) return;
    setStatus("Hiding overlays...");
    try {
      const result = await bridge.stealth.panic();
      setStatus(result.visible ? "Overlays restored." : "Overlays hidden. Use the shortcut again to bring them back.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Panic toggle failed.");
    }
  };

  return (
    <section className="settings-section settings-section-wide">
      <header className="panel-header">
        <div className="panel-header-icon"><ShieldCheck size={18} /></div>
        <div>
          <span className="eyebrow">Window controls</span>
          <h3>Low-profile overlay</h3>
        </div>
      </header>

      <p className="settings-note">
        Tune app/window labels and overlay behavior for a lower-profile desktop experience. These controls only affect presentation and interaction behavior.
      </p>

      <div className="stealth-row">
        <label className="stealth-toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => void update({ enabled: event.target.checked })}
          />
          <span>
            <strong>Use alternate app labels</strong>
            <span className="settings-note">Apply the selected label to the app process and desktop windows.</span>
          </span>
        </label>
      </div>

      <div className={`stealth-body ${config.enabled ? "" : "disabled"}`}>
        <span className="field-label">App label</span>
        <div className="stealth-persona-grid">
          {personas.map((persona) => {
            const Icon = PERSONA_ICONS[persona.id] || ShieldCheck;
            const active = config.persona === persona.id;
            return (
              <button
                key={persona.id}
                type="button"
                className={`stealth-persona-card ${active ? "active" : ""}`}
                aria-pressed={active}
                onClick={() => void update({ persona: persona.id })}
                disabled={!config.enabled}
              >
                <Icon size={18} />
                <strong>{persona.label}</strong>
                <span>{PERSONA_NOTES[persona.id]}</span>
              </button>
            );
          })}
        </div>

        <div className="stealth-toggles">
          <label className="stealth-toggle">
            <input
              type="checkbox"
              checked={config.defaultClickThrough}
              onChange={(event) => void update({ defaultClickThrough: event.target.checked })}
              disabled={!config.enabled}
            />
            <span>
              <strong><GripHorizontal size={14} /> Click-through overlay by default</strong>
              <span className="settings-note">Overlay starts in pass-through mode. Press {describeShortcut(shortcuts?.toggleInteraction)} to flip.</span>
            </span>
          </label>
          <label className="stealth-toggle">
            <input
              type="checkbox"
              checked={config.autoHideOnBlur}
              onChange={(event) => void update({ autoHideOnBlur: event.target.checked })}
              disabled={!config.enabled}
            />
            <span>
              <strong><EyeOff size={14} /> Auto-hide overlay when it loses focus</strong>
              <span className="settings-note">Overlay hides when you click away. Re-open with the shortcut.</span>
            </span>
          </label>
        </div>

        <div className="stealth-shortcuts" aria-label="Stealth shortcuts">
          <div className="stealth-shortcut">
            <span>Quick hide / restore overlays</span>
            <kbd>{describeShortcut(shortcuts?.toggleVisibility)}</kbd>
            <button
              type="button"
              className="ghost-action compact"
              onClick={() => void panic()}
            >
              Run now
            </button>
          </div>
          <div className="stealth-shortcut">
            <span>Toggle click-through</span>
            <kbd>{describeShortcut(shortcuts?.toggleInteraction)}</kbd>
            <span className="settings-note stealth-shortcut-state">Currently: {overlayClickThrough ? "on" : "off"}</span>
          </div>
          <div className="stealth-shortcut">
            <span>Hide overlays</span>
            <kbd>{describeShortcut(shortcuts?.hideOverlays)}</kbd>
          </div>
          <div className="stealth-shortcut">
            <span>Show floating overlay</span>
            <kbd>{describeShortcut(shortcuts?.toggleOverlay)}</kbd>
          </div>
          <div className="stealth-shortcut">
            <span>Show detached answer</span>
            <kbd>{describeShortcut(shortcuts?.toggleAnswer)}</kbd>
          </div>
          <div className="stealth-shortcut">
            <span>Capture screenshot</span>
            <kbd>{describeShortcut(shortcuts?.captureScreenshot)}</kbd>
          </div>
        </div>
      </div>

      {status && <p className="live-notice" role="status">{status}</p>}
    </section>
  );
}
