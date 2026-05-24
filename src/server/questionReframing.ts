import OpenAI from "openai";
import type {
  ProviderSettings,
  QuestionCard,
  QuestionType,
  TranscriptEvent,
} from "../shared/domain";
import { resolveCapability } from "./providerRegistry";
import { detectQuestions, frameQuestion } from "./questionDetection";

export interface QuestionReframingOptions {
  idPrefix?: string;
  minimumConfidence?: number;
  now?: number;
  prompt?: string;
  providerSettings: ProviderSettings;
}

interface TranscriptCandidate {
  index: number;
  text: string;
}

interface ModelQuestionCandidate {
  eventIndex?: unknown;
  rawText?: unknown;
  framedQuestion?: unknown;
  type?: unknown;
  confidence?: unknown;
  evaluationIntent?: unknown;
}

const questionTypes: QuestionType[] = [
  "behavioral",
  "technical",
  "coding",
  "system-design",
  "situational",
  "culture",
  "resume",
  "follow-up",
  "logistics",
  "meeting",
];

const defaultQuestionFramerPrompt =
  "Rewrite transcript fragments into one precise interviewer question. Preserve the original intent, infer missing context carefully, and classify the question type.";

export async function detectQuestionsWithReframing(
  events: TranscriptEvent[],
  options: QuestionReframingOptions,
): Promise<QuestionCard[]> {
  if (!shouldUseOpenAI(options.providerSettings)) {
    return detectQuestions(events, options);
  }

  try {
    return await detectQuestionsWithOpenAI(events, options);
  } catch (error) {
    console.warn("Question reframing provider failed; using heuristic fallback.", error);
    return detectQuestions(events, options);
  }
}

async function detectQuestionsWithOpenAI(
  events: TranscriptEvent[],
  options: QuestionReframingOptions,
): Promise<QuestionCard[]> {
  const candidates = transcriptCandidates(events);
  if (!candidates.length) {
    return [];
  }

  const resolved = resolveCapability("llm");
  if (resolved.adapterType !== "openai-compatible-chat" || !resolved.enabled) {
    return detectQuestions(events, options);
  }

  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl.replace(/\/+$/, ""),
  });
  const model = options.providerSettings.llm.model || resolved.model;
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          options.prompt || defaultQuestionFramerPrompt,
          "Return only JSON with a top-level questions array.",
          `Allowed types: ${questionTypes.join(", ")}.`,
          "Only include interviewer questions or imperative interview prompts.",
          "Do not include candidate answers, filler, status chatter, or uncertain fragments.",
          "Each item must include eventIndex, rawText, framedQuestion, type, confidence, and evaluationIntent.",
          "confidence must be a number from 0 to 1.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          transcript: candidates,
        }),
      },
    ],
  });

  const content = completion.choices[0]?.message.content;
  const parsed = parseQuestionsResponse(content);
  const minimumConfidence = options.minimumConfidence ?? 0.48;
  const createdAt = options.now ?? Date.now();
  const idPrefix = options.idPrefix ?? "detected-question";

  return parsed
    .map((candidate, index) => normalizeModelCandidate(candidate, candidates, index, createdAt, idPrefix))
    .filter((question): question is QuestionCard => Boolean(question))
    .filter((question) => question.confidence >= minimumConfidence);
}

function shouldUseOpenAI(settings: ProviderSettings): boolean {
  void settings;
  const resolved = resolveCapability("llm");
  return resolved.adapterType === "openai-compatible-chat" && resolved.enabled;
}

function transcriptCandidates(events: TranscriptEvent[]): TranscriptCandidate[] {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.isFinal && event.source !== "mic" && event.text.trim())
    .map(({ event, index }) => ({
      index,
      text: normalizeWhitespace(event.text),
    }));
}

function parseQuestionsResponse(content: string | null | undefined): ModelQuestionCandidate[] {
  if (!content) {
    return [];
  }

  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) {
    return [];
  }
  return parsed.questions.filter(isRecord);
}

function normalizeModelCandidate(
  candidate: ModelQuestionCandidate,
  transcript: TranscriptCandidate[],
  index: number,
  createdAt: number,
  idPrefix: string,
): QuestionCard | undefined {
  const transcriptEvent = transcript.find((event) => event.index === candidate.eventIndex);
  const rawText = normalizeWhitespace(stringValue(candidate.rawText) || transcriptEvent?.text || "");
  if (!rawText) {
    return undefined;
  }

  const confidence = clamp(numberValue(candidate.confidence, 0), 0, 0.99);
  if (confidence < 0.35) {
    return undefined;
  }

  return {
    id: `${idPrefix}-${createdAt}-${index + 1}`,
    rawText,
    framedQuestion: normalizeWhitespace(stringValue(candidate.framedQuestion)) || frameQuestion(rawText),
    type: questionTypeValue(candidate.type),
    confidence: Math.round(confidence * 100) / 100,
    evaluationIntent: normalizeWhitespace(stringValue(candidate.evaluationIntent))
      || "LLM-classified interviewer question from transcript context.",
    createdAt,
    status: "new",
  };
}

function questionTypeValue(value: unknown): QuestionType {
  return questionTypes.includes(value as QuestionType) ? value as QuestionType : "technical";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
