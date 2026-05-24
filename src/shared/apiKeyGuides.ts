export interface ApiKeyGuide {
  endpointId: string;
  label: string;
  url: string;
  urlLabel: string;
  steps: string[];
}

export const API_KEY_GUIDES: Record<string, ApiKeyGuide> = {
  "nvidia-nim": {
    endpointId: "nvidia-nim",
    label: "NVIDIA",
    url: "https://build.nvidia.com/",
    urlLabel: "build.nvidia.com",
    steps: [
      "Sign in at build.nvidia.com (free NVIDIA account).",
      "Open your profile menu → API Keys, or click Get API Key on any model page.",
      "Create a key, copy it, and paste it in Settings below.",
    ],
  },
  openai: {
    endpointId: "openai",
    label: "OpenAI",
    url: "https://platform.openai.com/api-keys",
    urlLabel: "platform.openai.com/api-keys",
    steps: [
      "Sign in at platform.openai.com.",
      "Go to API keys in the dashboard.",
      "Create a new secret key and paste it here.",
    ],
  },
  gemini: {
    endpointId: "gemini",
    label: "Google Gemini",
    url: "https://aistudio.google.com/apikey",
    urlLabel: "aistudio.google.com/apikey",
    steps: [
      "Sign in with your Google account at Google AI Studio.",
      "Click Create API key.",
      "Copy the key and paste it here.",
    ],
  },
  anthropic: {
    endpointId: "anthropic",
    label: "Anthropic",
    url: "https://console.anthropic.com/settings/keys",
    urlLabel: "console.anthropic.com/settings/keys",
    steps: [
      "Sign in at console.anthropic.com.",
      "Open Settings → API keys.",
      "Create a key and paste it here.",
    ],
  },
};

export function apiKeyGuideForEndpoint(endpointId: string): ApiKeyGuide | undefined {
  return API_KEY_GUIDES[endpointId];
}

export const DEFAULT_API_KEY_GUIDE = API_KEY_GUIDES["nvidia-nim"]!;
