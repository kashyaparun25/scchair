import OpenAI from "openai";
import type { AnswerDraft, ProviderSettings } from "../shared/domain";
import { getAppConfig } from "./appConfigStore";
import {
  resolveCapability,
  type ResolvedCapability,
  usesMaxCompletionTokens,
} from "./providerRegistry";
import {
  generateLocalAnswerDraft,
  streamLocalAnswer,
  type AnswerStreamEvent,
  type GenerateAnswerInput,
} from "./answerGeneration";

interface PromptPayload {
  system: string;
  user: string;
}

export class AnswerGenerationError extends Error {
  constructor(message = "AI answer generation failed.") {
    super(message);
    this.name = "AnswerGenerationError";
  }
}

export async function generateAnswerDraft(
  input: GenerateAnswerInput,
  providerSettings: ProviderSettings,
): Promise<AnswerDraft> {
  if (!shouldUseExternalLlm(providerSettings)) {
    return generateLocalAnswerDraft(input);
  }

  const answer = generateLocalAnswerDraft(input);
  const structured = await completeExternalAnswer(input, providerSettings);
  return {
    ...answer,
    stages: {
      bullets: extractTalkingPoints(structured),
      structured: stripTalkingPoints(structured).trim() || answer.stages.structured,
      sources: answer.stages.sources,
      risk: answer.stages.risk,
    },
  };
}

export async function* streamAnswerDraft(
  input: GenerateAnswerInput,
  providerSettings: ProviderSettings,
  chunkDelayMs = 0,
): AsyncGenerator<AnswerStreamEvent> {
  if (!shouldUseExternalLlm(providerSettings)) {
    yield* streamLocalAnswer(input, chunkDelayMs);
    return;
  }

  const answer = generateLocalAnswerDraft(input);
  yield {
    type: "start",
    questionId: answer.questionId,
    answerId: answer.id,
    format: answer.format,
  };

  let structured = "";
  for await (const delta of streamExternalAnswer(input, providerSettings)) {
    structured += delta;
    yield { type: "chunk", answerId: answer.id, stage: "structured", value: structured };
  }

  const completed: AnswerDraft = {
    ...answer,
    stages: {
      bullets: extractTalkingPoints(structured),
      structured: stripTalkingPoints(structured).trim() || answer.stages.structured,
      sources: answer.stages.sources,
      risk: answer.stages.risk,
    },
  };

  for (const bullet of completed.stages.bullets) {
    yield { type: "chunk", answerId: completed.id, stage: "bullets", value: bullet };
  }
  for (const source of completed.stages.sources) {
    yield { type: "chunk", answerId: completed.id, stage: "sources", value: source };
  }
  yield { type: "chunk", answerId: completed.id, stage: "risk", value: completed.stages.risk };
  yield { type: "complete", answer: completed };
}

function shouldUseExternalLlm(_settings: ProviderSettings): boolean {
  const resolved = resolveCapability("llm");
  return resolved.endpointId !== "local" && resolved.enabled;
}

async function completeExternalAnswer(
  input: GenerateAnswerInput,
  _providerSettings: ProviderSettings,
): Promise<string> {
  try {
    const prompt = buildPromptPayload(input);
    const resolved = resolveCapability("llm");
    return completeByAdapter(prompt, resolved, false);
  } catch (error) {
    throw new AnswerGenerationError(error instanceof Error ? error.message : undefined);
  }
}

async function* streamExternalAnswer(
  input: GenerateAnswerInput,
  _providerSettings: ProviderSettings,
): AsyncGenerator<string> {
  try {
    const prompt = buildPromptPayload(input);
    const resolved = resolveCapability("llm");
    yield* streamByAdapter(prompt, resolved, true);
  } catch (error) {
    throw new AnswerGenerationError(error instanceof Error ? error.message : undefined);
  }
}

async function completeByAdapter(prompt: PromptPayload, resolved: ResolvedCapability, liveAnswer: boolean): Promise<string> {
  if (resolved.adapterType === "openai-compatible-chat") {
    return completeOpenAiCompatible(prompt, resolved, liveAnswer);
  }
  if (resolved.adapterType === "anthropic-messages") {
    return completeClaude(prompt, resolved, liveAnswer);
  }
  if (resolved.adapterType === "gemini-generate") {
    return completeGemini(prompt, resolved, liveAnswer);
  }
  throw new AnswerGenerationError("LLM provider is not configured.");
}

