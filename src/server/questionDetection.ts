import type { QuestionCard, QuestionType, TranscriptEvent } from "../shared/domain";
import { normalizeUtteranceText, splitInterviewUtterances } from "./interviewUtterances";

export interface QuestionDetectionOptions {
  now?: number;
  minimumConfidence?: number;
  idPrefix?: string;
}

interface TypeRule {
  type: QuestionType;
  intent: string;
  keywords: string[];
}

const typeRules: TypeRule[] = [
  {
    type: "behavioral",
    intent: "Assesses past behavior, ownership, collaboration, and reflection.",
    keywords: ["tell me about a time", "describe a time", "conflict", "failure", "leadership", "about yourself"],
  },
  {
    type: "technical",
    intent: "Assesses technical judgment, implementation depth, and tradeoff reasoning.",
    keywords: ["technical", "architecture", "tradeoff", "latency", "scalability", "reliability"],
  },
  {
    type: "coding",
    intent: "Assesses problem solving, algorithmic clarity, and coding fluency.",
    keywords: ["code", "algorithm", "complexity", "data structure", "function", "bug"],
  },
  {
    type: "system-design",
    intent: "Assesses ability to design reliable systems under constraints.",
    keywords: ["design a", "system design", "distributed", "scale", "throughput", "database"],
  },
  {
    type: "situational",
    intent: "Assesses decision making in a hypothetical scenario.",
    keywords: ["what would you do", "how would you handle", "suppose", "imagine", "are you able to", "hypothesis", "hypothesize", "testing your hypothesis", "test your hypothesis", "scenario"],
  },
  {
    type: "culture",
    intent: "Assesses working style, values, and team fit.",
    keywords: ["culture", "team", "manager", "feedback", "values", "working style"],
  },
  {
    type: "resume",
    intent: "Assesses credibility and depth behind resume claims.",
    keywords: ["resume", "your experience", "your background", "project", "achievement", "about yourself", "tell me about"],
  },
  {
    type: "follow-up",
    intent: "Probes a previous answer for specificity, evidence, or clarification.",
    keywords: ["can you elaborate", "why", "what happened next", "say more", "example"],
  },
  {
    type: "logistics",
    intent: "Clarifies process, timing, availability, compensation, or next steps.",
    keywords: ["availability", "start date", "compensation", "salary", "next steps", "timeline", "work in", "in person", "office", "relocate", "location"],
  },
];

const directQuestionPatterns = [
  /\?\s*$/,
  /\b(can you|could you|would you|are you|do you|did you|have you|will you|tell me|walk me through|describe|explain|give me an example)\b/i,
  /\b(what|why|how|when|where|who|which)\b/i,
  /\babout yourself\b/i,
  /\bable to work\b/i,
];

const nonQuestionPatterns = [
  /^(hi|hello|hey|thanks|thank you|great|perfect|sounds good|awesome|okay|ok)\b/i,
  /^(i am|i'm|my name is|nice to meet|good to meet|excited to get started|conducting your interview)\b/i,
  /^(let's get started|let us begin|we'll begin|welcome to)\b/i,
  /^let'?s dive into some questions\b/i,
  /^this position is in person\b/i,
  /^so you would come in to the \w+ office\b/i,
];

export function detectQuestions(
  events: TranscriptEvent[],
  options: QuestionDetectionOptions = {},
): QuestionCard[] {
  const minimumConfidence = options.minimumConfidence ?? 0.48;
  const createdAt = options.now ?? Date.now();
  const idPrefix = options.idPrefix ?? "detected-question";
  const seenRawText = new Set<string>();

  const questions: QuestionCard[] = [];

  events
    .filter((event) => event.isFinal && event.source !== "mic")
    .forEach((event, eventIndex) => {
      const segments = splitInterviewUtterances(event.text);
      segments.forEach((segment, segmentIndex) => {
        const question = detectQuestionFromText(
          segment,
          eventIndex * 100 + segmentIndex,
          createdAt,
          idPrefix,
        );
        if (!question || question.confidence < minimumConfidence) return;
        if (seenRawText.has(question.rawText)) return;
        seenRawText.add(question.rawText);
        questions.push(question);
      });
    });

  return questions;
}

export function detectQuestionFromText(
  text: string,
  index = 0,
  createdAt = Date.now(),
  idPrefix = "detected-question",
): QuestionCard | undefined {
  const normalized = normalizeUtteranceText(text);
  if (!normalized || normalized.length < 8) {
    return undefined;
  }

  if (isLikelyNonQuestion(normalized)) {
    return undefined;
  }

  const questionSignal = scoreQuestionSignal(normalized);
  const rule = selectTypeRule(normalized);
  const confidence = clamp(questionSignal + scoreKeywordSignal(normalized, rule), 0, 0.98);

  if (confidence < 0.35) {
    return undefined;
  }

  return {
    id: `${idPrefix}-${createdAt}-${index + 1}`,
    rawText: normalized,
    framedQuestion: frameQuestion(normalized),
    type: rule.type,
    confidence: roundConfidence(confidence),
    evaluationIntent: rule.intent,
    createdAt,
    status: "new",
  };
}

export function frameQuestion(text: string): string {
  const normalized = normalizeUtteranceText(text);
  if (normalized.endsWith("?")) {
    return normalized;
  }
  if (/^(tell me about|walk me through|describe|explain|give me an example)\b/i.test(normalized)) {
    return `${normalized.replace(/[.。]+$/, "")}.`;
  }
  return `Respond to: ${normalized.replace(/[.。]+$/, "")}.`;
}

function isLikelyNonQuestion(text: string): boolean {
  if (nonQuestionPatterns.some((pattern) => pattern.test(text))) {
    return !/\?\s*$/.test(text) && !/\b(tell me|can you|could you|are you|what|why|how)\b/i.test(text);
  }
  return false;
}

function scoreQuestionSignal(text: string): number {
  let score = 0.12;
  for (const pattern of directQuestionPatterns) {
    if (pattern.test(text)) score += 0.2;
  }
  if (/\?\s*$/.test(text)) score += 0.18;
  return Math.min(score, 0.92);
}

function scoreKeywordSignal(text: string, rule: TypeRule): number {
  const lower = text.toLowerCase();
  const matches = rule.keywords.filter((keyword) => lower.includes(keyword)).length;
  return Math.min(matches * 0.1, 0.3);
}

function selectTypeRule(text: string): TypeRule {
  const lower = text.toLowerCase();
  let bestRule = typeRules[1] as TypeRule;
  let bestScore = 0;

  for (const rule of typeRules) {
    const score = rule.keywords.filter((keyword) => lower.includes(keyword)).length;
    if (score > bestScore) {
      bestRule = rule;
      bestScore = score;
    }
  }

  return bestRule;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundConfidence(confidence: number): number {
  return Math.round(confidence * 100) / 100;
}
