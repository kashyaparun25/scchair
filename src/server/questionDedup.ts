import { normalizeUtteranceText, splitInterviewUtterances } from "./interviewUtterances";

const embeddedQuestionPatterns = [
  /\b((?:are you able to|can you|could you|would you|do you|will you|have you|did you)[^.?!]{4,120}[.?!]?)\s*$/i,
  /\b((?:tell me about|walk me through|describe|explain|give me an example of)[^.?!]{4,160}[.?!]?)\s*$/i,
  /\b((?:what|why|how|when|where|who|which)\b[^.?!]{4,160}[.?!]?)\s*$/i,
];

const preamblePattern =
  /^(?:let'?s dive into(?: some questions)?[,.]?|this position is in person,?|so you would come in to the \w+ office,?|you would come in to the \w+ office,?|\s)+/i;

export function extractEmbeddedQuestion(text: string): string {
  const normalized = normalizeUtteranceText(text);
  if (!normalized) return normalized;

  for (const pattern of embeddedQuestionPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const candidate = normalizeUtteranceText(match[1]);
      if (candidate.length >= 12) return candidate;
    }
  }

  const withoutPreamble = normalizeUtteranceText(normalized.replace(preamblePattern, ""));
  if (withoutPreamble.length >= 12 && withoutPreamble.length < normalized.length) {
    return withoutPreamble;
  }

  const segments = splitInterviewUtterances(normalized);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (/\?/.test(segment) || /\b(are you|can you|tell me|what|why|how)\b/i.test(segment)) {
      return segment;
    }
  }

  return normalized;
}

export function questionFingerprint(text: string): string {
  return extractEmbeddedQuestion(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSameQuestion(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 12) return false;

  if (longer.includes(shorter)) return true;

  const leftTokens = new Set(shorter.split(" "));
  const rightTokens = longer.split(" ");
  const overlap = rightTokens.filter((token) => leftTokens.has(token)).length;
  const union = new Set([...shorter.split(" "), ...longer.split(" ")]).size;
  return union > 0 && overlap / union >= 0.72;
}

export function isDuplicateQuestion(candidateText: string, existingTexts: string[]): boolean {
  const candidateKey = questionFingerprint(candidateText);
  if (!candidateKey) return false;
  return existingTexts.some((existing) => isSameQuestion(candidateKey, questionFingerprint(existing)));
}