async function* streamByAdapter(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): AsyncGenerator<string> {
  if (resolved.adapterType === "openai-compatible-chat") {
    yield* streamOpenAiCompatible(prompt, resolved, liveAnswer);
    return;
  }
  if (resolved.adapterType === "anthropic-messages") {
    yield* streamClaude(prompt, resolved, liveAnswer);
    return;
  }
  if (resolved.adapterType === "gemini-generate") {
    yield* streamGemini(prompt, resolved, liveAnswer);
    return;
  }
  throw new AnswerGenerationError("LLM provider is not configured.");
}

function openAiTokenLimit(maxTokens: number, model: string): { max_tokens?: number; max_completion_tokens?: number } {
  if (usesMaxCompletionTokens(model)) return { max_completion_tokens: maxTokens };
  return { max_tokens: maxTokens };
}

function llmRuntimeValues(liveAnswer: boolean) {
  const runtime = getAppConfig().llm;
  return liveAnswer
    ? {
        maxTokens: runtime.answerMaxTokens,
        temperature: runtime.answerTemperature,
        topP: runtime.answerTopP,
        enableThinking: runtime.answerEnableThinking,
        thinkingBudget: runtime.answerThinkingBudget,
      }
    : {
        maxTokens: runtime.maxTokens,
        temperature: runtime.temperature,
        topP: runtime.topP,
        enableThinking: runtime.enableThinking,
        thinkingBudget: runtime.thinkingBudget,
      };
}

function modelForResolved(resolved: ResolvedCapability, liveAnswer: boolean): string {
  if (liveAnswer && resolved.liveModel?.trim()) return resolved.liveModel.trim();
  return resolved.model;
}

async function completeOpenAiCompatible(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): Promise<string> {
  const runtime = llmRuntimeValues(liveAnswer);
  const model = modelForResolved(resolved, liveAnswer);
  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl.replace(/\/+$/, ""),
  });
  const completion = await client.chat.completions.create({
    model,
    ...openAiTokenLimit(runtime.maxTokens, model),
    temperature: runtime.temperature,
    top_p: runtime.topP,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  });
  return completion.choices[0]?.message.content?.trim() || "";
}

async function* streamOpenAiCompatible(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): AsyncGenerator<string> {
  const runtime = llmRuntimeValues(liveAnswer);
  const model = modelForResolved(resolved, liveAnswer);
  const request = openAiCompatibleRequest(prompt, model, true, runtime);
  const response = await fetch(`${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${resolved.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  yield* readSseResponse(response, textFromOpenAiChatResponse);
}

function openAiCompatibleRequest(
  prompt: PromptPayload,
  model: string,
  stream: boolean,
  runtime: ReturnType<typeof llmRuntimeValues>,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    ...openAiTokenLimit(runtime.maxTokens, model),
    temperature: runtime.temperature,
    top_p: runtime.topP,
    stream,
  };
  if (runtime.enableThinking || runtime.thinkingBudget > 0) {
    const kwargs: Record<string, unknown> = { thinking: runtime.enableThinking || runtime.thinkingBudget > 0 };
    if (runtime.thinkingBudget > 0) kwargs.thinking_budget = runtime.thinkingBudget;
    request.chat_template_kwargs = kwargs;
  }
  return request;
}

async function completeClaude(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): Promise<string> {
  const runtime = llmRuntimeValues(liveAnswer);
  const response = await fetch(`${resolved.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: claudeHeaders(resolved),
    body: JSON.stringify({
      model: modelForResolved(resolved, liveAnswer),
      max_tokens: runtime.maxTokens,
      temperature: runtime.temperature,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    }),
  });
  const json = await readJsonResponse(response);
  return textFromClaudeResponse(json);
}

