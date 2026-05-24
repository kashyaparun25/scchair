import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { ResolvedCapability } from "./providerRegistry";

export interface NvidiaRivaTranscriptEvent {
  type: "transcript";
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  timestamp: number;
}

export type NvidiaRivaEmitterEvent =
  | { type: "ready" }
  | NvidiaRivaTranscriptEvent
  | { type: "error"; message: string }
  | { type: "closed"; reason: string }
  | { type: "stopped" };

const GRACEFUL_STOP_MS = Number(process.env.NVIDIA_RIVA_STREAM_STOP_MS || 2500);
const FORCE_KILL_MS = Number(process.env.NVIDIA_RIVA_STREAM_KILL_MS || 1500);

export class NvidiaRivaStreamingTranscriber {
  private readonly emit: (event: NvidiaRivaEmitterEvent) => void;
  private readonly resolved: ResolvedCapability;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: readline.Interface | null = null;
  private ready = false;
  private stopping = false;
  private pendingAudio: Buffer[] = [];
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  private gracefulStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({
    resolved,
    emit,
  }: {
    resolved: ResolvedCapability;
    emit: (event: NvidiaRivaEmitterEvent) => void;
  }) {
    this.emit = emit;
    this.resolved = resolved;
  }

  start(): void {
    this.releaseProcess();

    const scriptPath = path.resolve("scripts/nvidia-riva-stream.py");
    this.process = spawn(process.env.NVIDIA_RIVA_PYTHON || "python3", ["-u", scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NVIDIA_API_KEY: this.resolved.apiKey,
        NVIDIA_NIM_STT_MODEL: this.resolved.model,
        NVIDIA_RIVA_ASR_SERVER: String(this.resolved.options.rivaServer || ""),
        NVIDIA_RIVA_ASR_FUNCTION_ID: String(this.resolved.options.rivaFunctionId || ""),
        NVIDIA_RIVA_ASR_LANGUAGE_CODE: String(this.resolved.options.rivaLanguageCode || "en-US"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stdoutReader = readline.createInterface({ input: this.process.stdout });
    this.stdoutReader.on("line", (line) => {
      this.handleLine(line);
    });

    this.process.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (!message || this.isBenignShutdownNoise(message)) return;
      this.emit({ type: "error", message });
    });

    this.process.on("close", (code) => {
      this.clearStopTimers();
      const reason = code === 0 || code === null
        ? "NVIDIA Riva stream closed."
        : `NVIDIA Riva stream exited with code ${code}.`;
      this.releaseProcess();
      if (this.stopping) {
        this.emit({ type: "stopped" });
        return;
      }
      this.emit({ type: "closed", reason });
    });

    this.process.on("error", (error) => {
      this.emit({ type: "error", message: error.message || "NVIDIA Riva stream failed to start." });
    });
  }

  private isBenignShutdownNoise(message: string): boolean {
    return message.includes("interpreter shutdown")
      || message.includes("could not acquire lock")
      || message.includes("daemon threads");
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type === "ready") {
      this.ready = true;
      this.emit({ type: "ready" });
      for (const chunk of this.pendingAudio) {
        this.writeChunk(chunk);
      }
      this.pendingAudio = [];
      return;
    }

    if (parsed.type === "error") {
      this.emit({ type: "error", message: String(parsed.message || "NVIDIA Riva streaming error.") });
      return;
    }

    if (parsed.type === "stopped") {
      return;
    }

    if (parsed.type === "transcript" && typeof parsed.text === "string") {
      const isFinal = Boolean(parsed.isFinal);
      this.emit({
        type: "transcript",
        text: parsed.text.trim(),
        isFinal,
        speechFinal: Boolean(parsed.speechFinal ?? isFinal),
        timestamp: Date.now(),
      });
    }
  }

  sendAudio(buffer: Buffer): void {
    if (!this.process?.stdin.writable || this.stopping) return;
    if (!this.ready) {
      this.pendingAudio.push(buffer);
      return;
    }
    this.writeChunk(buffer);
  }

  private writeChunk(buffer: Buffer): void {
    if (!this.process?.stdin.writable || this.stopping) return;
    this.process.stdin.write(buffer);
  }

  stop(): void {
    if (!this.process || this.stopping) return;
    this.stopping = true;
    this.ready = false;
    this.pendingAudio = [];

    const proc = this.process;
    if (proc.stdin.writable && !proc.stdin.destroyed) {
      proc.stdin.end();
    }

    this.gracefulStopTimer = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        proc.kill("SIGTERM");
      }
      this.forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill("SIGKILL");
        }
      }, FORCE_KILL_MS);
    }, GRACEFUL_STOP_MS);
  }

  cleanup(): void {
    this.stop();
  }

  private clearStopTimers(): void {
    if (this.gracefulStopTimer) {
      clearTimeout(this.gracefulStopTimer);
      this.gracefulStopTimer = null;
    }
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }
  }

  private releaseProcess(): void {
    this.clearStopTimers();
    this.ready = false;
    this.stopping = false;
    this.pendingAudio = [];
    this.stdoutReader?.close();
    this.stdoutReader = null;
    this.process = null;
  }
}
