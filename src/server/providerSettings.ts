import type {
  ProviderCapability,
  ProviderModelSetting,
  ProviderSettings,
} from "../shared/domain";
import { getProviderSettings as readProviderSettings, patchProviderSettings } from "./appConfigStore";
import {
  buildProviderAdapters,
  defaultLocalModel,
  providerSettingsFromConfig,
} from "./providerRegistry";

export type { ProviderAdapterSummary } from "./providerRegistry";
export { buildProviderAdapters } from "./providerRegistry";

export interface ProviderAdapter {
  capability: ProviderCapability;
  provider: string;
  model: string;
  available: boolean;
  label?: string;
  baseUrl?: string;
  adapterType?: string;
}

export interface SpeechToTextInput {
  audio: Buffer;
  mimeType: string;
  fileName?: string;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
}

export interface SpeechToTextAdapter {
  transcribe(input: SpeechToTextInput): Promise<string>;
}

export interface LanguageModelAdapter {
  streamAnswer(prompt: string): AsyncIterable<string>;
}

export interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>;
}

/** @deprecated use buildProviderAdapters() */
export const providerAdapters = buildProviderAdapters();

export function defaultProviderSettings(now = Date.now()): ProviderSettings {
  return providerSettingsFromConfig(undefined, now);
}

export function normalizeProviderSettings(
  value: unknown,
  previous: ProviderSettings = readProviderSettings(),
  now = Date.now(),
): ProviderSettings {
  const input = value && typeof value === "object" ? value as Partial<ProviderSettings> : {};
  const capabilities: ProviderCapability[] = ["stt", "llm", "embeddings"];
  return capabilities.reduce<ProviderSettings>((settings, capability) => {
    settings[capability] = normalizeProviderSetting(input[capability], previous[capability], capability, now);
    return settings;
  }, {} as ProviderSettings);
}

export function cloneProviderSettings(settings: ProviderSettings | undefined): ProviderSettings {
  const fallback = readProviderSettings();
  if (!settings) return fallback;
  return {
    stt: { ...(settings.stt || fallback.stt) },
    llm: { ...(settings.llm || fallback.llm) },
    embeddings: { ...(settings.embeddings || fallback.embeddings) },
  };
}

function normalizeProviderSetting(
  value: unknown,
  previous: ProviderModelSetting,
  capability: ProviderCapability,
  now: number,
): ProviderModelSetting {
  if (!value || typeof value !== "object") return { ...previous };
  const input = value as Partial<ProviderModelSetting>;
  const provider = typeof input.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : previous.provider;
  const model = typeof input.model === "string" && input.model.trim()
    ? input.model.trim()
    : previous.model || defaultLocalModel(capability);
  const adapters = buildProviderAdapters();
  const adapter = adapters[capability].find((candidate) => candidate.provider === provider);
  const externalAdapter = provider !== "local" && Boolean(adapter?.available);

  return {
    capability,
    provider,
    model,
    adapter: externalAdapter ? "external" : "local-fallback",
    enabled: provider === "local" || externalAdapter,
    adapterType: adapter?.adapterType || input.adapterType,
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : adapter?.baseUrl || previous.baseUrl,
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
  };
}

export function saveProviderSettings(settings: Partial<ProviderSettings>): ProviderSettings {
  const normalized = normalizeProviderSettings(settings);
  patchProviderSettings(normalized);
  return readProviderSettings();
}

export function getProviderSettings(): ProviderSettings {
  return readProviderSettings();
}
