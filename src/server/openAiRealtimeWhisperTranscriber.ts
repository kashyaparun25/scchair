import { WebSocket } from "ws";
import type { ResolvedCapability } from "./providerRegistry";

const OPENAI_INPUT_SAMPLE_RATE = 24000;
const COMMIT_INTERVAL_MS = 900;

export interface OpenAiRealtimeTranscriptEvent {
  type: "transcript";
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  timestamp: number;
}

export type OpenAiRealtimeEmitterEvent =
  | { type: "ready" }
  | OpenAiRealtimeTranscriptEvent
  | { type: "utterance_end"; timestamp: number }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string }
  | { type: "stopped" };

function upsamplePcm16(buffer: Buffer, inputRate: number, outputRate: number): Buffer {
  if (inputRate === outputRate) return buffer;
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  const ratio = outputRate / inputRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index / ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[index] = Math.round(input[left] * (1 - weight) + input[right] * weight);
  }

  return Buffer.from(output.buffer);
}

function realtimeWsUrl(baseUrl: string, model: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  const wsBase = normalized.replace(/^http/i, "ws");
  const path = wsBase.includes("/v1") ? `${wsBase}/realtime` : `${wsBase}/v1/realtime`;
  return `${path}?model=${encodeURIComponent(model)}`;
}

export class OpenAiRealtimeWhisperTranscriber {
  private readonly emit: (event: OpenAiRealtimeEmitterEvent) => void;
  private readonly resolved: ResolvedCapability;
  private ws: WebSocket | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private pendingAudio = false;
  private latestDelta = "";
  private inputSampleRate = 16000;

  constructor({
    resolved,
    emit,
  }: {
    resolved: ResolvedCapability;
    emit: (event: OpenAiRealtimeEmitterEvent) => void;
  }) {
    this.emit = emit;
    this.resolved = resolved;
  }

  start(config: { sampleRate?: number } = {}): void {
    this.cleanup();
    this.inputSampleRate = config.sampleRate || 16000;

    if (!this.resolved.apiKey) throw new Error("API key is required for Realtime transcription.");

    this.ws = new WebSocket(realtimeWsUrl(this.resolved.baseUrl, this.resolved.model), {
      headers: {
        Authorization: `Bearer ${this.resolved.apiKey}`,
      },
    });

    this.ws.on("open", () => {
      this.sendJson({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: OPENAI_INPUT_SAMPLE_RATE,
              },
              transcription: {
                model: this.resolved.model,
                language: String(this.resolved.options.language || "en"),
                delay: String(this.resolved.options.delay || "low"),
              },
              turn_detection: null,
            },
          },
        },
      });
      this.commitTimer = setInterval(() => this.commitPendingAudio(), COMMIT_INTERVAL_MS);
      this.emit({ type: "ready" });
    });

    this.ws.on("message", (data) => {
      this.handleMessage(String(data));
    });

    this.ws.on("close", (_code, reason) => {
      this.clearCommitTimer();
      this.emit({ type: "closed", reason: reason?.toString() || "Realtime connection closed." });
    });

    this.ws.on("error", (error) => {
      this.emit({ type: "error", message: error.message || "Realtime WebSocket error." });
    });
  }

  sendAudio(buffer: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !buffer.length) return;

    const upsampled = upsamplePcm16(buffer, this.inputSampleRate, OPENAI_INPUT_SAMPLE_RATE);
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: upsampled.toString("base64"),
    });
    this.pendingAudio = true;
  }

  stop(): void {
    this.commitPendingAudio();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.clearCommitTimer();
    this.emit({ type: "stopped" });
  }

  cleanup(): void {
    this.clearCommitTimer();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.pendingAudio = false;
    this.latestDelta = "";
  }

  private commitPendingAudio(): void {
    if (!this.pendingAudio || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendJson({ type: "input_audio_buffer.commit" });
    this.pendingAudio = false;
  }

  private clearCommitTimer(): void {
    if (this.commitTimer) {
      clearInterval(this.commitTimer);
      this.commitTimer = null;
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(parsed.type || "");
    if (type === "error") {
      const error = parsed.error as { message?: string } | undefined;
      this.emit({ type: "error", message: error?.message || "Realtime transcription error." });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.delta" && typeof parsed.delta === "string") {
      this.latestDelta += parsed.delta;
      this.emit({
        type: "transcript",
        text: this.latestDelta,
        isFinal: false,
        speechFinal: false,
        timestamp: Date.now(),
      });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed" && typeof parsed.transcript === "string") {
      const text = parsed.transcript.trim();
      this.latestDelta = "";
      if (!text) return;
      this.emit({
        type: "transcript",
        text,
        isFinal: true,
        speechFinal: true,
        timestamp: Date.now(),
      });
      this.emit({ type: "utterance_end", timestamp: Date.now() });
    }
  }
}
