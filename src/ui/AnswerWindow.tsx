import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, EyeOff, GripHorizontal, Pin, RefreshCw, Sparkles, WandSparkles, X } from "lucide-react";
import type { AnswerDraft, AnswerFormat, DocumentSummary, QuestionCard, SessionSetup, TranscriptEvent } from "../shared/domain";
import { answerFormatOptions } from "../shared/domain";

type DesktopWindowApi = Window & {
  interviewCopilot?: {
    windows?: {
      show: (role: "main" | "overlay" | "answer") => Promise<unknown>;
      hide: (role: "main" | "overlay" | "answer") => Promise<unknown>;
      hideOverlays?: () => Promise<unknown>;
    };
  };
};

interface BootstrapState {
  session: SessionSetup | null;
  documents: DocumentSummary[];
  transcriptEvents: TranscriptEvent[];
  questionCards: QuestionCard[];
  answerDrafts: AnswerDraft[];
}

const formatOptions: { label: string; value: AnswerFormat }[] = [...answerFormatOptions];

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.clone().json();
    if (typeof payload.error === "string") return payload.error;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // Use fallback.
  }
  return fallback;
}

function AnswerWindow() {
  const [state, setState] = useState<BootstrapState>({
    session: null,
    documents: [],
    transcriptEvents: [],
    questionCards: [],
    answerDrafts: []
  });
  const [format, setFormat] = useState<AnswerFormat>("technical");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) {
      setNotice(await apiErrorMessage(response, "Latest answer state is unavailable."));
      return;
    }
    const next = await response.json() as BootstrapState;
    setState(next);
    setSelectedQuestionId((current) => {
      if (current && next.questionCards.some((question) => question.id === current)) return current;
      return [...next.questionCards].filter((question) => question.status !== "dismissed").sort((a, b) => b.createdAt - a.createdAt)[0]?.id || "";
    });
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2200);
    return () => window.clearInterval(id);
  }, [refresh]);

  const activeQuestions = useMemo(
    () => [...state.questionCards].filter((question) => question.status !== "dismissed").sort((a, b) => b.createdAt - a.createdAt),
    [state.questionCards]
  );
  const selectedQuestion = activeQuestions.find((question) => question.id === selectedQuestionId) || activeQuestions[0] || null;
  const activeAnswer = useMemo(() => {
    if (!selectedQuestion) return null;
    return [...state.answerDrafts]
      .reverse()
      .find((answer) => answer.questionId === selectedQuestion.id && answer.format === format)
      || [...state.answerDrafts].reverse().find((answer) => answer.questionId === selectedQuestion.id)
      || null;
  }, [format, selectedQuestion, state.answerDrafts]);

  const generateAnswer = async () => {
    if (!selectedQuestion) {
      setNotice("No question is available yet.");
      return;
    }
    setIsAnswering(true);
    setNotice("Generating answer...");
    const response = await fetch(`/api/questions/${selectedQuestion.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format })
    });
    setIsAnswering(false);
    if (!response.ok) {
      setNotice(await apiErrorMessage(response, "Answer generation failed."));
      return;
    }
    const answer = await response.json() as AnswerDraft;
    setState((current) => ({
      ...current,
      answerDrafts: [
        ...current.answerDrafts.filter((candidate) => !(candidate.questionId === answer.questionId && candidate.format === answer.format)),
        answer
      ],
      questionCards: current.questionCards.map((question) =>
        question.id === answer.questionId ? { ...question, status: "answered" } : question
      )
    }));
    setNotice("Answer ready.");
  };

  const copyAnswer = async () => {
    if (!activeAnswer) return;
    const text = [
      activeAnswer.stages.structured,
      ...activeAnswer.stages.bullets.map((bullet) => `- ${bullet}`),
      activeAnswer.stages.risk
    ].filter(Boolean).join("\n\n");
    await navigator.clipboard?.writeText(text);
    await fetch(`/api/answers/${activeAnswer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ copiedAt: Date.now() })
    });
    setNotice("Copied answer.");
    void refresh();
  };

  const togglePinned = async () => {
    if (!activeAnswer) return;
    const response = await fetch(`/api/answers/${activeAnswer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !activeAnswer.pinned })
    });
    if (!response.ok) {
      setNotice(await apiErrorMessage(response, "Pinned state could not be saved."));
      return;
    }
    const answer = await response.json() as AnswerDraft;
    setState((current) => ({
      ...current,
      answerDrafts: current.answerDrafts.map((candidate) => candidate.id === answer.id ? answer : candidate)
    }));
  };

  const openOverlay = () => {
    const desktop = window as DesktopWindowApi;
    if (desktop.interviewCopilot?.windows?.show) {
      void desktop.interviewCopilot.windows.show("overlay");
      return;
    }
    window.open("?view=overlay", "second-chair-overlay", "width=440,height=680,noopener,noreferrer");
  };

  const hideAnswer = () => {
    const desktop = window as DesktopWindowApi;
    void desktop.interviewCopilot?.windows?.hide?.("answer");
  };

  const hideAllOverlays = () => {
    const desktop = window as DesktopWindowApi;
    if (desktop.interviewCopilot?.windows?.hideOverlays) {
      void desktop.interviewCopilot.windows.hideOverlays();
      return;
    }
    hideAnswer();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideAnswer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="answer-window-shell" aria-label="Detached answer window">
      <header className="answer-window-header">
        <div className="answer-window-header-title">
          <GripHorizontal size={16} className="answer-window-drag-handle" aria-hidden="true" />
          <div>
            <span className="eyebrow">Detached answer</span>
            <h1>{state.session?.title || "Second Chair"}</h1>
          </div>
        </div>
        <div className="answer-window-actions">
          <button className="icon-button" type="button" title="Refresh" aria-label="Refresh latest answer" onClick={() => void refresh()}>
            <RefreshCw size={16} />
          </button>
          <button className="icon-button" type="button" title="Open overlay" aria-label="Open overlay" onClick={openOverlay}>
            <ExternalLink size={16} />
          </button>
          <button className="icon-button" type="button" title="Hide all overlays" aria-label="Hide all overlays" onClick={hideAllOverlays}>
            <EyeOff size={16} />
          </button>
          <button className="icon-button" type="button" title="Hide answer window" aria-label="Hide answer window" onClick={hideAnswer}>
            <X size={16} />
          </button>
        </div>
      </header>

      <section className="answer-window-controls" aria-label="Answer controls">
        <label>
          <span>Question</span>
          <select value={selectedQuestion?.id || ""} onChange={(event) => setSelectedQuestionId(event.target.value)}>
            {activeQuestions.map((question) => (
              <option key={question.id} value={question.id}>{question.rawText.slice(0, 96)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as AnswerFormat)}>
            {formatOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </section>

      <section className="answer-window-question">
        <span>{selectedQuestion?.type || "waiting"} {selectedQuestion ? `- ${Math.round(selectedQuestion.confidence * 100)}%` : ""}</span>
        <h2>{selectedQuestion?.rawText || "Waiting for a detected question"}</h2>
        <p>{selectedQuestion?.evaluationIntent || "The latest detected question and answer will stay current from the running session."}</p>
      </section>

      <section className="answer-window-draft">
        <div className="draft-label">
          <span>
            <WandSparkles size={18} />
            Recommended response
          </span>
          <button type="button" onClick={() => void copyAnswer()} disabled={!activeAnswer || isAnswering}>
            <Copy size={15} />
            Copy
          </button>
          <button type="button" aria-pressed={Boolean(activeAnswer?.pinned)} onClick={() => void togglePinned()} disabled={!activeAnswer || isAnswering}>
            <Pin size={15} />
            {activeAnswer?.pinned ? "Pinned" : "Pin"}
          </button>
        </div>
        <p>{activeAnswer?.stages.structured || "Generate an answer from the selected question to fill this window."}</p>
      </section>

      <div className="answer-window-bullets">
        {(activeAnswer?.stages.bullets || []).map((bullet) => (
          <article key={bullet}>
            <Check size={15} />
            <p>{bullet}</p>
          </article>
        ))}
      </div>

      <section className="answer-window-risk">
        {activeAnswer?.stages.risk || "Grounding and risk notes will appear after answer generation."}
      </section>

      <footer className="answer-window-footer">
        <button className="primary-action" type="button" onClick={() => void generateAnswer()} disabled={isAnswering || !selectedQuestion}>
          <Sparkles size={17} />
          {isAnswering ? "Generating" : "Answer"}
        </button>
        <span>{notice || `${state.transcriptEvents.length} transcript events available`}</span>
      </footer>
    </main>
  );
}

export { AnswerWindow };
