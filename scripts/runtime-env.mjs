/** Read SECOND_CHAIR_* with INTERVIEW_COPILOT_* fallback for legacy installs. */
export function runtimeEnv(name, fallback = "") {
  const second = process.env[`SECOND_CHAIR_${name}`];
  if (second !== undefined && String(second).trim() !== "") return String(second).trim();
  const legacy = process.env[`INTERVIEW_COPILOT_${name}`];
  if (legacy !== undefined && String(legacy).trim() !== "") return String(legacy).trim();
  return fallback;
}

/** Windows cannot spawn .cmd/.bat files directly in all Node versions. */
export function prepareSpawn(command, args = []) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

export function spawnOptions(options = {}) {
  return {
    shell: false,
    ...options,
  };
}

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
