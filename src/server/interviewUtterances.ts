import { isSameQuestion, questionFingerprint } from "./questionDedup";

export function normalizeUtteranceText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function splitInterviewUtterances(text: string): string[] {
  const normalized = normalizeUtteranceText(text);
  if (!normalized) return [];

  const sentenceParts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 4);

  if (sentenceParts.length > 1) return sentenceParts;

  const phraseParts = normalized
    .split(/\b(?:let's dive into(?: some questions)?,?|this position is in person,?|so you would come in to the \w+ office,?)\b/gi)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 8);

  return phraseParts.length > 1 ? phraseParts : sentenceParts;
}

export function newUtterancesSincePrevious(fullText: string, previousText: string): string[] {
  const normalizedFull = normalizeUtteranceText(fullText);
  const normalizedPrevious = normalizeUtteranceText(previousText);

  if (!normalizedPrevious) {
    return splitInterviewUtterances(normalizedFull);
  }

  if (normalizedFull === normalizedPrevious) return [];

  let candidateUtterances: string[] = [];

  if (normalizedFull.toLowerCase().startsWith(normalizedPrevious.toLowerCase())) {
    const delta = normalizedFull.slice(normalizedPrevious.length).trim();
    candidateUtterances = delta ? splitInterviewUtterances(delta) : [];
  } else {
    const previousFingerprints = new Set(
      splitInterviewUtterances(normalizedPrevious).map((utterance) => questionFingerprint(utterance)),
    );
    candidateUtterances = splitInterviewUtterances(normalizedFull).filter((utterance) => {
      const fingerprint = questionFingerprint(utterance);
      if (previousFingerprints.has(fingerprint)) return false;
      return !Array.from(previousFingerprints).some((previous) => isSameQuestion(fingerprint, previous));
    });
  }

  const seen = new Set<string>();
  return candidateUtterances.filter((utterance) => {
    const fingerprint = questionFingerprint(utterance);
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}
