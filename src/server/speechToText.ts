import OpenAI, { toFile } from "openai";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderSettings } from "../shared/domain";
import { resolveCapability, type ResolvedCapability } from "./providerRegistry";
import type { SpeechToTextAdapter, SpeechToTextInput } from "./providerSettings";
import { resolvePythonSpawn } from "./runtimeEnv";
import { openAiBatchTranscriptionModel } from "./streamingStt";

export type AudioTranscriptionInput = SpeechToTextInput;

const execFile = promisify(execFileCallback);

export class SpeechToTextUnavailableError extends Error {
  constructor(message = "Server-side speech-to-text is not configured.") {
    super(message);
    this.name = "SpeechToTextUnavailableError";
  }
}

export class SpeechToTextTranscriptionError extends Error {
  constructor(message = "Audio transcription failed.") {
    super(message);
    this.name = "SpeechToTextTranscriptionError";
  }
}

class OpenAISpeechToTextAdapter implements SpeechToTextAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor({ apiKey, baseUrl, model }: { apiKey: string; baseUrl: string; model: string }) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl.replace(/\/+$/, ""),
    });
    this.model = model;
  }

  async transcribe(input: AudioTranscriptionInput): Promise<string> {
    const normalized = normalizeAudioInput(input);
    let transcription: { text: string };
    try {
      const file = await toFile(normalized.audio, normalized.fileName, { type: normalized.mimeType });
      transcription = await this.client.audio.transcriptions.create({
        file,
        model: this.model,
        response_format: "json"
      });
    } catch (error) {
      throw new SpeechToTextTranscriptionError(error instanceof Error ? error.message : undefined);
    }

    return transcription.text.trim();
  }
}

class NvidiaRivaSpeechToTextAdapter implements SpeechToTextAdapter {
  private readonly resolved: ResolvedCapability;

  constructor({ resolved }: { resolved: ResolvedCapability }) {
    this.resolved = resolved;
  }