async function* streamClaude(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): AsyncGenerator<string> {
  const runtime = llmRuntimeValues(liveAnswer);
  const response = await fetch(`${resolved.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: claudeHeaders(resolved),
    body: JSON.stringify({
      model: modelForResolved(resolved, liveAnswer),
      max_tokens: runtime.maxTokens,
      temperature: runtime.temperature,
      stream: true,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    }),
  });

  yield* readSseResponse(response, (event) => {
    if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) return "";
    return typeof event.delta.text === "string" ? event.delta.text : "";
  });
}

async function completeGemini(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): Promise<string> {
  const response = await fetch(geminiUrl(resolved, modelForResolved(resolved, liveAnswer), "generateContent"), {
    method: "POST",
    headers: geminiHeaders(resolved),
    body: JSON.stringify(geminiRequest(prompt, liveAnswer)),
  });
  const json = await readJsonResponse(response);
  return textFromGeminiResponse(json);
}

async function* streamGemini(
  prompt: PromptPayload,
  resolved: ResolvedCapability,
  liveAnswer: boolean,
): AsyncGenerator<string> {
  const model = modelForResolved(resolved, liveAnswer);
  const response = await fetch(`${geminiUrl(resolved, model, "streamGenerateContent")}?alt=sse`, {
    method: "POST",
    headers: geminiHeaders(resolved),
    body: JSON.stringify(geminiRequest(prompt, liveAnswer)),
  });

  yield* readSseResponse(response, textFromGeminiResponse);
}

function claudeHeaders(resolved: ResolvedCapability): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-api-key": resolved.apiKey,
  };
}

function geminiHeaders(resolved: ResolvedCapability): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-goog-api-key": resolved.apiKey,
  };
}

function geminiRequest(prompt: PromptPayload, liveAnswer: boolean): object {
  const runtime = llmRuntimeValues(liveAnswer);
  return {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: "user", parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: runtime.temperature,
      maxOutputTokens: runtime.maxTokens,
    },
  };
}

function geminiUrl(
  resolved: ResolvedCapability,
  model: string,
  method: "generateContent" | "streamGenerateContent",
): string {
  const normalized = model.startsWith("models/") ? model : `models/${model}`;
  return `${resolved.baseUrl.replace(/\/+$/, "")}/${normalized}:${method}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) throw new Error(errorMessageFromBody(body, response.statusText));
  return body ? JSON.parse(body) as unknown : {};
}

async function* readSseResponse(
  response: Response,
  extractText: (event: unknown) => string,
): AsyncGenerator<string> {
  if (!response.ok) {
    throw new Error(errorMessageFromBody(await response.text(), response.statusText));
  }
  if (!response.body) throw new Error("Provider did not return a readable stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      const data = event
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const text = extractText(JSON.parse(data) as unknown);
      if (text) yield text;
    }
  }
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
  return fallback || "Provider request failed.";
}

function textFromClaudeResponse(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.content)) return "";
  return response.content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function textFromGeminiResponse(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.candidates)) return "";
  const first = response.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return "";
  return first.content.parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function textFromOpenAiChatResponse(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.choices)) return "";
  const first = response.choices[0];
  if (!isRecord(first)) return "";
  if (isRecord(first.delta) && typeof first.delta.content === "string") return first.delta.content;
  if (isRecord(first.message) && typeof first.message.content === "string") return first.message.content.trim();
  return "";
}

function buildPromptPayload(input: GenerateAnswerInput): PromptPayload {
  const context = input.retrievedContext?.map((chunk, index) => ({
    source: chunk.documentName,
    excerpt: chunk.text,
    rank: index + 1,
  })) ?? [];

  const profileLine = profileInstruction(input.responseProfile);
  const roundLine = roundInstruction(input.session.round);
  const responseStyleLine = responseStyleInstruction(input.session.responseStyle);
  const formatLine = formatInstruction(input.format);
  const templateLine = input.answerPromptTemplate?.trim()
    ? `Product guidance:\n${input.answerPromptTemplate.trim()}`
    : "";

  return {
    system: [
      "You are Second Chair, a private real-time interview copilot.",
      "Write ONLY the exact words the candidate should say out loud in the interview.",
      profileLine,
      roundLine,
      responseStyleLine,
      formatLine,
      templateLine,
      input.groundingAnalysis?.instruction,
      input.continuity?.instruction,
      "Rules:",
      "- First person only (I, my, we). Sound natural and conversational.",
      "- 80-140 words. Be concise — this is live interview assistance.",
      "- Start answering immediately. No preamble like 'Great question' unless it fits naturally.",
      "- Never use placeholders, brackets, blanks, em dashes to fill in, or instructions like 'mention X here'.",
      "- Never explain how to answer. Never say 'I would frame this as' or 'fill in the blank'.",
      "- Use concrete details from retrievedContext when it is present. Prefer the project excerpt that directly mentions the asked skill.",
      "- Read recentConversation (interviewer/candidate transcript) AND priorAnswersInSession (answers already given this interview).",
      "- Stay consistent with priorAnswersInSession. Do not contradict or repeat the same examples verbatim.",
      "- For 'if so' follow-ups after a prior 'no' or gap: pivot to the closest documented example — do not answer as if you used the skill.",
      "- For 'other tools/frameworks' questions: add NEW examples not already listed in priorAnswersInSession.",
      "- If the current question is short or ambiguous, use recentConversation to infer the full question and scenario.",
      "- If evidenceStance is absent or partial for a focus term, be honest about gaps before describing adjacent documented experience.",
      "- End with one line starting exactly with 'MEMORY JOGGERS:' followed by three short comma-separated reminders.",
    ].filter(Boolean).join("\n"),
    user: JSON.stringify({
      session: {
        mode: input.session.mode,
        role: input.session.role,
        company: input.session.company,
        round: input.session.round,
        seniority: input.session.seniority,
        responseStyle: input.session.responseStyle,
        language: input.session.language,
        voiceProfile: input.session.voiceProfile,
        customVoice: input.session.customVoice,
        answerFormat: input.session.answerFormat,
      },
      question: {
        rawText: input.question.rawText,
        framedQuestion: input.question.framedQuestion,
        type: input.question.type,
        evaluationIntent: input.question.evaluationIntent,
      },
      recentConversation: input.conversationTranscript || "",
      priorAnswersInSession: input.continuity?.priorAnswersTranscript || "",
      followUpKind: input.continuity?.kind || "none",
      preferredFormat: input.format,
      evidenceStance: input.groundingAnalysis?.stance || "inferred",
      focusTerms: input.groundingAnalysis?.focusTerms || [],
      termEvidence: input.groundingAnalysis?.termEvidence || [],
      retrievedContext: context,
    }),
  };
}

