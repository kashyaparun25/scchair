import type { ProviderCapability, ProviderModelSetting, ProviderSettings } from "../shared/domain";
import type {
  AppConfig,
  CapabilityRoute,
  ProviderAdapterType,
  ProviderEndpoint,
} from "../shared/appConfig";
import { getAppConfig } from "./appConfigStore";

export interface ResolvedCapability {
  capability: ProviderCapability;
  endpointId: string;
  model: string;
  liveModel?: string;
  adapterType: ProviderAdapterType | null;
  apiKey: string;
  baseUrl: string;
  options: Record<string, string | number | boolean>;
  enabled: boolean;
}

export interface ProviderAdapterSummary {
  capability: ProviderCapability;
  provider: string;
  label: string;
  model: string;
  adapterType: ProviderAdapterType | null;
  available: boolean;
  baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getEndpoint(config: AppConfig, id: string): ProviderEndpoint | undefined {
  return config.endpoints.find((endpoint) => endpoint.id === id);
}

export function endpointSupportsCapability(endpoint: ProviderEndpoint, capability: ProviderCapability): boolean {
  return Boolean(endpoint.adapters[capability]);
}

export function resolveCapability(
  capability: ProviderCapability,
  config: AppConfig = getAppConfig(),
): ResolvedCapability {
  const route = config.routing[capability];
  if (!route || route.endpointId === "local") {
    return {
      capability,
      endpointId: "local",
      model: route?.model || defaultLocalModel(capability),
      adapterType: null,
      apiKey: "",
      baseUrl: "",
      options: {},
      enabled: true,
    };
  }

  const endpoint = getEndpoint(config, route.endpointId);
  if (!endpoint) {
    return {
      capability,
      endpointId: route.endpointId,
      model: route.model,
      liveModel: route.liveModel,
      adapterType: null,
      apiKey: "",
      baseUrl: route.baseUrl || "",
      options: {},
      enabled: false,
    };
  }

  const adapterType = endpoint.adapters[capability] || null;
  return {
    capability,
    endpointId: endpoint.id,
    model: route.model,
    liveModel: route.liveModel,
    adapterType,
    apiKey: endpoint.apiKey.trim(),
    baseUrl: (route.baseUrl || endpoint.baseUrl || "").trim(),
    options: endpoint.options || {},
    enabled: Boolean(adapterType && endpoint.apiKey.trim()),
  };
}

export function providerSettingsFromConfig(config: AppConfig = getAppConfig(), now = Date.now()): ProviderSettings {
  const capabilities: ProviderCapability[] = ["stt", "llm", "embeddings"];
  return capabilities.reduce<ProviderSettings>((settings, capability) => {
    const resolved = resolveCapability(capability, config);
    settings[capability] = providerModelSettingFromResolved(resolved, now);
    return settings;
  }, {} as ProviderSettings);
}

export function providerModelSettingFromResolved(resolved: ResolvedCapability, updatedAt = Date.now()): ProviderModelSetting {
  const external = resolved.endpointId !== "local" && resolved.enabled;
  return {
    capability: resolved.capability,
    provider: resolved.endpointId,
    model: resolved.model,
    adapter: external ? "external" : "local-fallback",
    enabled: resolved.endpointId === "local" || external,
    adapterType: resolved.adapterType || undefined,
    baseUrl: resolved.baseUrl || undefined,
    updatedAt,
  };
}

export function buildProviderAdapters(config: AppConfig = getAppConfig()): Record<ProviderCapability, ProviderAdapterSummary[]> {
  const capabilities: ProviderCapability[] = ["stt", "llm", "embeddings"];
  return capabilities.reduce<Record<ProviderCapability, ProviderAdapterSummary[]>>((adapters, capability) => {
    const localModel = config.routing[capability]?.model || defaultLocalModel(capability);
    const entries: ProviderAdapterSummary[] = [
      {
        capability,
        provider: "local",
        label: "Local fallback",
        model: localModel,
        adapterType: null,
        available: true,
        baseUrl: "",
      },
    ];

    for (const endpoint of config.endpoints) {
      const adapterType = endpoint.adapters[capability];
      if (!adapterType) continue;
      entries.push({
        capability,
        provider: endpoint.id,
        label: endpoint.label,
        model: config.routing[capability]?.endpointId === endpoint.id
          ? config.routing[capability].model
          : "",
        adapterType,
        available: Boolean(endpoint.apiKey.trim()),
        baseUrl: endpoint.baseUrl,
      });
    }

    adapters[capability] = entries;
    return adapters;
  }, { stt: [], llm: [], embeddings: [] });
}

export function patchRoutingFromProviderSettings(
  config: AppConfig,
  settings: Partial<ProviderSettings>,
  now = Date.now(),
): AppConfig {
  const routing = { ...config.routing };
  for (const capability of ["stt", "llm", "embeddings"] as ProviderCapability[]) {
    const input = settings[capability];
    if (!input || !isRecord(input)) continue;
    const previous = routing[capability];
    routing[capability] = {
      endpointId: typeof input.provider === "string" ? input.provider : previous.endpointId,
      model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : previous.model,
      liveModel: previous.liveModel,
      baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : previous.baseUrl,
    };
  }

  return { ...config, routing, updatedAt: now };
}

export function defaultLocalModel(capability: ProviderCapability): string {
  if (capability === "stt") return "browser-speech-recognition";
  if (capability === "llm") return "local-answer-generator";
  return "keyword-retrieval";
}

export function normalizeEndpoint(value: unknown, fallback?: ProviderEndpoint): ProviderEndpoint | null {
  if (!isRecord(value)) return fallback || null;
  const id = typeof value.id === "string" ? value.id.trim() : fallback?.id || "";
  const label = typeof value.label === "string" ? value.label.trim() : fallback?.label || id;
  if (!id) return null;

  const adaptersInput = isRecord(value.adapters) ? value.adapters : {};
  const adapters: Partial<Record<ProviderCapability, ProviderAdapterType>> = { ...(fallback?.adapters || {}) };
  for (const capability of ["stt", "llm", "embeddings"] as ProviderCapability[]) {
    const adapter = adaptersInput[capability];
    if (typeof adapter === "string") adapters[capability] = adapter as ProviderAdapterType;
  }

  const optionsInput = isRecord(value.options) ? value.options : {};
  const options: Record<string, string | number | boolean> = { ...(fallback?.options || {}) };
  for (const [key, optionValue] of Object.entries(optionsInput)) {
    if (typeof optionValue === "string" || typeof optionValue === "number" || typeof optionValue === "boolean") {
      options[key] = optionValue;
    }
  }

  return {
    id,
    label: label || id,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : (fallback?.apiKey || ""),
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : (fallback?.baseUrl || ""),
    adapters,
    options,
  };
}

export function normalizeRoute(value: unknown, fallback: CapabilityRoute): CapabilityRoute {
  if (!isRecord(value)) return fallback;
  return {
    endpointId: typeof value.endpointId === "string" ? value.endpointId : fallback.endpointId,
    model: typeof value.model === "string" ? value.model : fallback.model,
    liveModel: typeof value.liveModel === "string" ? value.liveModel : fallback.liveModel,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : fallback.baseUrl,
  };
}

export function isOpenAiRealtimeModel(model: string): boolean {
  return model.includes("realtime") && model.includes("whisper");
}

export function openAiBatchTranscriptionModel(model: string): string {
  return isOpenAiRealtimeModel(model) ? "gpt-4o-mini-transcribe" : model;
}

export function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5|^o\d/i.test(model);
}
