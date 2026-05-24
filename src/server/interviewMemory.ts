import type { AnswerDraft, QuestionCard } from "../shared/domain";

export interface PriorAnswerTurn {
  questionId: string;
  questionText: string;
  answerText: string;
  createdAt: number;
}

export type FollowUpKind =
  | "none"
  | "conditional"
  | "expand_scope"
  | "pivot_strengths"
  | "clarify"
  | "continuation";

export interface InterviewContinuity {
  kind: FollowUpKind;
  priorAnswers: PriorAnswerTurn[];
  priorAnswersTranscript: string;
  instruction: string;
}

export function buildPriorAnswerHistory(
  questions: QuestionCard[],
  answers: AnswerDraft[],
  currentQuestionId: string,
  maxTurns = 5,
): PriorAnswerTurn[] {
  const current = questions.find((question) => question.id === currentQuestionId);
  const cutoff = current?.createdAt ?? Date.now();

  return questions
    .filter((question) =>
      question.id !== currentQuestionId
      && question.createdAt < cutoff
      && question.status !== "dismissed",
    )
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-maxTurns)
    .map((question) => {
      const answer = answers
        .filter((draft) => draft.questionId === question.id)
        .sort((left, right) => stripMemoryJoggers(right.stages.structured).length - stripMemoryJoggers(left.stages.structured).length)[0];

      return {
        questionId: question.id,
        questionText: question.framedQuestion || question.rawText,
        answerText: stripMemoryJoggers(answer?.stages.structured || ""),
        createdAt: question.createdAt,
      };
    })
    .filter((turn) => turn.answerText.trim().length > 0);
}

export function buildInterviewContinuity(
  question: QuestionCard,
  priorAnswers: PriorAnswerTurn[],
): InterviewContinuity {
  const text = `${question.rawText} ${question.framedQuestion}`.toLowerCase();
  const priorAnswersTranscript = formatPriorAnswersForPrompt(priorAnswers);
  const kind = detectFollowUpKind(text, priorAnswers);
  const instruction = buildContinuityInstruction(kind, text, priorAnswers);

  return {
    kind,
    priorAnswers,
    priorAnswersTranscript,
    instruction,
  };
}

function detectFollowUpKind(text: string, priorAnswers: PriorAnswerTurn[]): FollowUpKind {
  if (!priorAnswers.length) return "none";

  if (/\bif so\b|\bin that case\b|\bgiven that\b/i.test(text)) return "conditional";
  if (/\b(other|another|any other|what else|besides|in addition)\b/i.test(text)) return "expand_scope";
  if (/\b(what you do know|what you know|focus on what|let'?s focus|play to your strengths|your strengths)\b/i.test(text)) {
    return "pivot_strengths";
  }
  if (/\b(you mentioned|you said|earlier|previously|just now|follow up|elaborate|more detail|can you share)\b/i.test(text)) {
    return "clarify";
  }
  if (/\b(and how|and what|also|tell me more)\b/i.test(text)) return "continuation";

  return priorAnswers.length >= 1 ? "continuation" : "none";
}

function buildContinuityInstruction(
  kind: FollowUpKind,
  questionText: string,
  priorAnswers: PriorAnswerTurn[],
): string {
  if (!priorAnswers.length) {
    return [
      "Session continuity:",
      "- This is an early question in the interview. Answer fully but leave room for follow-ups.",
    ].join("\n");
  }

  const lines = [
    "Session continuity (mandatory):",
    "- priorAnswersInSession lists what the candidate ALREADY said aloud in this interview.",
    "- Stay consistent with priorAnswersInSession. Never contradict a prior answer.",
    "- Do not repeat the same denial, metric, or project example verbatim — extend or add nuance.",
    "- Reference the thread naturally when helpful: 'As I mentioned...', 'Building on that...', 'To add to what I shared...'.",
  ];

  const lastAnswer = priorAnswers.at(-1);
  const lastCombined = priorAnswers.slice(-2).map((turn) => turn.answerText.toLowerCase()).join(" ");
  const deniedDirectUse = /\b(haven'?t|have not|not directly|no direct|didn'?t directly)\b/i.test(lastCombined);

  if (kind === "conditional") {
    lines.push(
      "- This question uses 'if so' or similar — check priorAnswersInSession first.",
      deniedDirectUse
        ? "- Prior answers already established a gap or 'no' for the main skill. Do NOT answer as if you used it. Pivot: 'Since I haven't used [X] directly, the closest example is...'"
        : "- If prior answers support 'yes', give the concrete example now without re-introducing from scratch.",
    );
  }

  if (kind === "expand_scope") {
    lines.push(
      "- The interviewer wants ADDITIONAL examples beyond what was already covered.",
      "- Scan priorAnswersInSession and add different tools, projects, or angles not yet mentioned.",
      "- Do not re-list the same CrewAI/LangChain paragraph unless adding new detail.",
    );
  }

  if (kind === "pivot_strengths") {
    lines.push(
      "- The interviewer is redirecting to strengths after a gap discussion.",
      "- Lead with confident documented strengths. Briefly acknowledge the gap only if needed, then pivot forward.",
      "- Emphasize learning agility with one concrete documented win, not generic 'I'm a fast learner' filler.",
    );
  }

  if (kind === "clarify" || kind === "continuation") {
    lines.push(
      "- Treat this as a follow-up in the same topic thread.",
      "- Answer the new question in light of priorAnswersInSession; avoid resetting the conversation.",
    );
  }

  if (lastAnswer && /example|project|share/i.test(questionText)) {
    lines.push(`- Most recent prior answer topic: "${lastAnswer.questionText.slice(0, 120)}".`);
  }

  lines.push("- Works for any interview type (technical, support, behavioral, sales): continuity and honesty apply universally.");

  return lines.join("\n");
}

export function formatPriorAnswersForPrompt(priorAnswers: PriorAnswerTurn[]): string {
  if (!priorAnswers.length) return "";
  return priorAnswers
    .map((turn, index) => `Q${index + 1}: ${turn.questionText}\nA${index + 1}: ${turn.answerText}`)
    .join("\n\n");
}

function stripMemoryJoggers(text: string): string {
  return text.replace(/\n?MEMORY JOGGERS:[\s\S]*$/i, "").trim();
}
