import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { QuestionCard, ProviderSettings, TranscriptEvent } from "../shared/domain";
import { DeepgramTranscriber } from "./deepgramTranscriber";
import { resolveCapability, type ResolvedCapability } from "./providerRegistry";
import { newUtterancesSincePrevious } from "./interviewUtterances";
import { looksQuestionReady } from "./transcriptPipeline";
import { NvidiaRivaStreamingTranscriber } from "./nvidiaRivaStreamingTranscriber";
import { OpenAiRealtimeWhisperTranscriber } from "./openAiRealtimeWhisperTranscriber";
import { resolveStreamingSttCapabilities } from "./streamingStt";

type TranscriptSource = TranscriptEvent["source"];

interface StreamingSessionDeps {
  appendTranscriptAndDetect: (
    event: TranscriptEvent,
    options?: { streamSnapshot?: string },
  ) => Promise<QuestionCard[]>;
  makeId: (prefix: string) => string;
  getProviderSettings: () => ProviderSettings;
}

interface StreamingTranscriber {
  start(config?: { sampleRate?: number }): void;
  sendAudio(buffer: Buffer): void;
  stop(): void;
  cleanup(): void;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function audioSourceFromInput(source: unknown): TranscriptSource {
  return source === "mic" || source === "mixed" ? source : "system";
}

type StreamingEmitEvent =
  | {
    type: "transcript";
    text: string;
    isFinal: boolean;
    speechFinal: boolean;
    timestamp: number;
  }
  | { type: "utterance_end"; timestamp: number }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string }
  | { type: "stopped" };

function createStreamingTranscriber(
  resolved: ResolvedCapability,
  emit: (event: StreamingEmitEvent) => void,
): StreamingTranscriber {
  if (!resolved.enabled || !resolved.adapterType) {
    throw new Error("Streaming transcription provider is not configured.");
  }

  if (resolved.adapterType === "deepgram-streaming") {
    return new DeepgramTranscriber({
      apiKey: resolved.apiKey,
      emit: (event) => {
        if (event.type === "ready") {
          emit({ type: "ready" });
          return;
        }
        emit(event);
      },
    });
  }

  if (resolved.adapterType === "openai-realtime-transcription") {
    return new OpenAiRealtimeWhisperTranscriber({
      resolved,
      emit: (event) => {
        if (event.type === "ready") {
          emit({ type: "ready" });
          return;
        }
        emit(event);
      },
    });
  }

  if (resolved.adapterType === "nvidia-riva-stt") {
    return new NvidiaRivaStreamingTranscriber({
      resolved,
      emit: (event) => emit(event),
    });
  }

  throw new Error(`Streaming is not supported for adapter ${resolved.adapterType}.`);
}

