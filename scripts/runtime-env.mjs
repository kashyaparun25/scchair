/** Read SECOND_CHAIR_* with INTERVIEW_COPILOT_* fallback for legacy installs. */
export function runtimeEnv(name, fallback = "") {
  const second = process.env[`SECOND_CHAIR_${name}`];
  if (second !== undefined && String(second).trim() !== "") return String(second).trim();
  const legacy = process.env[`INTERVIEW_COPILOT_${name}`];
  if (legacy !== undefined && String(legacy).trim() !== "") return String(legacy).trim();
  return fallback;
}
