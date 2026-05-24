import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AppConfigPreferences,
  AppConfigPublic,
  CapabilityRoute,
  LlmRuntimeConfig,
  ProviderEndpoint,
} from "../shared/appConfig";
import {
  defaultAppConfig,
  maskSecret,
} from "../shared/appConfig";
import type { ProviderCapability, ProviderSettings } from "../shared/domain";
import {
  applyProviderStack,
  DEFAULT_PROVIDER_STACK,
  type ProviderPresetId,
  PROVIDER_PRESETS,
} from "../shared/providerPresets";
import {
  normalizeEndpoint,
  normalizeRoute,
  patchRoutingFromProviderSettings,
  providerSettingsFromConfig,
} from "./providerRegistry";

let configPath = "";
let cached: AppConfig = defaultAppConfig();

function readEnvString(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function seedEndpointsFromEnv(now = Date.now()): ProviderEndpoint[] {
  const endpoints: ProviderEndpoint[] = [];
  const openaiKey = readEnvString("OPENAI_API_KEY");
  if (openaiKey) {
    endpoints.push({
      id: "openai",
      label: "OpenAI",
      apiKey: openaiKey,
      baseUrl: "https://api.openai.com/v1",
      adapters: {
        llm: "openai-compatible-chat",
        stt: "openai-realtime-transcription",
        embeddings: "openai-compatible-embeddings",
      },
      options: {},
    });
  }

  const anthropicKey = readEnvString("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    endpoints.push({
      id: "anthropic",
      label: "Anthropic",
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com",
      adapters: { llm: "anthropic-messages" },
      options: {},
    });
  }

  const geminiKey = readEnvString("GEMINI_API_KEY") || readEnvString("GOOGLE_API_KEY");
  if (geminiKey) {
    endpoints.push({
      id: "gemini",
      label: "Google Gemini",
      apiKey: geminiKey,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      adapters: { llm: "gemini-generate", embeddings: "gemini-embeddings" },
      options: {},
    });
  }

  const nvidiaKey = readEnvString("NVIDIA_API_KEY") || readEnvString("NVIDIA_NIM_API_KEY");
  if (nvidiaKey) {
    endpoints.push({
      id: "nvidia-nim",
      label: "NVIDIA NIM",
      apiKey: nvidiaKey,
      baseUrl: readEnvString("NVIDIA_NIM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
      adapters: {
        llm: "openai-compatible-chat",
        stt: "nvidia-riva-stt",
        embeddings: "openai-compatible-embeddings",
      },
      options: {
        rivaServer: readEnvString("NVIDIA_RIVA_ASR_SERVER", "grpc.nvcf.nvidia.com:443"),
        rivaFunctionId: readEnvString("NVIDIA_RIVA_ASR_FUNCTION_ID", "1598d209-5e27-4d3c-8079-4751568b1081"),
        rivaLanguageCode: readEnvString("NVIDIA_RIVA_ASR_LANGUAGE_CODE", "en-US"),
        rivaTimeoutMs: Number(process.env.NVIDIA_RIVA_ASR_TIMEOUT_MS || 30000),
      },
    });
  }

  const deepgramKey = readEnvString("DEEPGRAM_API_KEY");
  if (deepgramKey) {
    endpoints.push({
      id: "deepgram",
      label: "Deepgram",
      apiKey: deepgramKey,
      baseUrl: "https://api.deepgram.com",
      adapters: { stt: "deepgram-streaming" },
      options: {
        deepgramModel: readEnvString("DEEPGRAM_MODEL", "nova-3"),
        deepgramEndpointingMs: Number(process.env.DEEPGRAM_ENDPOINTING_MS || 500),
        deepgramUtteranceEndMs: Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 800),
      },
    });
  }

  void now;
  return endpoints;
}

function inferStackFromRouting(routing: AppConfig["routing"]): ProviderPresetId {
  switch (routing.llm.endpointId) {
    case "openai": return "openai";
    case "gemini": return "gemini";
    case "anthropic": return "anthropic";
    case "nvidia-nim": return "nvidia";
    default: return DEFAULT_PROVIDER_STACK;
  }
}

function buildConfigFromEnv(now = Date.now()): AppConfig {
  const endpoints = seedEndpointsFromEnv(now);
  const keyUpdates = Object.fromEntries(
    endpoints.filter((endpoint) => endpoint.apiKey.trim()).map((endpoint) => [endpoint.id, endpoint.apiKey]),
  );
  return applyProviderStack({ ...defaultAppConfig(now), endpoints: [] }, DEFAULT_PROVIDER_STACK, keyUpdates);
}

