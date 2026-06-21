import "dotenv/config";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function main() {
  const apiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not configured.");
  }

  const llm = await checkLlm(apiKey);
  const audioPath = await ensureSpeechFixture();
  const stt = await checkStt(audioPath);

  console.log(JSON.stringify({ llm, stt }, null, 2));
}

async function checkLlm(apiKey) {
  const model = process.env.NVIDIA_NIM_LLM_MODEL || "moonshotai/kimi-k2.6";
  const baseUrl = process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";
  const started = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: NVIDIA LLM OK" }],
      max_tokens: 32,
      temperature: 0,
      stream: false,
    }),
  });
  const body = await response.text();
  const parsed = tryJson(body);
  const text = parsed?.choices?.[0]?.message?.content || parsed?.error?.message || body;

  return {
    ok: response.ok,
    status: response.status,
    model,
    latencyMs: Date.now() - started,
    text: String(text || "").trim().slice(0, 200),
  };
}

async function ensureSpeechFixture() {
  const configured = process.env.NVIDIA_TEST_AUDIO_FILE;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`NVIDIA_TEST_AUDIO_FILE does not exist: ${configured}`);
    return configured;
  }

  const wavPath = join(tmpdir(), "second-chair-nvidia-test.wav");
  if (existsSync(wavPath)) return wavPath;

  if (process.platform !== "darwin") {
    throw new Error("Set NVIDIA_TEST_AUDIO_FILE to a 16 kHz mono WAV file to run the STT diagnostic on this platform.");
  }

  const aiffPath = join(tmpdir(), "second-chair-nvidia-test.aiff");
  await execFile("say", [
    "-o",
    aiffPath,
    "Second Chair NVIDIA parakeet speech recognition test. The quick brown fox jumps over the lazy dog.",
  ]);
  await execFile("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    aiffPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    wavPath,
  ]);
  return wavPath;
}

async function checkStt(audioPath) {
  const started = Date.now();
  try {
    const python = splitCommand(process.env.NVIDIA_RIVA_PYTHON || defaultPythonCommand());
    const { stdout } = await execFile(python.command, [
      ...python.args,
      "scripts/nvidia-riva-asr.py",
      "--input-file",
      audioPath,
    ], {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: Number(process.env.NVIDIA_RIVA_ASR_TIMEOUT_MS || 30000),
    });
    const parsed = tryJson(lastJsonLine(stdout));
    return {
      ok: Boolean(parsed?.text),
      model: process.env.NVIDIA_NIM_STT_MODEL || "parakeet-ctc-1.1b-asr",
      latencyMs: Date.now() - started,
      text: String(parsed?.text || "").trim().slice(0, 300),
    };
  } catch (error) {
    return {
      ok: false,
      model: process.env.NVIDIA_NIM_STT_MODEL || "parakeet-ctc-1.1b-asr",
      latencyMs: Date.now() - started,
      error: processErrorMessage(error),
    };
  }
}

function defaultPythonCommand() {
  return process.platform === "win32" ? "py -3" : "python3";
}

function splitCommand(commandLine) {
  const parts = String(commandLine || "").split(/\s+/).filter(Boolean);
  return {
    command: parts[0] || defaultPythonCommand(),
    args: parts.slice(1),
  };
}

function lastJsonLine(output) {
  const lines = String(output || "").trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() || "";
    if (line.startsWith("{")) return line;
  }
  return "";
}

function tryJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function processErrorMessage(error) {
  const stderr = String(error?.stderr || "").trim();
  const parsed = tryJson(lastJsonLine(stderr));
  if (parsed?.error) return String(parsed.error);
  return stderr || error?.message || "NVIDIA STT check failed.";
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
