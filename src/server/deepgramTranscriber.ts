import { WebSocket } from "ws";

const KEEPALIVE_INTERVAL_MS = 8000;
const FINALIZE_DRAIN_MS = 450;

export interface DeepgramTranscriptEvent {
  type: "transcript";
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  timestamp: number;
}

export type DeepgramEmitterEvent =
  | { type: "ready"; mode: "online" }
  | DeepgramTranscriptEvent
  | { type: "utterance_end"; timestamp: number }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string }
  | { type: "stopped" };

function buildDeepgramUrl(config: {
  model?: string;
  language?: string;
  sampleRate?: number;
  endpointing?: number;
  utteranceEndMs?: number;
} = {}): string {
  const params = new URLSearchParams({
    model: config.model || "nova-3",
    language: config.language || "en-US",
    encoding: "linear16",
    sample_rate: String(config.sampleRate || 16000),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: String(config.endpointing ?? 500),
    utterance_end_ms: String(config.utteranceEndMs ?? 800),
    vad_events: "true",
  });

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

export class DeepgramTranscriber {
  private readonly apiKey: string;
  private readonly emit: (event: DeepgramEmitterEvent) => void;
  private dgWs: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ apiKey, emit }: { apiKey: string; emit: (event: DeepgramEmitterEvent) => void }) {
    if (!apiKey) throw new Error("Missing DEEPGRAM_API_KEY on the server.");
    this.apiKey = apiKey;
    this.emit = emit;
  }

  start(config: {
    model?: string;
    language?: string;
    sampleRate?: number;
    endpointing?: number;
    utteranceEndMs?: number;
  } = {}): void {
    this.cleanup();

    this.dgWs = new WebSocket(buildDeepgramUrl(config), {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.dgWs.on("open", () => {
      this.emit({ type: "ready", mode: "online" });
      this.keepAliveTimer = setInterval(() => {
        if (this.dgWs?.readyState === WebSocket.OPEN) {
          this.dgWs.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    this.dgWs.on("message", (data, isBinary) => {
      if (isBinary) return;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        this.emit({ type: "error", message: "Unable to parse Deepgram response." });
        return;
      }

      this.handleDeepgramMessage(parsed);
    });

    this.dgWs.on("close", (_code, reason) => {
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      this.emit({ type: "closed", reason: reason?.toString() || "Connection closed." });
    });

    this.dgWs.on("error", (error) => {
      this.emit({ type: "error", message: error.message || "Deepgram WebSocket error." });
    });
  }

  private handleDeepgramMessage(payload: Record<string, unknown>): void {
    if (payload.type === "Results") {
      const channel = payload.channel as { alternatives?: Array<{ transcript?: string }> } | undefined;
      const transcript = channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript) return;

      this.emit({
        type: "transcript",
        text: transcript,
        isFinal: Boolean(payload.is_final),
        speechFinal: Boolean(payload.speech_final),
        timestamp: Date.now(),
      });
      return;
    }

    if (payload.type === "UtteranceEnd") {
      this.emit({ type: "utterance_end", timestamp: Date.now() });
    }
  }

  sendAudio(buffer: Buffer): void {
    if (this.dgWs?.readyState === WebSocket.OPEN) {
      this.dgWs.send(buffer);
    }
  }

  stop(): void {
    if (this.dgWs?.readyState === WebSocket.OPEN) {
      this.dgWs.send(JSON.stringify({ type: "Finalize" }));
      this.finalizeTimer = setTimeout(() => {
        this.cleanup();
        this.emit({ type: "stopped" });
      }, FINALIZE_DRAIN_MS);
      return;
    }

    this.cleanup();
    this.emit({ type: "stopped" });
  }

  cleanup(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    if (this.dgWs?.readyState === WebSocket.OPEN) {
      this.dgWs.close();
    }
    this.dgWs = null;
  }
}