function migrateV1Config(raw: Record<string, unknown>, now = Date.now()): AppConfig {
  const defaults = defaultAppConfig(now);
  const endpoints = seedEndpointsFromEnv(now);

  for (const endpoint of endpoints) {
    const keys = raw.apiKeys && typeof raw.apiKeys === "object" ? raw.apiKeys as Record<string, string> : {};
    if (endpoint.id === "openai" && keys.openai) endpoint.apiKey = keys.openai;
    if (endpoint.id === "anthropic" && keys.anthropic) endpoint.apiKey = keys.anthropic;
    if (endpoint.id === "gemini" && keys.gemini) endpoint.apiKey = keys.gemini;
    if (endpoint.id === "nvidia-nim" && keys.nvidia) endpoint.apiKey = keys.nvidia;
    if (endpoint.id === "deepgram" && keys.deepgram) endpoint.apiKey = keys.deepgram;
  }

  const llm = raw.llm && typeof raw.llm === "object" ? raw.llm as Record<string, unknown> : {};
  const stt = raw.stt && typeof raw.stt === "object" ? raw.stt as Record<string, unknown> : {};
  const embeddings = raw.embeddings && typeof raw.embeddings === "object" ? raw.embeddings as Record<string, unknown> : {};

  const nvidia = endpoints.find((endpoint) => endpoint.id === "nvidia-nim");
  if (nvidia && typeof llm.nvidiaBaseUrl === "string") nvidia.baseUrl = llm.nvidiaBaseUrl;
  if (nvidia) {
    nvidia.options = {
      ...nvidia.options,
      rivaServer: typeof stt.nvidiaRivaServer === "string" ? stt.nvidiaRivaServer : nvidia.options.rivaServer,
      rivaFunctionId: typeof stt.nvidiaRivaFunctionId === "string" ? stt.nvidiaRivaFunctionId : nvidia.options.rivaFunctionId,
      rivaLanguageCode: typeof stt.nvidiaRivaLanguageCode === "string" ? stt.nvidiaRivaLanguageCode : nvidia.options.rivaLanguageCode,
      rivaTimeoutMs: typeof stt.nvidiaRivaTimeoutMs === "number" ? stt.nvidiaRivaTimeoutMs : nvidia.options.rivaTimeoutMs,
    };
  }

  const deepgram = endpoints.find((endpoint) => endpoint.id === "deepgram");
  if (deepgram) {
    deepgram.options = {
      ...deepgram.options,
      deepgramModel: typeof stt.deepgramModel === "string" ? stt.deepgramModel : deepgram.options.deepgramModel,
      deepgramEndpointingMs: typeof stt.deepgramEndpointingMs === "number" ? stt.deepgramEndpointingMs : deepgram.options.deepgramEndpointingMs,
      deepgramUtteranceEndMs: typeof stt.deepgramUtteranceEndMs === "number" ? stt.deepgramUtteranceEndMs : deepgram.options.deepgramUtteranceEndMs,
    };
  }

  const stack = DEFAULT_PROVIDER_STACK;
  const keyUpdates = Object.fromEntries(
    endpoints.filter((endpoint) => endpoint.apiKey.trim()).map((endpoint) => [endpoint.id, endpoint.apiKey]),
  );

  const openai = endpoints.find((endpoint) => endpoint.id === "openai");

  const migrated = applyProviderStack(
    {
      version: 2,
      endpoints,
      routing: defaultAppConfig(now).routing,
      llm: {
        maxTokens: typeof llm.maxTokens === "number" ? llm.maxTokens : defaults.llm.maxTokens,
        answerMaxTokens: typeof llm.answerMaxTokens === "number" ? llm.answerMaxTokens : defaults.llm.answerMaxTokens,
        temperature: typeof llm.temperature === "number" ? llm.temperature : defaults.llm.temperature,
        answerTemperature: typeof llm.answerTemperature === "number" ? llm.answerTemperature : defaults.llm.answerTemperature,
        topP: typeof llm.topP === "number" ? llm.topP : defaults.llm.topP,
        answerTopP: typeof llm.answerTopP === "number" ? llm.answerTopP : defaults.llm.answerTopP,
        enableThinking: typeof llm.enableThinking === "boolean" ? llm.enableThinking : defaults.llm.enableThinking,
        answerEnableThinking: typeof llm.answerEnableThinking === "boolean" ? llm.answerEnableThinking : defaults.llm.answerEnableThinking,
        thinkingBudget: typeof llm.thinkingBudget === "number" ? llm.thinkingBudget : defaults.llm.thinkingBudget,
        answerThinkingBudget: typeof llm.answerThinkingBudget === "number" ? llm.answerThinkingBudget : defaults.llm.answerThinkingBudget,
      },
      updatedAt: now,
    },
    stack,
    keyUpdates,
  );

  if (openai && typeof llm.answerModel === "string") {
    migrated.routing.llm.liveModel = llm.answerModel;
  }
  if (openai && typeof embeddings.openaiModel === "string") {
    migrated.routing.embeddings.model = embeddings.openaiModel;
  }
  if (nvidia && typeof embeddings.nvidiaModel === "string") {
    migrated.routing.embeddings.model = embeddings.nvidiaModel;
  }
  if (nvidia && typeof stt.nvidiaSttModel === "string") {
    migrated.routing.stt.model = stt.nvidiaSttModel;
  }

  return migrated;
}

