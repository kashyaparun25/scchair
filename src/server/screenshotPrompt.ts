import type { AnswerFormat, ProviderSettings, SessionSetup } from "../shared/domain";
import { resolveCapability } from "./providerRegistry";

export interface ScreenshotPromptInput {
  imageData: string;
  imageMimeType?: string;
  prompt?: string;
  domain?: string;
  format?: AnswerFormat;
  language?: string;
  session?: SessionSetup | null;
}

export interface ScreenshotPromptResult {
  id: string;
  createdAt: number;
  answer: string;
  provider: string;
  model: string;
  usedFallback: boolean;
  fallbackReason?: string;
  metadata: {
    domain: string;
    format: AnswerFormat;
    language: string;
    imageMimeType: string;
  };
}

export async function generateScreenshotPromptAnswer(
  input: ScreenshotPromptInput,
  providerSettings: ProviderSettings,
  idFactory: (prefix: string) => string,
): Promise<ScreenshotPromptResult> {
  const metadata = normalizeMetadata(input);
  const createdAt = Date.now();
  const resolved = resolveCapability("llm");
  const provider = providerSettings.llm.provider;
  const model = providerSettings.llm.model || resolved.model;

  if (!shouldUseOpenAiVision()) {
    return fallbackScreenshotPrompt(input, metadata, idFactory, createdAt, provider, model, "Image LLM is not configured.");
  }

  try {
    const answer = await completeOpenAiVision(input, metadata, model, resolved.apiKey, resolved.baseUrl);
    if (!answer.trim()) {
      return fallbackScreenshotPrompt(input, metadata, idFactory, createdAt, provider, model, "Image LLM returned an empty response.");
    }
    return {
      id: idFactory("screenshot-prompt"),
      createdAt,
      answer,
      provider,
      model,
      usedFallback: false,
      metadata,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image LLM request failed.";
    return fallbackScreenshotPrompt(input, metadata, idFactory, createdAt, provider, model, message);
  }
}

function normalizeMetadata(input: ScreenshotPromptInput): ScreenshotPromptResult["metadata"] {
  return {
    domain: String(input.domain || "interview").trim() || "interview",
    format: input.format || "quick-bullets",
    language: String(input.language || input.session?.language || "English").trim() || "English",
    imageMimeType: normalizeImageMimeType(input.imageMimeType, input.imageData),
  };
}

function normalizeImageMimeType(imageMimeType: string | undefined, imageData: string): string {
  if (imageMimeType?.startsWith("image/")) return imageMimeType;
  const match = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  return match?.[1] || "image/png";
}

function shouldUseOpenAiVision(): boolean {
  const resolved = resolveCapability("llm");
  return resolved.adapterType === "openai-compatible-chat" && resolved.enabled;
}

async function completeOpenAiVision(
  input: ScreenshotPromptInput,
  metadata: ScreenshotPromptResult["metadata"],
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  if (!apiKey) throw new Error("API key is not configured.");

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are Second Chair, a private interview and meeting assistant.",
            "Read screenshots carefully and answer only from visible content and supplied context.",
            "If the screenshot is unclear, say what is visible and give a safe next step.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                prompt: input.prompt || "Analyze the screenshot and prepare an answer the user can say out loud.",
                domain: metadata.domain,
                format: metadata.format,
                language: metadata.language,
                session: input.session
                  ? {
                      mode: input.session.mode,
                      role: input.session.role,
                      company: input.session.company,
                      round: input.session.round,
                      responseStyle: input.session.responseStyle,
                    }
                  : null,
              }),
            },
            {
              type: "image_url",
              image_url: {
                url: toDataUrl(input.imageData, metadata.imageMimeType),
              },
            },
          ],
        },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(errorMessageFromBody(body, response.statusText));
  const parsed = body ? JSON.parse(body) as unknown : {};
  return textFromOpenAiChatCompletion(parsed);
}

function fallbackScreenshotPrompt(
  input: ScreenshotPromptInput,
  metadata: ScreenshotPromptResult["metadata"],
  idFactory: (prefix: string) => string,
  createdAt: number,
  provider: string,
  model: string,
  fallbackReason: string,
): ScreenshotPromptResult {
  const role = input.session?.role || "the current role";
  const company = input.session?.company || "the company";
  const prompt = input.prompt?.trim() || "Analyze the screenshot and prepare an answer.";
  return {
    id: idFactory("screenshot-prompt"),
    createdAt,
    answer: [
      `Image analysis is unavailable, so I cannot inspect the screenshot directly. Use this as a safe ${metadata.format} response in ${metadata.language}:`,
      `- State what is visible or being asked before answering.`,
      `- For ${metadata.domain}, anchor the response in ${role} at ${company} and avoid inventing details from the image.`,
      `- If the prompt is "${prompt}", answer with the clearest assumption first, then ask for or verify the missing visual detail.`,
    ].join("\n"),
    provider,
    model,
    usedFallback: true,
    fallbackReason,
    metadata,
  };
}

function toDataUrl(imageData: string, imageMimeType: string): string {
  if (imageData.startsWith("data:image/")) return imageData;
  return `data:${imageMimeType};base64,${imageData}`;
}

function textFromOpenAiChatCompletion(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.choices)) return "";
  const first = response.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return "";
  return typeof first.message.content === "string" ? first.message.content.trim() : "";
}

function errorMessageFromBody(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Use the HTTP fallback below.
  }
  return fallback || "Image LLM request failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
