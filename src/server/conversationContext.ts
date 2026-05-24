import type { TranscriptEvent } from "../shared/domain";
import { extractEmbeddedQuestion } from "./questionDedup";
import { frameQuestion } from "./questionDetection";
import { normalizeUtteranceText, splitInterviewUtterances } from "./interviewUtterances";

export interface ConversationTurn {
  source: TranscriptEvent["source"];
  text: string;
  timestamp: number;
}

export interface ResolvedQuestion {
  rawText: string;
  framedQuestion: string;
  contextTurns: ConversationTurn[];
}

const continuationStartPattern =
  /^(would you|could you|can you|and what|and how|what about|how about|specifically|also|then|so how|so what|or would)\b/i;

const nonQuestionDismissPatterns = [
  /^let'?s move on\b/i,
  /^that'?s (a )?(solid|good|great|fair|nice|helpful|interesting)\b/i,
  /^(thanks|thank you|great|perfect|awesome|okay|ok)\b/i,
  /^(hi|hello|hey)\b/i,
];

export function isIncompleteQuestionFragment(text: string): boolean {
  const normalized = normalizeUtteranceText(text);
  if (!normalized) return false;
  if (normalized.length >= 90 && /\?\s*$/.test(normalized)) return false;

  if (continuationStartPattern.test(normalized)) return true;

  if (normalized.length < 50 && /\?\s*$/.test(normalized)) {
    const hasStrongCue = /\b(what|why|how|when|where|who|which|tell me|describe|explain|walk me through|hypothesis|design|implement|stock|price|data points)\b/i.test(normalized);
    if (!hasStrongCue) return true;
  }

  if (/^[a-z]/.test(normalized) && /\?\s*$/.test(normalized)) return true;

  return false;
}

export function isDismissiveOrNonQuestion(text: string): boolean {
  const normalized = normalizeUtteranceText(text);
  if (!normalized || normalized.length < 4) return true;
  if (nonQuestionDismissPatterns.some((pattern) => pattern.test(normalized))) return true;
  if (/^let'?s move on to a different topic\.?$/i.test(normalized)) return true;
  if (/^that'?s a solid approach\b/i.test(normalized)) return true;
  return false;
}

export function buildConversationWindow(
  events: TranscriptEvent[],
  options: {
    beforeTimestamp?: number;
    maxTurns?: number;
    maxChars?: number;
    interviewerOnly?: boolean;
  } = {},
): ConversationTurn[] {
  const maxTurns = options.maxTurns ?? 12;
  const maxChars = options.maxChars ?? 4000;
  const interviewerOnly = options.interviewerOnly ?? false;

  let filtered = events.filter((event) => event.isFinal && event.text.trim());
  if (options.beforeTimestamp !== undefined) {
    filtered = filtered.filter((event) => event.timestamp <= options.beforeTimestamp!);
  }
  if (interviewerOnly) {
    filtered = filtered.filter((event) => event.source !== "mic");
  }

  const turns: ConversationTurn[] = [];
  let charCount = 0;

  for (let index = filtered.length - 1; index >= 0 && turns.length < maxTurns; index -= 1) {
    const event = filtered[index]!;
    const text = normalizeUtteranceText(event.text);
    if (!text) continue;
    if (charCount + text.length > maxChars && turns.length > 0) break;
    turns.unshift({ source: event.source, text, timestamp: event.timestamp });
    charCount += text.length;
  }

  return turns;
}

export function resolveQuestionSpan(
  segment: string,
  recentEvents: TranscriptEvent[],
  streamSnapshot?: string,
): ResolvedQuestion {
  const normalized = normalizeUtteranceText(segment);
  const contextTurns = buildConversationWindow(recentEvents, { maxTurns: 10, interviewerOnly: true });

  if (streamSnapshot) {
    const fromStream = extractBestQuestionFromText(streamSnapshot);
    if (fromStream && isQuestionSpanBetter(fromStream, normalized)) {
      return {
        rawText: fromStream,
        framedQuestion: frameQuestion(fromStream),
        contextTurns,
      };
    }
  }

  if (isIncompleteQuestionFragment(normalized)) {
    const merged = mergeFragmentWithContext(normalized, contextTurns);
    if (merged) {
      return {
        rawText: merged,
        framedQuestion: frameQuestion(merged),
        contextTurns,
      };
    }
  }

  const expanded = normalized.length > 80 ? extractEmbeddedQuestion(normalized) : normalized;
  return {
    rawText: expanded,
    framedQuestion: frameQuestion(expanded),
    contextTurns,
  };
}

export function resolveQuestionAtAnswerTime(
  question: { rawText: string; framedQuestion: string; createdAt: number },
  events: TranscriptEvent[],
): ResolvedQuestion {
  const beforeTimestamp = question.createdAt + 250;
  const priorEvents = events.filter((event) => event.timestamp <= beforeTimestamp);
  const contextTurns = buildConversationWindow(priorEvents, {
    beforeTimestamp,
    maxTurns: 14,
    maxChars: 4500,
  });
  const resolved = resolveQuestionSpan(question.rawText, priorEvents);
  return {
    ...resolved,
    contextTurns: contextTurns.length ? contextTurns : resolved.contextTurns,
  };
}

export function formatConversationForPrompt(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => {
      const label = turn.source === "mic" ? "Candidate" : "Interviewer";
      return `${label}: ${turn.text}`;
    })
    .join("\n");
}

function extractBestQuestionFromText(text: string): string {
  const normalized = normalizeUtteranceText(text);
  if (!normalized) return normalized;

  const segments = splitInterviewUtterances(normalized);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (/\?\s*$/.test(segment) && segment.length >= 12 && !isDismissiveOrNonQuestion(segment)) {
      return segment.length > 80 ? extractEmbeddedQuestion(segment) : segment;
    }
  }

  const embedded = extractEmbeddedQuestion(normalized);
  return embedded.length >= 12 ? embedded : normalized;
}

function isQuestionSpanBetter(candidate: string, fragment: string): boolean {
  if (candidate === fragment) return false;
  const fragStem = fragment.toLowerCase().replace(/\?$/, "").trim();
  if (fragment.length < 40 && candidate.toLowerCase().includes(fragStem)) return true;
  if (isIncompleteQuestionFragment(fragment) && candidate.length > fragment.length + 12) return true;
  return false;
}

function mergeFragmentWithContext(fragment: string, turns: ConversationTurn[]): string | undefined {
  const fragStem = fragment.toLowerCase().replace(/\?$/, "").trim();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turnText = turns[index]!.text;
    const segments = splitInterviewUtterances(turnText);
    for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = segments[segmentIndex]!;
      const segmentStem = segment.toLowerCase().replace(/\?$/, "").trim();
      if (segmentStem.includes(fragStem) || fragStem.includes(segmentStem)) {
        if (segment.length >= fragment.length) return segment;
      }
    }
  }

  const combined = normalizeUtteranceText(
    [...turns.slice(-4).map((turn) => turn.text), fragment].join(" "),
  );
  const best = extractBestQuestionFromText(combined);
  if (best.length > fragment.length + 8 && !isIncompleteQuestionFragment(best)) return best;

  return undefined;
}