function normalizeConfig(value: unknown, now = Date.now()): AppConfig {
  const defaults = defaultAppConfig(now);
  const input = value && typeof value === "object" ? value as Partial<AppConfig> & Record<string, unknown> : {};

  if (input.version !== 2) {
    return migrateV1Config(input, now);
  }

  const endpointsInput = Array.isArray(input.endpoints) ? input.endpoints : [];
  const endpoints = endpointsInput
    .map((entry) => normalizeEndpoint(entry))
    .filter((entry): entry is ProviderEndpoint => Boolean(entry));

  const routingInput = input.routing && typeof input.routing === "object" ? input.routing : {};
  const routing = {
    stt: normalizeRoute((routingInput as Record<string, unknown>).stt, defaults.routing.stt),
    llm: normalizeRoute((routingInput as Record<string, unknown>).llm, defaults.routing.llm),
    embeddings: normalizeRoute((routingInput as Record<string, unknown>).embeddings, defaults.routing.embeddings),
  };

  const llm = input.llm && typeof input.llm === "object" ? input.llm as Partial<LlmRuntimeConfig> : {};
  const preferencesInput = input.preferences && typeof input.preferences === "object"
    ? input.preferences as Partial<AppConfigPreferences>
    : {};
  const primaryStack = preferencesInput.primaryStack && preferencesInput.primaryStack in PROVIDER_PRESETS
    ? preferencesInput.primaryStack
    : inferStackFromRouting(routing);

  return {
    version: 2,
    endpoints,
    routing,
    llm: {
      maxTokens: typeof llm.maxTokens === "number" ? llm.maxTokens : defaults.llm.maxTokens,
      answerMaxTokens: typeof llm.answerMaxTokens === "number" ? llm.answerMaxTokens : defaults.llm.answerMaxTokens,
      temperature: typeof llm.temperature === "number" ? llm.temperature : defaults.llm.temperature,
      answerTemperature: typeof llm.answerTemperature === "number" ? llm.answerTemperature : defaults.llm.answerTemperature,
      topP: typeof llm.topP === "number" ? llm.topP : defaults.llm.topP,
      answerTopP: typeof llm.answerTopP === "number" ? llm.answerTopP : defaults.llm.answerTopP,
      enableThinking: typeof llm.enableThinking === "boolean" ? llm.enableThinking : defaults.llm.enableThinking,
      answerEnableThinking: typeof llm.answerEnableThinking === "boolean" ? llm.answerEnableThinking : defaults.llm.answerEnableThinking,
      thinkingBudget: typeof llm.thinkingBudget === "number" ? llm.thinkingBudget : defaults.llm.thinkingBudget,
      answerThinkingBudget: typeof llm.answerThinkingBudget === "number" ? llm.answerThinkingBudget : defaults.llm.answerThinkingBudget,
    },
    preferences: {
      primaryStack,
      customModels: preferencesInput.customModels,
    },
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
  };
}

export function initAppConfigStore(dataDir: string): AppConfig {
  fs.mkdirSync(dataDir, { recursive: true });
  configPath = path.join(dataDir, "app-config.json");

  if (fs.existsSync(configPath)) {
    try {
      cached = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
      saveAppConfig(cached);
      return cached;
    } catch {
      cached = normalizeConfig(migrateV1Config({}, Date.now()));
      saveAppConfig(cached);
      return cached;
    }
  }

  cached = normalizeConfig(migrateV1Config({}, Date.now()));
  saveAppConfig(cached);
  return cached;
}

export function getAppConfig(): AppConfig {
  return cached;
}

export function saveAppConfig(next: AppConfig): AppConfig {
  cached = normalizeConfig({ ...next, updatedAt: Date.now() });
  if (configPath) {
    fs.writeFileSync(configPath, JSON.stringify(cached, null, 2));
  }
  return cached;
}

