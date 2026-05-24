/** Read SECOND_CHAIR_* with INTERVIEW_COPILOT_* fallback for legacy installs. */
export function runtimeEnv(name: string, fallback = ""): string {
  const second = process.env[`SECOND_CHAIR_${name}`];
  if (second?.trim()) return second.trim();
  const legacy = process.env[`INTERVIEW_COPILOT_${name}`];
  if (legacy?.trim()) return legacy.trim();
  return fallback;
}
