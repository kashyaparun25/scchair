import type { ProviderCapability } from "./domain";
import type { ProviderPresetId } from "./providerPresets";

export type ProviderAdapterType =
  | "openai-compatible-chat"
  | "openai-compatible-embeddings"
  | "openai-transcriptions"
  | "openai-realtime-transcription"
  | "anthropic-messages"
  | "gemini-generate"
  | "gemini-embeddings"
  | "deepgram-streaming"
  | "nvidia-riva-stt";

export interface ProviderEndpoint {
  id: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  adapters: Partial<Record<ProviderCapability, ProviderAdapterType>>;
  options: Record<string, string | number | boolean>;
}

export interface CapabilityRoute {
  endpointId: string;
  model: string;
  liveModel?: string;
  baseUrl?: string;
}

export interface LlmRuntimeConfig {
  maxTokens: number;
  answerMaxTokens: number;
  temperature: number;
  answerTemperature: number;
  topP: number;
  answerTopP: number;
  enableThinking: boolean;
  answerEnableThinking: boolean;
  thinkingBudget: number;
  answerThinkingBudget: number;
}

export interface AppConfigPreferences {
  primaryStack: ProviderPresetId;
  customModels?: {
    llm?: string;
    llmLive?: string;
    stt?: string;
    embeddings?: string;
  };
}

export interface AppConfig {
  version: 2;
  endpoints: ProviderEndpoint[];
  routing: Record<ProviderCapability, CapabilityRoute>;
  llm: LlmRuntimeConfig;
  preferences?: AppConfigPreferences;
  updatedAt: number;
}

export interface ProviderEndpointPublic {
  id: string;
  label: string;
  baseUrl: string;
  adapters: Partial<Record<ProviderCapability, ProviderAdapterType>>;
  options: Record<string, string | number | boolean>;
  apiKey: { configured: boolean; preview: string };
}

export interface AppConfigPublic {
  endpoints: ProviderEndpointPublic[];
  routing: Record<ProviderCapability, CapabilityRoute>;
  llm: LlmRuntimeConfig;
  preferences: AppConfigPreferences;
  updatedAt: number;
}

export const adapterTypeLabels: Record<ProviderAdapterType, string> = {
  "openai-compatible-chat": "OpenAI-compatible chat",
  "openai-compatible-embeddings": "OpenAI-compatible embeddings",
  "openai-transcriptions": "OpenAI batch transcriptions",
  "openai-realtime-transcription": "OpenAI Realtime transcription",
  "anthropic-messages": "Anthropic Messages API",
  "gemini-generate": "Google Gemini generateContent",
  "gemini-embeddings": "Google Gemini embeddings",
  "deepgram-streaming": "Deepgram streaming STT",
  "nvidia-riva-stt": "NVIDIA Riva STT",
};

export const maxTokenOptions = [256, 512, 700, 1024, 2048, 4096, 8192, 16384] as const;

export const thinkingBudgetOptions = [
  { label: "Off", value: 0 },
  { label: "Low (1k)", value: 1024 },
  { label: "Medium (4k)", value: 4096 },
  { label: "High (8k)", value: 8192 },
  { label: "Max (16k)", value: 16384 },
] as const;

export function defaultAppConfig(now = Date.now()): AppConfig {
  return {
    version: 2,
    endpoints: [],
    routing: {
      stt: { endpointId: "local", model: "browser-speech-recognition" },
      llm: { endpointId: "local", model: "local-answer-generator" },
      embeddings: { endpointId: "local", model: "keyword-retrieval" },
    },
    llm: {
      maxTokens: 16384,
      answerMaxTokens: 700,
      temperature: 1,
      answerTemperature: 0.35,
      topP: 1,
      answerTopP: 0.9,
      enableThinking: false,
      answerEnableThinking: false,
      thinkingBudget: 0,
      answerThinkingBudget: 0,
    },
    preferences: { primaryStack: "nvidia" },
    updatedAt: now,
  };
}

export function maskSecret(value: string): string {
  if (!value.trim()) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

export function slugifyEndpointId(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "provider";
}
