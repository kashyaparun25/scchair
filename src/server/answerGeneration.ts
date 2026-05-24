import type { AnswerDraft, AnswerFormat, QuestionCard, SessionSetup } from "../shared/domain";
import type { ConversationTurn } from "./conversationContext";
import type { GroundingAnalysis } from "./answerGrounding";
import { groundingRiskNote } from "./answerGrounding";
import type { InterviewContinuity, PriorAnswerTurn } from "./interviewMemory";
import type { RetrievedDocumentChunk } from "./repository";

export interface GenerateAnswerInput {
  question: QuestionCard;
  session: SessionSetup;
  format?: AnswerFormat;
  now?: number;
  retrievedContext?: RetrievedDocumentChunk[];
  conversationContext?: ConversationTurn[];
  conversationTranscript?: string;
  priorAnswers?: PriorAnswerTurn[];
  continuity?: InterviewContinuity;
  groundingAnalysis?: GroundingAnalysis;
  responseProfile?: string;
  answerPromptTemplate?: string;
}

export type AnswerStreamEvent =
  | { type: "start"; questionId: string; answerId: string; format: AnswerFormat }
  | { type: "chunk"; answerId: string; stage: keyof AnswerDraft["stages"]; value: string }
  | { type: "complete"; answer: AnswerDraft };

export function generateLocalAnswerDraft(input: GenerateAnswerInput): AnswerDraft {
  const format = input.format ?? chooseAnswerFormat(input.question);
  const role = input.session.role || "the role";
  const company = input.session.company || "the company";
  const context = `${role} at ${company}`;
  const retrievedContext = input.retrievedContext ?? [];
  const scenarioHint = input.conversationContext?.slice(-3).map((turn) => turn.text).join(" ") || "";
  const sources = retrievedContext.length
    ? Array.from(new Set(retrievedContext.map((chunk) => chunk.documentName))).slice(0, 3)
    : input.session.documents
        .filter((document) => document.status === "indexed")
        .slice(0, 3)
        .map((document) => document.name);

  return {
    id: `answer-${input.question.id}-${input.now ?? Date.now()}`,
    questionId: input.question.id,
    format,
    stages: {
      bullets: buildBullets(input.question, context, retrievedContext),
      structured: buildStructuredAnswer(
        input.question,
        scenarioHint ? `${context}. Scenario context: ${scenarioHint}` : context,
        input.session.responseStyle,
        retrievedContext,
      ),
      sources,
      risk: input.groundingAnalysis
        ? groundingRiskNote(input.groundingAnalysis)
        : buildRiskNote(input.question.type, retrievedContext.length),
    },
  };
}

export async function* streamLocalAnswer(
  input: GenerateAnswerInput,
  chunkDelayMs = 0,
): AsyncGenerator<AnswerStreamEvent> {
  const answer = generateLocalAnswerDraft(input);
  yield {
    type: "start",
    questionId: answer.questionId,
    answerId: answer.id,
    format: answer.format,
  };

  for (const bullet of answer.stages.bullets) {
    await wait(chunkDelayMs);
    yield { type: "chunk", answerId: answer.id, stage: "bullets", value: bullet };
  }

  await wait(chunkDelayMs);
  yield { type: "chunk", answerId: answer.id, stage: "structured", value: answer.stages.structured };

  for (const source of answer.stages.sources) {
    await wait(chunkDelayMs);
    yield { type: "chunk", answerId: answer.id, stage: "sources", value: source };
  }

  await wait(chunkDelayMs);
  yield { type: "chunk", answerId: answer.id, stage: "risk", value: answer.stages.risk };

  await wait(chunkDelayMs);
  yield { type: "complete", answer };
}

export function chooseAnswerFormat(question: QuestionCard): AnswerFormat {
  if (question.type === "behavioral" || question.type === "situational") {
    return "star";
  }
  if (question.type === "coding") {
    return "coding";
  }
  if (question.type === "system-design") {
    return "system-design";
  }
  if (question.type === "technical") {
    return "technical";
  }
  if (question.type === "follow-up") {
    return "follow-up";
  }
  return "quick-bullets";
}

function buildBullets(question: QuestionCard, context: string, retrievedContext: RetrievedDocumentChunk[]): string[] {
  const strongestEvidence = retrievedContext[0]?.text;
  if (question.type === "behavioral" || question.type === "situational") {
    return [
      "Situation you owned",
      "Action and tradeoff",
      strongestEvidence ? "Result from your documents" : "Measurable result",
    ];
  }

  if (question.type === "coding") {
    return ["Restate constraints", "Approach and complexity", "Edge cases"];
  }

  if (question.type === "system-design") {
    return ["Requirements and scale", "Architecture tradeoffs", "Failure modes"];
  }

  return ["Lead with the point", `Tie to ${context}`, "Close with impact"];
}

function buildStructuredAnswer(
  question: QuestionCard,
  context: string,
  style: SessionSetup["responseStyle"],
  retrievedContext: RetrievedDocumentChunk[],
): string {
  const evidence = retrievedContext[0]?.text;
  const evidenceSnippet = evidence ? summarizeEvidence(evidence) : "";
  const opener = question.type === "behavioral" || question.type === "situational"
    ? "Great question. In a recent situation, I was responsible for"
    : question.type === "coding"
      ? "Sure. I would start by restating the problem and the constraints, then"
    : "Absolutely. For this role, my approach would be";

  if (evidenceSnippet) {
    return `${opener} ${evidenceSnippet} The key result was a measurable improvement for the team, and I learned how to make that tradeoff faster next time.`;
  }

  if (style === "concise") {
    return `${opener} owning a high-impact initiative for ${context}, making the tradeoff explicit, and closing with a concrete result the business could measure.`;
  }

  return `${opener} leading a meaningful initiative for ${context}, explaining the decision path clearly, and finishing with the outcome and what I would repeat in a similar interview answer.`;
}

function buildRiskNote(type: QuestionCard["type"], retrievedCount: number): string {
  if (retrievedCount === 0) {
    return "Risk: no matching uploaded document context was found. Use a real example before relying on this answer live.";
  }
  if (type === "behavioral" || type === "situational") {
    return "Grounding: document context was found. Still include the human stakes and your specific ownership.";
  }
  if (type === "technical" || type === "system-design" || type === "coding") {
    return "Grounding: document context was found. State constraints, tradeoffs, and validation signals clearly.";
  }
  return "Grounding: document context was found. Keep the response specific enough to avoid sounding generic.";
}

function summarizeEvidence(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s+/).find((item) => item.trim().length > 20) || text;
  return sentence.trim().slice(0, 220);
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}
