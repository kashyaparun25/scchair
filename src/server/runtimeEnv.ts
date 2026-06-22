import path from "node:path";

/** Read SECOND_CHAIR_* with INTERVIEW_COPILOT_* fallback for legacy installs. */
export function runtimeEnv(name: string, fallback = ""): string {
  const second = process.env[`SECOND_CHAIR_${name}`];
  if (second?.trim()) return second.trim();
  const legacy = process.env[`INTERVIEW_COPILOT_${name}`];
  if (legacy?.trim()) return legacy.trim();
  return fallback;
}

/** Resolve Python executable for spawning NVIDIA Riva scripts on each OS. */
export function resolvePythonSpawn(): { command: string; argsPrefix: string[] } {
  const configured = process.env.NVIDIA_RIVA_PYTHON?.trim();
  if (configured) {
    const parts = configured.split(/\s+/).filter(Boolean);
    return { command: parts[0], argsPrefix: parts.slice(1) };
  }
  if (process.platform === "win32") {
    return { command: "py", argsPrefix: ["-3"] };
  }
  return { command: "python3", argsPrefix: [] };
}

/** Resolve resource files both from source checkouts and packaged Electron resources. */
export function resolveResourcePath(...segments: string[]): string {
  const resourceDir = runtimeEnv("RESOURCE_DIR");
  if (resourceDir) return path.join(resourceDir, ...segments);
  return path.resolve(...segments);
}