  async transcribe(input: AudioTranscriptionInput): Promise<string> {
    const normalized = normalizeAudioInput(input);
    if (!isTranscodableAudio(normalized.audio, normalized.mimeType)) return "";

    const workdir = await mkdtemp(path.join(tmpdir(), "second-chair-asr-"));
    const sourcePath = path.join(workdir, normalized.fileName);
    const wavPath = path.join(workdir, "audio.wav");

    try {
      await writeFile(sourcePath, normalized.audio);
      const converted = await transcodeToRivaWav(sourcePath, wavPath, normalized.mimeType);
      if (!converted) return "";
      const scriptPath = path.resolve("scripts/nvidia-riva-asr.py");
      const python = resolvePythonSpawn();
      const { stdout } = await execFile(
        python.command,
        [
          ...python.argsPrefix,
          scriptPath,
          "--input-file",
          wavPath,
          "--server",
          String(this.resolved.options.rivaServer || ""),
          "--function-id",
          String(this.resolved.options.rivaFunctionId || ""),
          "--language-code",
          String(this.resolved.options.rivaLanguageCode || "en-US"),
        ],
        {
          cwd: process.cwd(),
          shell: process.platform === "win32",
          env: {
            ...process.env,
            NVIDIA_API_KEY: this.resolved.apiKey,
            NVIDIA_NIM_STT_MODEL: this.resolved.model,
          },
          maxBuffer: 1024 * 1024,
          timeout: Number(this.resolved.options.rivaTimeoutMs || 30000),
        },
      );
      const parsed = parseNvidiaRivaOutput(stdout);
      if (!parsed) throw new SpeechToTextTranscriptionError("NVIDIA Parakeet returned an empty transcript.");
      return parsed;
    } catch (error) {
      if (error instanceof SpeechToTextTranscriptionError) throw error;
      throw new SpeechToTextTranscriptionError(messageFromProcessError(error));
    } finally {
      await rm(workdir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

export function createConfiguredSpeechToTextAdapter(_settings: ProviderSettings): SpeechToTextAdapter | null {
  const resolved = resolveCapability("stt");
  if (!resolved.enabled || resolved.endpointId === "local") return null;

  if (resolved.adapterType === "openai-transcriptions") {
    return new OpenAISpeechToTextAdapter({
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      model: openAiBatchTranscriptionModel(resolved.model),
    });
  }

  if (resolved.adapterType === "nvidia-riva-stt") {
    return new NvidiaRivaSpeechToTextAdapter({ resolved });
  }

  return null;
}

function normalizeAudioInput(input: AudioTranscriptionInput): Required<Pick<AudioTranscriptionInput, "audio" | "mimeType" | "fileName">> {
  const mimeType = input.mimeType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (mimeType === "audio/pcm" || mimeType === "application/octet-stream") {
    return {
      audio: wrapPcmAsWav(input.audio, {
        sampleRate: input.sampleRate || 16000,
        channels: input.channels || 1,
        bitDepth: input.bitDepth || 16
      }),
      mimeType: "audio/wav",
      fileName: ensureAudioFileName(input.fileName, "wav")
    };
  }

  return {
    audio: input.audio,
    mimeType,
    fileName: ensureAudioFileName(input.fileName, extensionForMimeType(mimeType))
  };
}

function ensureAudioFileName(fileName: string | undefined, extension: string): string {
  const safeName = (fileName || `audio-chunk.${extension}`).replace(/[/\\]/g, "-");
  return /\.[a-z0-9]+$/i.test(safeName) ? safeName : `${safeName}.${extension}`;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("wav") || mimeType.includes("wave")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function wrapPcmAsWav(
  pcm: Buffer,
  options: { sampleRate: number; channels: number; bitDepth: number }
): Buffer {
  const byteRate = options.sampleRate * options.channels * (options.bitDepth / 8);
  const blockAlign = options.channels * (options.bitDepth / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(options.channels, 22);
  header.writeUInt32LE(options.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(options.bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function isTranscodableAudio(audio: Buffer, mimeType: string): boolean {
  if (audio.length < 256) return false;
  if (mimeType.includes("wav") || mimeType.includes("wave")) {
    return audio.length >= 44 && audio.subarray(0, 4).toString("ascii") === "RIFF";
  }
  if (mimeType.includes("webm")) {
    return hasWebmHeader(audio);
  }
  return true;
}

function hasWebmHeader(audio: Buffer): boolean {
  return audio.length >= 4
    && audio[0] === 0x1a
    && audio[1] === 0x45
    && audio[2] === 0xdf
    && audio[3] === 0xa3;
}

async function transcodeToRivaWav(sourcePath: string, wavPath: string, mimeType: string): Promise<boolean> {
  try {
    await execFile("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-sample_fmt",
      "s16",
      wavPath,
    ], { timeout: Number(process.env.NVIDIA_RIVA_FFMPEG_TIMEOUT_MS || 15000) });
    return true;
  } catch (error) {
    if (sourcePath.toLowerCase().endsWith(".wav")) {
      const directAudio = await readFile(sourcePath);
      await writeFile(wavPath, directAudio);
      return true;
    }
    if (mimeType.includes("webm") && !hasWebmHeader(await readFile(sourcePath))) {
      return false;
    }
    throw new SpeechToTextTranscriptionError(`Audio conversion for NVIDIA Parakeet failed: ${messageFromProcessError(error)}`);
  }
}

function parseNvidiaRivaOutput(stdout: string): string {
  const line = lastJsonLine(stdout);
  if (!line) return "";
  try {
    const parsed = JSON.parse(line) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function messageFromProcessError(error: unknown): string {
  if (isProcessError(error)) {
    const stderr = String(error.stderr || "").trim();
    const stdout = String(error.stdout || "").trim();
    if (stderr) {
      try {
        const parsed = JSON.parse(lastJsonLine(stderr) || "");
        if (typeof parsed.error === "string") return parsed.error;
      } catch {
        return stderr;
      }
      return stderr;
    }
    if (stdout) return stdout;
    if (error.message) return error.message;
  }
  return error instanceof Error ? error.message : "NVIDIA Parakeet transcription failed.";
}

function isProcessError(error: unknown): error is Error & { stderr?: unknown; stdout?: unknown } {
  return Boolean(error) && typeof error === "object";
}

function lastJsonLine(output: string): string {
  const lines = output.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() || "";
    if (line.startsWith("{")) return line;
  }
  return "";
}
