import type { ProviderCapability } from "./domain";
import type {
  AppConfig,
  AppConfigPreferences,
  CapabilityRoute,
  ProviderAdapterType,
  ProviderEndpoint,
} from "./appConfig";

export type ProviderPresetId = "openai" | "gemini" | "anthropic" | "nvidia";

export interface StackModelDefaults {
  llm: string;
  llmLive: string;
  stt: string;
  embeddings: string;
}

export type SttLanguageScope = "english-only" | "multilingual" | "provider-default";

export interface SttLanguageMetadata {
  scope: SttLanguageScope;
  defaultLanguageCode: string;
  languageCodeOption?: string;
  supportedLanguageCodes?: string[];
  note: string;
}

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  tagline: string;
  /** Keys the user should enter for this stack. `optional` keys enable fallbacks or extras. */
  keys: Array<{ endpointId: string; label: string; optional?: boolean }>;
  models: StackModelDefaults;
  /** Which endpoint powers each capability for this stack (may differ from the primary). */
  routingEndpoints: Record<ProviderCapability, string>;
  buildEndpoint: () => Omit<ProviderEndpoint, "apiKey">;
  notes?: string[];
}

const OPENAI_BASE = "https://api.openai.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

const PARAKEET_MULTILINGUAL_SAMPLE_CODES = [
  "auto",
  "en-US",
  "es-ES",
  "fr-FR",
  "de-DE",
  "it-IT",
  "pt-BR",
  "hi-IN",
] as const;

export const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    tagline: "GPT for answers, realtime captions, and document search — all from one key.",
    keys: [{ endpointId: "openai", label: "OpenAI API key" }],
    models: {
      llm: "gpt-5.4",
      llmLive: "gpt-5.4-mini",
      stt: "gpt-realtime-whisper",
      embeddings: "text-embedding-3-large",
    },
    routingEndpoints: {
      llm: "openai",
      stt: "openai",
      embeddings: "openai",
    },
    buildEndpoint: () => ({
      id: "openai",
      label: "OpenAI",
      baseUrl: OPENAI_BASE,
      adapters: {
        llm: "openai-compatible-chat",
        stt: "openai-realtime-transcription",
        embeddings: "openai-compatible-embeddings",
      },
      options: {},
    }),
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    tagline: "Gemini 3.1 Pro for answers and Gemini embeddings. Live captions use OpenAI when you add that key.",
    keys: [
      { endpointId: "gemini", label: "Gemini API key" },
      { endpointId: "openai", label: "OpenAI API key (live captions)", optional: true },
    ],
    models: {
      llm: "gemini-3.1-pro-preview",
      llmLive: "gemini-2.5-flash",
      stt: "gpt-realtime-whisper",
      embeddings: "gemini-embedding-2",
    },
    routingEndpoints: {
      llm: "gemini",
      stt: "openai",
      embeddings: "gemini",
    },
    buildEndpoint: () => ({
      id: "gemini",
      label: "Google Gemini",
      baseUrl: GEMINI_BASE,
      adapters: {
        llm: "gemini-generate",
        embeddings: "gemini-embeddings",
      },
      options: {},
    }),
    notes: [
      "Gemini does not yet expose a low-latency streaming STT API like OpenAI Realtime Whisper.",
      "Add an OpenAI key for live captions, or the app falls back to browser speech recognition.",
    ],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    tagline: "Claude Sonnet 4.6 for answers. OpenAI powers live captions and document search.",
    keys: [
      { endpointId: "anthropic", label: "Anthropic API key" },
      { endpointId: "openai", label: "OpenAI API key (captions + search)" },
    ],
    models: {
      llm: "claude-sonnet-4-6",
      llmLive: "claude-sonnet-4-6",
      stt: "gpt-realtime-whisper",
      embeddings: "text-embedding-3-large",
    },
    routingEndpoints: {
      llm: "anthropic",
      stt: "openai",
      embeddings: "openai",
    },
    buildEndpoint: () => ({
      id: "anthropic",
      label: "Anthropic",
      baseUrl: ANTHROPIC_BASE,
      adapters: { llm: "anthropic-messages" },
      options: {},
    }),
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    tagline: "Kimi K2 answers, Riva live captions, and NVIDIA embeddings from one NVIDIA key.",
    keys: [{ endpointId: "nvidia-nim", label: "NVIDIA API key" }],
    models: {
      llm: "moonshotai/kimi-k2.6",
      llmLive: "deepseek-ai/deepseek-v4-flash",
      stt: "parakeet-ctc-1.1b-asr",
      embeddings: "nvidia/nv-embedqa-e5-v5",
    },
    routingEndpoints: {
      llm: "nvidia-nim",
      stt: "nvidia-nim",
      embeddings: "nvidia-nim",
    },
    buildEndpoint: () => ({
      id: "nvidia-nim",
      label: "NVIDIA NIM",
      baseUrl: NVIDIA_BASE,
      adapters: {
        llm: "openai-compatible-chat",
        stt: "nvidia-riva-stt",
        embeddings: "openai-compatible-embeddings",
      },
      options: {
        rivaServer: "grpc.nvcf.nvidia.com:443",
        rivaFunctionId: "1598d209-5e27-4d3c-8079-4751568b1081",
        rivaLanguageCode: "en-US",
        rivaTimeoutMs: 30000,
      },
    }),
    notes: [
      "Default Parakeet CTC captions are English-only. Switch the caption model to a multilingual NVIDIA ASR model when you need non-English live captions.",
    ],
  },
};

