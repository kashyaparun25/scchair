import type { QuestionCard, TranscriptEvent } from "../shared/domain";
import {
  isDismissiveOrNonQuestion,
  isIncompleteQuestionFragment,
  resolveQuestionSpan,
} from "./conversationContext";
import { detectQuestionFromText } from "./questionDetection";
import { extractEmbeddedQuestion, isDuplicateQuestion } from "./questionDedup";
import { splitInterviewUtterances } from "./interviewUtterances";
import type { InterviewCopilotRepository } from "./repository";

const minimumConfidence = 0.48;

export interface TranscriptDetectOptions {
  streamSnapshot?: string;
}

export function appendTranscriptAndDetect(
  repository: InterviewCopilotRepository,
  event: TranscriptEvent,
  options: TranscriptDetectOptions = {},
): QuestionCard[] {
  if (event.text.trim()) {
    repository.appendTranscriptEvent(event);
  }

  const existingQuestions = repository.listQuestions();
  const existingRawText = existingQuestions.map((question) => question.rawText);
  const recentEvents = repository.listTranscriptEvents();
  let index = existingQuestions.length;
  const now = Date.now();

  for (const segment of splitInterviewUtterances(event.text)) {
    if (isDismissiveOrNonQuestion(segment)) continue;

    const resolved = resolveQuestionSpan(segment, recentEvents, options.streamSnapshot);
    const focusText = resolved.rawText.length > 80 ? extractEmbeddedQuestion(resolved.rawText) : resolved.rawText;
    if (isDismissiveOrNonQuestion(focusText)) continue;

    const detected = detectQuestionFromText(focusText, index, now, "question");
    index += 1;
    if (!detected || detected.confidence < minimumConfidence) continue;

    detected.rawText = resolved.rawText;
    detected.framedQuestion = resolved.framedQuestion;

    if (existingRawText.includes(detected.rawText)) continue;
    if (isDuplicateQuestion(detected.rawText, existingRawText)) continue;
    repository.saveQuestion(detected);
    existingRawText.push(detected.rawText);
  }

  return repository.listQuestions();
}

export function looksQuestionReady(text: string, interim = false): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  if (isDismissiveOrNonQuestion(trimmed)) return false;

  const hasTerminalPunctuation = /[.!?]\s*$/.test(trimmed);

  if (interim) {
    if (!hasTerminalPunctuation) return false;
    if (trimmed.length < 28) return false;
    if (isIncompleteQuestionFragment(trimmed)) return false;
    if (trimmed.length > 140) return false;
    if (/\b(let's dive into|this position is in person|come in to the)\b/i.test(trimmed) && trimmed.length > 60) {
      return false;
    }
  }

  if (hasTerminalPunctuation) return true;
  return /\b(about yourself|tell me about|can you tell me)\b/i.test(trimmed);
}