function profileInstruction(profile?: string): string {
  if (profile?.startsWith("custom:")) {
    return `Voice: ${profile.slice("custom:".length)}`;
  }
  if (profile === "product-lead") return "Voice: product leader — user outcomes, prioritization, cross-functional influence.";
  if (profile === "executive") return "Voice: executive — concise, strategic, business impact first.";
  if (profile === "consultant") return "Voice: consultant — structured, hypothesis-driven, client-safe.";
  if (profile === "staff-engineer") return "Voice: staff engineer — systems thinking, tradeoffs, technical clarity.";
  return "Voice: confident interview candidate — clear, specific, and easy to read aloud.";
}

function roundInstruction(round: string): string {
  const instructions: Record<string, string> = {
    recruiter: "Round: recruiter screen — emphasize motivation, role fit, logistics, and clear concise answers.",
    "hiring-manager": "Round: hiring manager — emphasize scope ownership, team fit, outcomes, and collaboration.",
    behavioral: "Round: behavioral — use concrete stories with situation, action, and result.",
    technical: "Round: technical — tradeoffs, architecture, and specific implementation details.",
    coding: "Round: coding — explain approach, complexity, and edge cases clearly.",
    "system-design": "Round: system design — requirements, architecture, scaling, and failure modes.",
    case: "Round: case — structured problem solving with assumptions stated upfront.",
    panel: "Round: panel — balance breadth, clarity, and stakeholder-aware communication.",
    final: "Round: final — executive summary style, leadership, and strategic alignment.",
    other: "Round: general interview — clear, relevant, and well-structured.",
  };
  return instructions[round] || instructions.other!;
}

function responseStyleInstruction(style: string): string {
  if (style === "concise") return "Response style: concise — short sentences, minimal filler.";
  if (style === "detailed") return "Response style: detailed — richer context while staying speakable.";
  if (style === "executive") return "Response style: executive — top-down, business impact first, shorter.";
  if (style === "conversational") return "Response style: conversational — natural spoken rhythm, less scripted.";
  return "Response style: balanced — specific, calm, not too long.";
}

function formatInstruction(format?: string): string {
  if (format === "star") return "Preferred format: STAR — situation, task, action, result woven naturally.";
  if (format === "quick-bullets") return "Preferred format: quick bullets — crisp points, easy to scan while speaking.";
  if (format === "technical") return "Preferred format: technical — architecture, tradeoffs, and specifics.";
  if (format === "executive") return "Preferred format: executive — headline first, supporting detail second.";
  if (format === "system-design") return "Preferred format: system design — requirements, components, scaling.";
  if (format === "coding") return "Preferred format: coding — approach, complexity, edge cases.";
  return format ? `Preferred format: ${format}.` : "";
}

function extractTalkingPoints(structured: string): string[] {
  const match = structured.match(/MEMORY JOGGERS:\s*(.+)$/im);
  if (!match?.[1]) return [];
  return match[1]
    .split(/[,;•|]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length < 80)
    .slice(0, 3);
}

function stripTalkingPoints(structured: string): string {
  return structured.replace(/\n?MEMORY JOGGERS:[\s\S]*$/i, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