export const DEFAULT_PROVIDER_STACK: ProviderPresetId = "nvidia";

export const SUPPORTING_OPENAI_ENDPOINT: Omit<ProviderEndpoint, "apiKey"> = {
  id: "openai",
  label: "OpenAI",
  baseUrl: OPENAI_BASE,
  adapters: {
    llm: "openai-compatible-chat",
    stt: "openai-realtime-transcription",
    embeddings: "openai-compatible-embeddings",
  },
  options: {},
};

export function presetList(): ProviderPreset[] {
  const order: ProviderPresetId[] = ["nvidia", "openai", "gemini", "anthropic"];
  return order.map((id) => PROVIDER_PRESETS[id]);
}

export function resolveModels(
  preset: ProviderPreset,
  customModels?: AppConfigPreferences["customModels"],
): StackModelDefaults {
  return {
    llm: customModels?.llm?.trim() || preset.models.llm,
    llmLive: customModels?.llmLive?.trim() || preset.models.llmLive,
    stt: customModels?.stt?.trim() || preset.models.stt,
    embeddings: customModels?.embeddings?.trim() || preset.models.embeddings,
  };
}

function mergeEndpoint(
  existing: ProviderEndpoint | undefined,
  template: Omit<ProviderEndpoint, "apiKey">,
  apiKey: string,
): ProviderEndpoint {
  return {
    ...template,
    apiKey: apiKey.trim() || existing?.apiKey || "",
    baseUrl: existing?.baseUrl?.trim() || template.baseUrl,
    adapters: { ...template.adapters, ...(existing?.adapters || {}) },
    options: { ...template.options, ...(existing?.options || {}) },
    label: existing?.label?.trim() || template.label,
  };
}

function sttRouteForStack(
  preset: ProviderPreset,
  models: StackModelDefaults,
  endpointsById: Map<string, ProviderEndpoint>,
): CapabilityRoute {
  const endpointId = preset.routingEndpoints.stt;
  if (endpointId === "local") {
    return { endpointId: "local", model: "browser-speech-recognition" };
  }
  const endpoint = endpointsById.get(endpointId);
  if (!endpoint?.apiKey.trim() || !endpoint.adapters.stt) {
    return { endpointId: "local", model: "browser-speech-recognition" };
  }
  return { endpointId, model: models.stt };
}