export function attachStreamingTranscriptionServer(server: Server, deps: StreamingSessionDeps): void {
  const wss = new WebSocketServer({ server, path: "/ws/transcription" });

  wss.on("connection", (clientWs) => {
    let transcriber: StreamingTranscriber | null = null;
    let source: TranscriptSource = "system";
    const capabilities = resolveStreamingSttCapabilities(deps.getProviderSettings());
    const sttResolved = resolveCapability("stt");
    let started = false;
    let lastFinalText = "";
    let lastPersistedSnapshot = "";

    const pushSessionUpdate = (event: TranscriptEvent, streamSnapshot?: string) => {
      void deps.appendTranscriptAndDetect(event, { streamSnapshot }).then((questions) => {
        sendJson(clientWs, {
          type: "session_update",
          event,
          questions,
        });
      }).catch((error) => {
        sendJson(clientWs, {
          type: "error",
          message: error instanceof Error ? error.message : "Question detection failed.",
        });
      });
    };

    const persistUtterances = (fullText: string, timestamp: number, utterances: string[]) => {
      if (!utterances.length) return;

      lastPersistedSnapshot = fullText;
      for (const utterance of utterances) {
        const event: TranscriptEvent = {
          id: deps.makeId("transcript"),
          source,
          text: utterance,
          isFinal: true,
          timestamp,
        };
        pushSessionUpdate(event, fullText);
      }
    };

    const extractReadyUtterances = (fullText: string, allowInterim: boolean) => {
      const utterances = newUtterancesSincePrevious(fullText, lastPersistedSnapshot);
      if (!allowInterim) return utterances;
      return utterances.filter((utterance) => looksQuestionReady(utterance, allowInterim));
    };

    const destroyTranscriber = () => {
      transcriber?.stop();
      transcriber = null;
      started = false;
      lastFinalText = "";
      lastPersistedSnapshot = "";
    };

    const handleTranscript = async (
      text: string,
      isFinal: boolean,
      speechFinal: boolean,
      timestamp: number,
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      sendJson(clientWs, {
        type: "transcript",
        source,
        text: trimmed,
        isFinal,
        speechFinal,
        timestamp,
      });

      if (!isFinal && !speechFinal) {
        const readyUtterances = extractReadyUtterances(trimmed, true);
        if (readyUtterances.length) {
          persistUtterances(trimmed, timestamp, readyUtterances);
        }
        return;
      }

      const shouldPersist = speechFinal || (isFinal && trimmed !== lastFinalText);
      if (!shouldPersist) return;

      lastFinalText = trimmed;
      persistUtterances(trimmed, timestamp, extractReadyUtterances(trimmed, false));
    };

    clientWs.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!started || !transcriber) return;
        transcriber.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        sendJson(clientWs, { type: "error", message: "Invalid control message." });
        return;
      }

      if (payload.type === "start") {
        destroyTranscriber();
        source = audioSourceFromInput(payload.source);

        if (!capabilities.available || !capabilities.provider) {
          sendJson(clientWs, {
            type: "error",
            message: "Streaming transcription is not configured for the selected STT provider.",
          });
          return;
        }

        try {
          transcriber = createStreamingTranscriber(sttResolved, (event) => {
            if (event.type === "ready") {
              started = true;
              sendJson(clientWs, {
                type: "ready",
                provider: capabilities.provider,
                model: capabilities.model,
                source,
              });
              return;
            }

            if (event.type === "error") {
              sendJson(clientWs, event);
              return;
            }

            if (event.type === "closed") {
              sendJson(clientWs, event);
              destroyTranscriber();
              return;
            }

            if (event.type === "stopped") {
              sendJson(clientWs, event);
              return;
            }

            if (event.type === "utterance_end") {
              sendJson(clientWs, event);
              if (lastFinalText.trim()) {
                persistUtterances(
                  lastFinalText.trim(),
                  event.timestamp,
                  extractReadyUtterances(lastFinalText.trim(), false),
                );
              }
              return;
            }

            if (event.type === "transcript") {
              void handleTranscript(event.text, event.isFinal, event.speechFinal, event.timestamp);
            }
          });
          if (sttResolved.adapterType === "deepgram-streaming") {
            (transcriber as DeepgramTranscriber).start({
              model: sttResolved.model,
              endpointing: Number(sttResolved.options.deepgramEndpointingMs || 500),
              utteranceEndMs: Number(sttResolved.options.deepgramUtteranceEndMs || 800),
            });
          } else if (sttResolved.adapterType === "openai-realtime-transcription") {
            transcriber.start({ sampleRate: Number(payload.sampleRate) || 16000 });
          } else {
            transcriber.start();
          }
        } catch (error) {
          sendJson(clientWs, {
            type: "error",
            message: error instanceof Error ? error.message : "Streaming transcription failed to start.",
          });
        }
        return;
      }

      if (payload.type === "stop") {
        destroyTranscriber();
        sendJson(clientWs, { type: "stopped" });
        return;
      }
    });

    clientWs.on("close", () => {
      destroyTranscriber();
    });
  });
}
