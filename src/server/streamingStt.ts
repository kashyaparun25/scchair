import type { ProviderSettings } from "../shared/domain";
import type { SttLanguageMetadata } from "../shared/providerPresets";
import { sttLanguageMetadataForModel } from "../shared/providerPresets";
import { resolveCapability } from "./providerRegistry";
import { openAiBatchTranscriptionModel } from "./providerRegistry";

export type StreamingSttProvider = string;

export interface StreamingSttCapabilities {
  available: boolean;
  provider: StreamingSttProvider | null;
  model: string | null;
  transport: "websocket-pcm";
  sampleRate: number;
  endpoint: string;
  language: SttLanguageMetadata;
}

export function resolveStreamingSttCapabilities(
  settings?: ProviderSettings,
  _apiPort = Number(process.env.API_PORT || 5180),
): StreamingSttCapabilities {
  const endpoint = "/ws/transcription";
  void settings;
  const resolved = resolveCapability("stt");

  if (resolved.endpointId === "local" || !resolved.enabled || !resolved.adapterType) {
    return {
      available: false,
      provider: null,
      model: null,
      transport: "websocket-pcm",
      sampleRate: 16000,
      endpoint,
      language: sttLanguageMetadataForModel({ adapterType: null, model: "browser-speech-recognition" }),
    };
  }

  if (
    resolved.adapterType === "deepgram-streaming"
    || resolved.adapterType === "nvidia-riva-stt"
    || resolved.adapterType === "openai-realtime-transcription"
  ) {
    return {
      available: true,
      provider: resolved.endpointId,
      model: resolved.model,
      transport: "websocket-pcm",
      sampleRate: 16000,
      endpoint,
      language: sttLanguageMetadataForModel({
        adapterType: resolved.adapterType,
        model: resolved.model,
      }),
    };
  }

  return {
    available: false,
    provider: resolved.endpointId,
    model: resolved.model,
    transport: "websocket-pcm",
    sampleRate: 16000,
    endpoint,
    language: sttLanguageMetadataForModel({
      adapterType: resolved.adapterType,
      model: resolved.model,
    }),
  };
}

export { openAiBatchTranscriptionModel };