export function applyProviderStack(
  config: AppConfig,
  stackId: ProviderPresetId,
  keyUpdates: Record<string, string> = {},
  customModels?: AppConfigPreferences["customModels"],
): AppConfig {
  const preset = PROVIDER_PRESETS[stackId];
  const models = resolveModels(preset, customModels);
  const existingById = new Map(config.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const endpointsById = new Map(existingById);

  const requiredEndpointIds = new Set<string>([
    preset.buildEndpoint().id,
    ...Object.values(preset.routingEndpoints),
  ]);
  if (preset.routingEndpoints.stt === "openai" || preset.routingEndpoints.embeddings === "openai") {
    requiredEndpointIds.add("openai");
  }

  for (const endpointId of requiredEndpointIds) {
    if (endpointId === "local") continue;

    let template: Omit<ProviderEndpoint, "apiKey">;
    if (endpointId === preset.buildEndpoint().id) {
      template = preset.buildEndpoint();
    } else if (endpointId === "openai") {
      template = SUPPORTING_OPENAI_ENDPOINT;
    } else {
      const existing = existingById.get(endpointId);
      if (!existing) continue;
      template = {
        id: existing.id,
        label: existing.label,
        baseUrl: existing.baseUrl,
        adapters: existing.adapters,
        options: existing.options,
      };
    }

    const previous = existingById.get(endpointId);
    const apiKey = keyUpdates[endpointId] ?? previous?.apiKey ?? "";
    endpointsById.set(endpointId, mergeEndpoint(previous, template, apiKey));
  }

  const routing: Record<ProviderCapability, CapabilityRoute> = {
    llm: {
      endpointId: preset.routingEndpoints.llm,
      model: models.llm,
      liveModel: models.llmLive,
    },
    stt: sttRouteForStack(preset, models, endpointsById),
    embeddings: {
      endpointId: preset.routingEndpoints.embeddings,
      model: models.embeddings,
    },
  };

  return {
    ...config,
    endpoints: Array.from(endpointsById.values()),
    routing,
    preferences: {
      primaryStack: stackId,
      customModels: customModels || config.preferences?.customModels,
    },
    updatedAt: Date.now(),
  };
}

export function defaultPreferences(): AppConfigPreferences {
  return { primaryStack: DEFAULT_PROVIDER_STACK };
}

export function modelFieldsForStack(stackId: ProviderPresetId): Array<{
  key: keyof NonNullable<AppConfigPreferences["customModels"]>;
  label: string;
  hint: string;
}> {
  const preset = PROVIDER_PRESETS[stackId];
  const fields: Array<{
    key: keyof NonNullable<AppConfigPreferences["customModels"]>;
    label: string;
    hint: string;
  }> = [
    { key: "llm", label: "Answer model", hint: preset.models.llm },
    { key: "llmLive", label: "Live answer model", hint: preset.models.llmLive },
    { key: "stt", label: "Caption model", hint: preset.models.stt },
    { key: "embeddings", label: "Search embedding model", hint: preset.models.embeddings },
  ];
  return fields;
}

export function sttLanguageMetadataForModel({
  adapterType,
  model,
}: {
  adapterType?: string | null;
  model: string;
}): SttLanguageMetadata {
  const normalized = model.toLowerCase();

  if (adapterType === "nvidia-riva-stt") {
    if (normalized.includes("parakeet-ctc-1.1b")) {
      return {
        scope: "english-only",
        defaultLanguageCode: "en-US",
        languageCodeOption: "rivaLanguageCode",
        supportedLanguageCodes: ["en-US"],
        note: "NVIDIA Parakeet CTC 1.1B ASR is an English transcription model. Use a multilingual Parakeet/Nemotron ASR model for non-English captions.",
      };
    }
    if (
      normalized.includes("multilingual")
      || normalized.includes("parakeet-tdt-0.6b-v3")
      || normalized.includes("parakeet-1.1b-rnnt")
      || normalized.includes("nemotron")
    ) {
      return {
        scope: "multilingual",
        defaultLanguageCode: "auto",
        languageCodeOption: "rivaLanguageCode",
        supportedLanguageCodes: [...PARAKEET_MULTILINGUAL_SAMPLE_CODES],
        note: "This NVIDIA ASR model is treated as multilingual. Use auto when the model supports language detection, or set a specific BCP-47 language code.",
      };
    }
    return {
      scope: "provider-default",
      defaultLanguageCode: "en-US",
      languageCodeOption: "rivaLanguageCode",
      note: "NVIDIA Riva language support depends on the selected ASR model. Confirm the model's language codes before changing rivaLanguageCode.",
    };
  }

  if (adapterType === "openai-realtime-transcription" || adapterType === "openai-transcriptions") {
    return {
      scope: "multilingual",
      defaultLanguageCode: "en",
      languageCodeOption: "language",
      note: "OpenAI transcription models support multilingual input; an ISO language hint can improve recognition.",
    };
  }

  if (adapterType === "deepgram-streaming") {
    return {
      scope: "multilingual",
      defaultLanguageCode: "multi",
      languageCodeOption: "language",
      note: "Deepgram language support depends on the selected model and language option.",
    };
  }

  return {
    scope: "provider-default",
    defaultLanguageCode: "",
    note: "Language support depends on the selected speech-to-text provider and model.",
  };
}