export function patchSimpleSettings(patch: {
  primaryStack?: ProviderPresetId;
  keys?: Record<string, string>;
  customModels?: AppConfigPreferences["customModels"];
  llm?: Partial<LlmRuntimeConfig>;
}): AppConfig {
  const current = getAppConfig();
  const stack = patch.primaryStack || current.preferences?.primaryStack || DEFAULT_PROVIDER_STACK;
  const keyUpdates: Record<string, string> = {};

  if (patch.keys) {
    for (const [endpointId, value] of Object.entries(patch.keys)) {
      if (value.trim()) keyUpdates[endpointId] = value.trim();
    }
  }

  const next = applyProviderStack(current, stack, keyUpdates, patch.customModels);
  return saveAppConfig({
    ...next,
    llm: { ...next.llm, ...(patch.llm || {}) },
  });
}

export function patchAppConfig(patch: Partial<AppConfig> & {
  endpoints?: ProviderEndpoint[];
  routing?: Partial<Record<ProviderCapability, CapabilityRoute>>;
  llm?: Partial<LlmRuntimeConfig>;
  primaryStack?: ProviderPresetId;
  keys?: Record<string, string>;
  customModels?: AppConfigPreferences["customModels"];
}): AppConfig {
  if (patch.primaryStack || patch.keys || patch.customModels) {
    return patchSimpleSettings({
      primaryStack: patch.primaryStack,
      keys: patch.keys,
      customModels: patch.customModels,
      llm: patch.llm,
    });
  }

  const current = getAppConfig();
  const previousById = new Map(current.endpoints.map((endpoint) => [endpoint.id, endpoint]));

  let mergedEndpoints = current.endpoints;
  if (patch.endpoints) {
    mergedEndpoints = patch.endpoints
      .map((endpoint) => {
        const normalized = normalizeEndpoint(endpoint, previousById.get(endpoint.id));
        if (!normalized) return null;
        if (!normalized.apiKey.trim()) {
          const previousKey = previousById.get(normalized.id)?.apiKey || "";
          if (previousKey.trim()) normalized.apiKey = previousKey;
        }
        return normalized;
      })
      .filter((endpoint): endpoint is ProviderEndpoint => Boolean(endpoint));
  }

  const mergedRouting = {
    stt: patch.routing?.stt ? normalizeRoute(patch.routing.stt, current.routing.stt) : current.routing.stt,
    llm: patch.routing?.llm ? normalizeRoute(patch.routing.llm, current.routing.llm) : current.routing.llm,
    embeddings: patch.routing?.embeddings
      ? normalizeRoute(patch.routing.embeddings, current.routing.embeddings)
      : current.routing.embeddings,
  };

  for (const capability of ["stt", "llm", "embeddings"] as ProviderCapability[]) {
    const route = mergedRouting[capability];
    if (route.endpointId !== "local" && !mergedEndpoints.some((endpoint) => endpoint.id === route.endpointId)) {
      mergedRouting[capability] = {
        endpointId: "local",
        model: capability === "stt"
          ? "browser-speech-recognition"
          : capability === "llm"
            ? "local-answer-generator"
            : "keyword-retrieval",
      };
    }
  }

  return saveAppConfig({
    ...current,
    endpoints: mergedEndpoints,
    routing: mergedRouting,
    llm: { ...current.llm, ...(patch.llm || {}) },
  });
}

export function patchProviderSettings(settings: Partial<ProviderSettings>): AppConfig {
  return saveAppConfig(patchRoutingFromProviderSettings(getAppConfig(), settings));
}

export function toPublicAppConfig(config: AppConfig = getAppConfig()): AppConfigPublic {
  return {
    endpoints: config.endpoints.map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      baseUrl: endpoint.baseUrl,
      adapters: endpoint.adapters,
      options: endpoint.options,
      apiKey: { configured: Boolean(endpoint.apiKey), preview: maskSecret(endpoint.apiKey) },
    })),
    routing: config.routing,
    llm: config.llm,
    preferences: config.preferences || { primaryStack: inferStackFromRouting(config.routing) },
    updatedAt: config.updatedAt,
  };
}

export function getProviderSettings(): ProviderSettings {
  return providerSettingsFromConfig(getAppConfig());
}

/** @deprecated use resolveCapability() */
export function getApiKey(_id: string): string {
  return "";
}

/** @deprecated use resolveCapability() */
export function hasApiKey(_id: string): boolean {
  return false;
}
