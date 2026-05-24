import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeAudioCapture } from "./hooks/useRealtimeAudioCapture";
import { SettingsPage } from "./SettingsPage";
import { ApiKeyGuideCard } from "./ApiKeyGuideCard";
import { DEFAULT_API_KEY_GUIDE } from "../shared/apiKeyGuides";
import {
  AudioWaveform,
  Bookmark,
  Bot,
  BriefcaseBusiness,
  Check,
  CheckSquare,
  ChevronRight,
  ClipboardList,
  Copy,
  Database,
  ExternalLink,
  EyeOff,
  FileText,
  History,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  Mic2,
  MonitorDot,
  Pause,
  Pin,
  Play,
  Radio,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  UserRoundCheck,
  WandSparkles,
  X
} from "lucide-react";
import type {
  AnswerDraft,
  AnswerFormat,
  DocumentSummary,
  PromptSetting,
  QuestionCard,
  InterviewRound,
  SessionArchiveSummary,
  SessionMode,
  SessionSetup,
  TranscriptEvent,
  VoiceProfile,
} from "../shared/domain";

type AppPage = "live" | "setup" | "knowledge" | "prompts" | "review" | "settings";
type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type BrowserSpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
    interviewCopilot?: {
      windows?: {
        show: (role: "main" | "overlay" | "answer") => Promise<unknown>;
        hide: (role: "main" | "overlay" | "answer") => Promise<unknown>;
        hideOverlays?: () => Promise<unknown>;
        toggle: (role: "main" | "overlay" | "answer") => Promise<unknown>;
        setClickThrough?: (role: "overlay" | "answer", enabled: boolean) => Promise<unknown>;
      };
      capture?: {
        screenshot: (options?: { sourceId?: string }) => Promise<{ dataUrl: string; name: string; id: string }>;
      };
      shortcuts?: {
        on: (channel: "shortcut:captureScreenshot" | "shortcut:toggleAnswer" | "shortcut:toggleOverlay" | "shortcut:hideOverlays", listener: (payload: unknown) => void) => () => void;
      };
    };
  }
}

const formatOptions: { label: string; value: AnswerFormat }[] = [
  { label: "Bullets", value: "quick-bullets" },
  { label: "STAR", value: "star" },
  { label: "Technical", value: "technical" },
  { label: "Executive", value: "executive" }
];

const promptProfiles: { label: string; value: VoiceProfile; note: string }[] = [
  { label: "Product lead", value: "product-lead", note: "Outcome, sequencing, launch judgment" },
  { label: "Staff engineer", value: "staff-engineer", note: "Architecture, influence, risk" },
  { label: "Executive", value: "executive", note: "Crisp, strategic, board-ready" },
  { label: "Consultant", value: "consultant", note: "Structured, commercial, direct" },
  { label: "Custom", value: "custom", note: "Describe your own voice below" },
];

const voiceChipOptions = promptProfiles.map(({ label, value }) => ({ label, value }));

function roundLabel(round: InterviewRound): string {
  return roundOptions.find((option) => option.value === round)?.label || "Interview";
}

function voiceProfileLabel(profile: VoiceProfile, customVoice = ""): string {
  if (profile === "custom") return customVoice.trim() || "Custom voice";
  return promptProfiles.find((option) => option.value === profile)?.label || "Staff engineer";
}

function buildSessionTitle(role: string, company: string): string {
  const trimmedRole = role.trim();
  const trimmedCompany = company.trim();
  if (trimmedRole && trimmedCompany) return `${trimmedRole} @ ${trimmedCompany}`;
  if (trimmedRole) return trimmedRole;
  return "Interview session";
}

const roundOptions: { label: string; value: InterviewRound }[] = [
  { label: "Recruiter", value: "recruiter" },
  { label: "Hiring manager", value: "hiring-manager" },
  { label: "Behavioral", value: "behavioral" },
  { label: "Technical", value: "technical" },
  { label: "System design", value: "system-design" },
  { label: "Final", value: "final" }
];

const responseStyleOptions: { title: string; detail: string; value: SessionSetup["responseStyle"] }[] = [
  { title: "Balanced", detail: "Specific, calm, not too long", value: "balanced" },
  { title: "Executive", detail: "Shorter, sharper, top-down", value: "executive" },
  { title: "Conversational", detail: "Natural and less scripted", value: "conversational" }
];

interface BootstrapState {
  session: SessionSetup | null;
  documents: DocumentSummary[];
  transcriptEvents: TranscriptEvent[];
  questionCards: QuestionCard[];
  answerDrafts: AnswerDraft[];
  prompts?: PromptSetting[];
}

interface SessionReport {
  id: string;
  generatedAt: number;
  summary: string;
  strengths: string[];
  focus: string[];
}

type AnswerStreamEvent =
  | { type: "start"; questionId: string; answerId: string; format: AnswerFormat }
  | { type: "chunk"; answerId: string; stage: keyof AnswerDraft["stages"]; value: string }
  | { type: "complete"; answer: AnswerDraft }
  | { type: "question_update"; question: QuestionCard };

interface ApiErrorPayload {
  error?: string | {
    code?: string;
    message?: string;
    requestId?: string;
    status?: number;
  };
}

interface TranscriptPayload {
  event: TranscriptEvent;
  questions: QuestionCard[];
}

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.clone().json()) as ApiErrorPayload;
    if (typeof payload.error === "string") return payload.error;
    if (payload.error?.message) {
      return payload.error.requestId
        ? `${payload.error.message} (${payload.error.requestId})`
        : payload.error.message;
    }
  } catch {
    // Ignore malformed error bodies and use the caller's contextual fallback.
  }
  return fallback;
}

function isApiErrorPayload(event: AnswerStreamEvent | ApiErrorPayload): event is ApiErrorPayload {
  return Boolean((event as ApiErrorPayload).error) && (event as AnswerStreamEvent).type === undefined;
}

function blankSession(documents: DocumentSummary[] = []): SessionSetup {
  return {
    id: "",
    mode: "interview",
    title: "Interview session",
    role: "",
    company: "",
    round: "hiring-manager",
    seniority: "",
    responseStyle: "balanced",
    language: "English",
    voiceProfile: "staff-engineer",
    customVoice: "",
    answerFormat: "technical",
    documents
  };
}

const pageTabs: { id: AppPage; label: string; icon: typeof MessageCircle; description: string }[] = [
  { id: "setup", label: "Session Setup", icon: BriefcaseBusiness, description: "Role, documents, intent" },
  { id: "live", label: "Live Assist", icon: MessageCircle, description: "Transcript, questions, answer now" },
  { id: "knowledge", label: "Knowledge", icon: Database, description: "Resume, JD, notes" },
  { id: "prompts", label: "Prompt Studio", icon: SlidersHorizontal, description: "System prompts and style" },
  { id: "settings", label: "Settings", icon: Settings2, description: "AI provider and API keys" },
  { id: "review", label: "Review", icon: History, description: "Timeline and report" }
];

function App() {
  const initialPage = getInitialPage();
  const [activePage, setActivePage] = useState<AppPage>(initialPage);
  const [session, setSession] = useState<SessionSetup>(() => blankSession());
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<AnswerDraft[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEvent[]>([]);
  const [mode, setMode] = useState<SessionMode>("interview");
  const [isLive, setIsLive] = useState(true);
  const [isAnswering, setIsAnswering] = useState(false);
  const [answeringQuestionIds, setAnsweringQuestionIds] = useState<string[]>([]);
  const answeringIdsRef = useRef<Set<string>>(new Set());
  const answerQuestionRef = useRef<(questionId: string) => Promise<void>>(async () => undefined);
  const [liveNotice, setLiveNotice] = useState("");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [selectedTranscriptIds, setSelectedTranscriptIds] = useState<string[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [systemEnabled, setSystemEnabled] = useState(false);
  const [appNotice, setAppNotice] = useState<{ tone: "error" | "info"; message: string } | null>(null);
  const [autoAnswerEnabled, setAutoAnswerEnabled] = useState(true);
  const autoAnsweredIdsRef = useRef<Set<string>>(new Set());
  const [showWizard, setShowWizard] = useState(() => localStorage.getItem("interview-copilot-wizard-seen") !== "true");

  const applyBootstrapState = useCallback((state: BootstrapState) => {
    const loadedDocuments = state.documents || [];
    const loadedSession = state.session || blankSession(loadedDocuments);
    setDocuments(loadedDocuments);
    setSession({ ...loadedSession, documents: loadedDocuments });
    setMode(loadedSession.mode || "interview");
    setTranscript(state.transcriptEvents || []);
    setQuestions(state.questionCards || []);
    setAnswerDrafts(state.answerDrafts || []);
    setSelectedQuestionId((current) => {
      const availableQuestions = state.questionCards || [];
      if (current && availableQuestions.some((question) => question.id === current && question.status !== "dismissed")) {
        return current;
      }
      return availableQuestions.find((question) => question.status !== "dismissed")?.id || "";
    });
  }, []);

  const patchSession = useCallback(async (patch: Partial<SessionSetup>) => {
    setSession((current) => ({ ...current, ...patch }));
    const response = await fetch("/api/sessions/current", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return;
    const updated = (await response.json()) as SessionSetup;
    setSession((current) => ({ ...updated, documents: current.documents }));
  }, []);

  const resetLiveAssistState = useCallback(() => {
    autoAnsweredIdsRef.current.clear();
    answeringIdsRef.current.clear();
    setAnsweringQuestionIds([]);
    setIsAnswering(false);
    setSelectedQuestionId("");
    setSelectedTranscriptIds([]);
    setLiveNotice("");
  }, []);

  const startNewSession = useCallback(async (sessionInput?: Partial<SessionSetup>) => {
    const response = await fetch("/api/sessions/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        archive: true,
        session: {
          ...session,
          ...sessionInput,
        },
      }),
    });
    if (!response.ok) {
      setAppNotice({ tone: "error", message: await apiErrorMessage(response, "Could not start a new session.") });
      return false;
    }
    applyBootstrapState(await response.json() as BootstrapState);
    resetLiveAssistState();
    setAppNotice({ tone: "info", message: "New session started. Previous transcript and questions were archived." });
    return true;
  }, [applyBootstrapState, resetLiveAssistState, session]);

  const loadState = useCallback(async () => {
    const state = await fetch("/api/bootstrap")
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error(await apiErrorMessage(response, "Bootstrap failed.")))));
    applyBootstrapState(state as BootstrapState);
  }, [applyBootstrapState]);

  useEffect(() => {
    loadState().catch((error: unknown) => {
      setSession(blankSession());
      setAppNotice({ tone: "error", message: error instanceof Error ? error.message : "Saved state could not be loaded." });
    });
  }, [loadState]);

  const activeQuestions = useMemo(() => questions.filter((question) => question.status !== "dismissed"), [questions]);
  const selectedQuestion =
    activeQuestions.find((question) => question.id === selectedQuestionId) || activeQuestions[0] || null;

  const queueAutoAnswer = useCallback((detectedQuestions: QuestionCard[]) => {
    if (!autoAnswerEnabled) return;
    for (const question of detectedQuestions) {
      if (question.status !== "new" || question.confidence < 0.48) continue;
      if (autoAnsweredIdsRef.current.has(question.id)) continue;
      if (answeringIdsRef.current.has(question.id)) continue;
      autoAnsweredIdsRef.current.add(question.id);
      void answerQuestionRef.current(question.id);
    }
  }, [autoAnswerEnabled]);

  const applyTranscriptPayload = useCallback((payload: TranscriptPayload) => {
    setTranscript((current) => [...current, payload.event]);
    setQuestions((current) => {
      const previousIds = new Set(current.map((question) => question.id));
      const newlyDetected = payload.questions.filter((question) => !previousIds.has(question.id));
      queueAutoAnswer(newlyDetected);
      return payload.questions;
    });
    setSelectedQuestionId((current) =>
      current && payload.questions.some((question) => question.id === current && question.status !== "dismissed")
        ? current
        : payload.questions.find((question) => question.status !== "dismissed")?.id || ""
    );
  }, [queueAutoAnswer]);

  const appendTranscript = useCallback(async (source: TranscriptEvent["source"], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const response = await fetch("/api/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, text: trimmed, isFinal: true })
    });
    if (!response.ok) {
      setLiveNotice(await apiErrorMessage(response, "Transcript could not be saved."));
      return;
    }
    const payload = (await response.json()) as TranscriptPayload;
    applyTranscriptPayload(payload);
    setLiveNotice(source === "mic" ? "Added your transcript line." : "Added interviewer transcript line.");
  }, [applyTranscriptPayload]);

  const answerQuestion = useCallback(async (questionId: string) => {
    if (!questionId || answeringIdsRef.current.has(questionId)) return;

    answeringIdsRef.current.add(questionId);
    setAnsweringQuestionIds((current) => (current.includes(questionId) ? current : [...current, questionId]));
    setIsAnswering(true);
    setLiveNotice("Streaming answer...");
    setSelectedQuestionId(questionId);

    const optimisticId = `answer-${questionId}-pending`;
    setAnswerDrafts((current) => [
      ...current.filter((candidate) => candidate.questionId !== questionId || candidate.format !== session.answerFormat),
      {
        id: optimisticId,
        questionId,
        format: session.answerFormat,
        stages: { bullets: [], structured: "", sources: [], risk: "" },
      },
    ]);

    try {
      const response = await fetch(`/api/questions/${questionId}/answer/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: session.answerFormat, profile: session.voiceProfile })
      });
      if (!response.ok) {
        setLiveNotice(await apiErrorMessage(response, "Start the session setup before generating answers."));
        return;
      }
      if (!response.body) {
        setLiveNotice("Answer stream was unavailable.");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamingAnswerId = optimisticId;

      const applyStreamEvent = (event: AnswerStreamEvent) => {
        if (event.type === "question_update") {
          setQuestions((current) =>
            current.map((item) => item.id === event.question.id ? { ...item, ...event.question } : item),
          );
          return;
        }

        if (event.type === "start") {
          streamingAnswerId = event.answerId;
          const partial: AnswerDraft = {
            id: event.answerId,
            questionId: event.questionId,
            format: event.format,
            stages: { bullets: [], structured: "", sources: [], risk: "" }
          };
          setAnswerDrafts((current) => [
            ...current.filter((candidate) => candidate.questionId !== event.questionId || candidate.format !== event.format),
            partial
          ]);
          return;
        }

        if (event.type === "chunk") {
          setAnswerDrafts((current) => current.map((answer) => {
            if (answer.id !== streamingAnswerId) return answer;
            if (event.stage === "bullets" || event.stage === "sources") {
              return {
                ...answer,
                stages: {
                  ...answer.stages,
                  [event.stage]: [...answer.stages[event.stage], event.value]
                }
              };
            }
            return {
              ...answer,
              stages: {
                ...answer.stages,
                [event.stage]: event.value
              }
            };
          }));
          return;
        }

        setAnswerDrafts((current) => [
          ...current.filter((candidate) => !(candidate.questionId === event.answer.questionId && candidate.format === event.answer.format)),
          event.answer
        ]);
        setQuestions((current) =>
          current.map((question) => question.id === event.answer.questionId ? { ...question, status: "answered" } : question)
        );
        setLiveNotice("Answer ready.");
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const rawEvent of events) {
          const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(6)) as AnswerStreamEvent | ApiErrorPayload;
          if (isApiErrorPayload(event)) {
            setLiveNotice(typeof event.error === "string" ? event.error : event.error?.message || "Answer stream failed.");
            continue;
          }
          applyStreamEvent(event);
        }
      }
    } finally {
      answeringIdsRef.current.delete(questionId);
      setAnsweringQuestionIds((current) => {
        const next = current.filter((id) => id !== questionId);
        setIsAnswering(next.length > 0);
        return next;
      });
    }
  }, [session.answerFormat, session.voiceProfile]);

  useEffect(() => {
    answerQuestionRef.current = answerQuestion;
  }, [answerQuestion]);

  const askSelectedTranscript = useCallback(async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    setIsAnswering(true);
    setLiveNotice("Framing selected transcript...");
    const createResponse = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText: trimmed })
    });
    if (!createResponse.ok) {
      setIsAnswering(false);
      setLiveNotice(await apiErrorMessage(createResponse, "Selected transcript could not be framed as a question."));
      return;
    }
    const question = (await createResponse.json()) as QuestionCard;
    setQuestions((current) => current.some((candidate) => candidate.id === question.id) ? current : [...current, question]);
    setSelectedQuestionId(question.id);
    await answerQuestion(question.id);
    setSelectedTranscriptIds([]);
  }, [answerQuestion]);

  const updateQuestionStatus = useCallback(async (questionId: string, status: QuestionCard["status"]) => {
    const response = await fetch(`/api/questions/${questionId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!response.ok) {
      setLiveNotice(await apiErrorMessage(response, "Question could not be updated."));
      return;
    }

    const updated = (await response.json()) as QuestionCard;
    setQuestions((current) => current.map((question) => question.id === updated.id ? updated : question));
    if (status === "dismissed") {
      setSelectedQuestionId((current) => {
        if (current !== questionId) return current;
        return activeQuestions.find((question) => question.id !== questionId)?.id || "";
      });
      setLiveNotice("Question dismissed.");
      return;
    }
    setSelectedQuestionId(updated.id);
    setLiveNotice(status === "saved" ? "Question saved for later." : "Question moved back to the live queue.");
  }, [activeQuestions]);

  const updateAnswerMetadata = useCallback(async (
    answerId: string,
    metadata: Pick<AnswerDraft, "pinned" | "copiedAt">
  ) => {
    setAnswerDrafts((current) => current.map((answer) => answer.id === answerId ? { ...answer, ...metadata } : answer));
    const response = await fetch(`/api/answers/${answerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata)
    });
    if (!response.ok) {
      setLiveNotice(await apiErrorMessage(response, "Answer note could not be saved."));
      return;
    }
    const updated = (await response.json()) as AnswerDraft;
    setAnswerDrafts((current) => current.map((answer) => answer.id === updated.id ? updated : answer));
  }, []);

  const addPastedDocument = useCallback(async () => {
    const name = window.prompt("Document name");
    if (!name) return;
    const text = window.prompt("Paste document text") || "";
    const response = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text, category: "project-notes" })
    });
    if (!response.ok) {
      setAppNotice({ tone: "error", message: await apiErrorMessage(response, "Document text could not be added.") });
      return;
    }
    const document = (await response.json()) as DocumentSummary;
    setDocuments((current) => [...current.filter((item) => item.id !== document.id), document]);
    setSession((current) => ({
      ...current,
      documents: [...current.documents.filter((item) => item.id !== document.id), document],
    }));
    setAppNotice({
      tone: document.status === "failed" ? "error" : "info",
      message: document.status === "indexed"
        ? `${document.name} is searchable.`
        : document.status === "processing"
          ? `${document.name} is indexing...`
          : `${document.name} could not be indexed.`,
    });
  }, []);

  const deleteDocument = useCallback(async (documentId: string) => {
    const response = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
    if (!response.ok) {
      setAppNotice({ tone: "error", message: await apiErrorMessage(response, "Document could not be deleted.") });
      return;
    }
    const payload = (await response.json()) as { deleted: DocumentSummary };
    setDocuments((current) => current.filter((document) => document.id !== payload.deleted.id));
    setSession((current) => ({
      ...current,
      documents: current.documents.filter((document) => document.id !== payload.deleted.id),
    }));
    setAppNotice({ tone: "info", message: `${payload.deleted.name} removed.` });
  }, []);

  const uploadDocument = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const category = /resume|cv/i.test(file.name)
      ? "resume"
      : /job|jd|description|posting/i.test(file.name)
        ? "job-description"
        : "project-notes";
    formData.append("category", category);
    const response = await fetch("/api/documents/upload", {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      setAppNotice({ tone: "error", message: await apiErrorMessage(response, "Upload TXT, Markdown, DOCX, or PDF files up to 15 MB.") });
      return;
    }
    const document = (await response.json()) as DocumentSummary;
    setDocuments((current) => [...current.filter((item) => item.id !== document.id), document]);
    setSession((current) => ({
      ...current,
      documents: [...current.documents.filter((item) => item.id !== document.id), document],
    }));
    if (document.status === "failed") {
      setAppNotice({ tone: "error", message: `${document.name} uploaded but indexing failed. Try uploading again.` });
      return;
    }
    setAppNotice({
      tone: "info",
      message: document.status === "processing"
        ? `${document.name} uploaded. Semantic indexing in progress...`
        : `${document.name} uploaded and searchable.`,
    });
  }, []);

  const openOverlay = () => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("overlay");
      return;
    }
    window.open("?view=overlay", "second-chair-overlay", "width=460,height=720,noopener,noreferrer");
  };

  const openAnswerWindow = () => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("answer");
      return;
    }
    window.open("?view=answer", "second-chair-answer", "width=720,height=820,noopener,noreferrer");
  };

  const hideOverlays = () => {
    void window.interviewCopilot?.windows?.hideOverlays?.();
  };

  return (
    <main className="app-frame">
      <header className="product-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <MonitorDot size={22} strokeWidth={2.4} />
          </div>
          <div>
            <span className="eyebrow">Standalone</span>
            <h1>Second Chair</h1>
          </div>
        </div>

        <div className="session-status">
          <span className="live-pill">
            <Radio size={14} />
            {isLive ? "Live capture" : "Paused"}
          </span>
          <button
            className="icon-button"
            type="button"
            title="Open overlay"
            aria-label="Open overlay"
            onClick={openOverlay}
          >
            <MonitorDot size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Open answer overlay"
            aria-label="Open answer overlay"
            onClick={openAnswerWindow}
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Hide overlays"
            aria-label="Hide overlays"
            onClick={hideOverlays}
          >
            <EyeOff size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={isLive ? "Pause live capture" : "Resume live capture"}
            aria-pressed={isLive}
            onClick={() => setIsLive((value) => !value)}
          >
            {isLive ? <Pause size={16} /> : <Play size={16} />}
          </button>
        </div>
      </header>

      <section className="session-banner session-banner-compact" aria-label="Current session">
        <div className="session-banner-main">
          <span className="session-pill accent">{roundLabel(session.round)}</span>
          {(session.role || session.company) ? (
            <span className="session-pill primary">
              {[session.role, session.company && `@ ${session.company}`].filter(Boolean).join(" ")}
            </span>
          ) : (
            <span className="session-pill muted">Set role in Session Setup</span>
          )}
          <span className="session-pill muted">{voiceProfileLabel(session.voiceProfile, session.customVoice)}</span>
        </div>
        <div className="session-banner-meta">
          <span className="session-stat">{questions.length} Q</span>
          <span className="session-stat">
            {documents.filter((document) => document.status === "indexed").length}/{documents.length} docs
          </span>
          <button
            className="ghost-action compact session-new-button"
            type="button"
            onClick={() => void startNewSession()}
            title="Archive current live data and start a fresh session"
          >
            <RotateCcw size={14} />
            New
          </button>
        </div>
      </section>

      <nav className="workflow-tabs" aria-label="Product workflow" role="tablist">
        {pageTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              className={`workflow-tab ${activePage === tab.id ? "active" : ""}`}
              key={tab.id}
              type="button"
              aria-controls={`page-${tab.id}`}
              aria-current={activePage === tab.id ? "page" : undefined}
              aria-selected={activePage === tab.id}
              role="tab"
              onClick={() => setActivePage(tab.id)}
            >
              <Icon size={18} />
              <span>{tab.label}</span>
              <small>{tab.description}</small>
            </button>
          );
        })}
      </nav>

      {appNotice && (
        <Notice
          message={appNotice.message}
          tone={appNotice.tone}
          onDismiss={() => setAppNotice(null)}
        />
      )}

      {activePage === "live" && (
        <LiveAssistPage
          activeQuestions={activeQuestions}
          answerDrafts={answerDrafts}
          autoAnswerEnabled={autoAnswerEnabled}
          session={session}
          onSessionPatch={patchSession}
          selectedQuestion={selectedQuestion}
          transcript={transcript}
          setAutoAnswerEnabled={setAutoAnswerEnabled}
          setSelectedQuestionId={setSelectedQuestionId}
          micEnabled={micEnabled}
          setMicEnabled={setMicEnabled}
          systemEnabled={systemEnabled}
          setSystemEnabled={setSystemEnabled}
          isAnswering={isAnswering}
          answeringQuestionIds={answeringQuestionIds}
          liveNotice={liveNotice}
          onAnswerQuestion={answerQuestion}
          onAppendTranscript={appendTranscript}
          onAudioTranscript={applyTranscriptPayload}
          onUpdateAnswerMetadata={updateAnswerMetadata}
          onUpdateQuestionStatus={updateQuestionStatus}
        />
      )}

      {activePage === "setup" && (
        <SetupPage
          documents={documents}
          onAddPastedDocument={addPastedDocument}
          onSessionChange={setSession}
          onNotice={setAppNotice}
          onStart={() => setActivePage("live")}
          onStartNewSession={startNewSession}
          onDeleteDocument={deleteDocument}
          onUploadDocument={uploadDocument}
          session={session}
        />
      )}
      {activePage === "knowledge" && (
        <KnowledgePage
          documents={documents}
          onAddPastedDocument={addPastedDocument}
          onDeleteDocument={deleteDocument}
          onUploadDocument={uploadDocument}
        />
      )}
      {activePage === "prompts" && (
        <PromptStudioPage
          session={session}
          onSessionPatch={patchSession}
        />
      )}
      {activePage === "settings" && <SettingsPage />}
      {activePage === "review" && <ReviewPage questions={questions} />}
      {showWizard && <OnboardingWizard onClose={() => {
        localStorage.setItem("interview-copilot-wizard-seen", "true");
        setShowWizard(false);
      }} />}
    </main>
  );
}

function getInitialPage(): AppPage {
  const page = new URLSearchParams(window.location.search).get("page");
  return pageTabs.some((tab) => tab.id === page) ? (page as AppPage) : "setup";
}

function LiveAssistPage({
  activeQuestions,
  answerDrafts,
  autoAnswerEnabled,
  answeringQuestionIds,
  isAnswering,
  liveNotice,
  micEnabled,
  onAnswerQuestion,
  onAppendTranscript,
  onAudioTranscript,
  onUpdateAnswerMetadata,
  onUpdateQuestionStatus,
  onSessionPatch,
  session,
  selectedQuestion,
  setAutoAnswerEnabled,
  setMicEnabled,
  setSelectedQuestionId,
  setSystemEnabled,
  systemEnabled,
  transcript
}: {
  activeQuestions: QuestionCard[];
  answerDrafts: AnswerDraft[];
  autoAnswerEnabled: boolean;
  answeringQuestionIds: string[];
  isAnswering: boolean;
  liveNotice: string;
  micEnabled: boolean;
  onAnswerQuestion: (questionId: string) => Promise<void>;
  onAppendTranscript: (source: TranscriptEvent["source"], text: string) => Promise<void>;
  onAudioTranscript: (payload: TranscriptPayload) => void;
  onUpdateAnswerMetadata: (answerId: string, metadata: Pick<AnswerDraft, "pinned" | "copiedAt">) => Promise<void>;
  onUpdateQuestionStatus: (questionId: string, status: QuestionCard["status"]) => Promise<void>;
  onSessionPatch: (patch: Partial<SessionSetup>) => Promise<void>;
  session: SessionSetup;
  selectedQuestion: QuestionCard | null;
  setAutoAnswerEnabled: (value: boolean) => void;
  setMicEnabled: (value: boolean) => void;
  setSelectedQuestionId: (value: string) => void;
  setSystemEnabled: (value: boolean) => void;
  systemEnabled: boolean;
  transcript: TranscriptEvent[];
}) {
  const [manualSource, setManualSource] = useState<TranscriptEvent["source"]>("system");
  const [manualText, setManualText] = useState("");
  const [captureNotice, setCaptureNotice] = useState("");
  const [showTranscriptRail, setShowTranscriptRail] = useState(true);
  const recorderRefs = useRef<Partial<Record<"mic" | "system", {
    recorder: MediaRecorder;
    stream: MediaStream;
    captureStream: MediaStream;
    segmentTimer: ReturnType<typeof setInterval> | null;
  }>>>({});
  const backendSttUnavailableRef = useRef(false);
  const { streamingAvailable, interimBySource } = useRealtimeAudioCapture({
    micEnabled,
    systemEnabled,
    onTranscriptUpdate: onAudioTranscript,
    onStatus: setCaptureNotice,
  });
  const coachQuestions = useMemo(
    () => [...activeQuestions].sort((left, right) => right.createdAt - left.createdAt),
    [activeQuestions],
  );
  const resolveAnswer = useCallback((questionId: string) => (
    answerDrafts.find((answer) => answer.questionId === questionId && answer.format === session.answerFormat)
      || answerDrafts.find((answer) => answer.questionId === questionId)
      || null
  ), [answerDrafts, session.answerFormat]);
  const latestTranscript = useMemo(() => transcript.slice(-12).reverse(), [transcript]);
  const submitManualTranscript = async () => {
    const text = manualText.trim();
    if (!text) return;
    await onAppendTranscript(manualSource, text);
    setManualText("");
  };
  const copyCoachAnswer = async (answer: AnswerDraft) => {
    await navigator.clipboard?.writeText(answer.stages.structured);
    void onUpdateAnswerMetadata(answer.id, { copiedAt: Date.now() });
  };
  const stopRecorder = useCallback((source: "mic" | "system") => {
    const current = recorderRefs.current[source];
    if (!current) return;
    if (current.segmentTimer) clearInterval(current.segmentTimer);
    delete recorderRefs.current[source];
    if (current.recorder.state !== "inactive") current.recorder.stop();
    current.stream.getTracks().forEach((track) => track.stop());
    current.captureStream.getTracks().forEach((track) => track.stop());
  }, []);
  const uploadAudioChunk = useCallback(async (source: "mic" | "system", blob: Blob) => {
    if (blob.size < 256 || backendSttUnavailableRef.current) return;
    const formData = new FormData();
    const extension = blob.type.includes("wav") ? "wav" : "webm";
    formData.append("file", blob, `${source}-${Date.now()}.${extension}`);
    const response = await fetch(`/api/audio/transcriptions?source=${source}`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const message = await apiErrorMessage(response, "Audio transcription is unavailable.");
      if (response.status === 503) {
        backendSttUnavailableRef.current = true;
        stopRecorder(source);
      }
      setCaptureNotice(message);
      return;
    }
    const payload = (await response.json()) as TranscriptPayload;
    if (payload.event.text.trim()) onAudioTranscript(payload);
    setCaptureNotice(source === "mic" ? "Mic audio transcribed." : "System audio transcribed.");
  }, [onAudioTranscript, stopRecorder]);
  const startBackendRecorder = useCallback(async (source: "mic" | "system") => {
    if (backendSttUnavailableRef.current) return false;
    if (recorderRefs.current[source]) return true;
    if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
      setCaptureNotice("Browser audio capture is unavailable here. Use manual transcript input.");
      return false;
    }

    try {
      const captureStream = source === "mic"
        ? await navigator.mediaDevices.getUserMedia({
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false
            }
          })
        : await navigator.mediaDevices.getDisplayMedia({
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false
            },
            video: true,
            systemAudio: "include"
          } as DisplayMediaStreamOptions);
      const audioTracks = captureStream.getAudioTracks();
      if (!audioTracks.length) {
        captureStream.getTracks().forEach((track) => track.stop());
        setCaptureNotice(source === "system" ? "No system audio track was shared." : "No microphone audio track was available.");
        return false;
      }
      captureStream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });
      const stream = new MediaStream(audioTracks);
      const webmMimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, webmMimeType ? { mimeType: webmMimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size >= 256) void uploadAudioChunk(source, event.data);
      };
      recorder.onstop = () => {
        if (recorderRefs.current[source]) {
          if (recorder.state === "inactive") recorder.start();
          return;
        }
        stream.getTracks().forEach((track) => track.stop());
      };
      audioTracks.forEach((track) => {
        track.addEventListener("ended", () => {
          stopRecorder(source);
          if (source === "mic") setMicEnabled(false);
          if (source === "system") setSystemEnabled(false);
          setCaptureNotice(source === "mic" ? "Mic capture ended." : "System audio capture ended.");
        });
      });
      const segmentTimer = setInterval(() => {
        if (recorderRefs.current[source]?.recorder.state === "recording") {
          recorderRefs.current[source]?.recorder.stop();
        }
      }, 5000);
      recorderRefs.current[source] = { recorder, stream, captureStream, segmentTimer };
      recorder.start();
      setCaptureNotice(source === "mic" ? "Mic audio upload is active." : "System audio upload is active.");
      return true;
    } catch (error) {
      setCaptureNotice(error instanceof Error ? error.message : "Audio capture could not start.");
      return false;
    }
  }, [stopRecorder, uploadAudioChunk]);

  const toggleMicCapture = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      stopRecorder("mic");
      setMicEnabled(false);
      setCaptureNotice("");
      return;
    }
    if (streamingAvailable) {
      setMicEnabled(true);
      return;
    }
    const started = await startBackendRecorder("mic");
    setMicEnabled(started);
  }, [startBackendRecorder, stopRecorder, setMicEnabled, streamingAvailable]);

  const toggleSystemCapture = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      stopRecorder("system");
      setSystemEnabled(false);
      setCaptureNotice("");
      return;
    }
    if (streamingAvailable) {
      setSystemEnabled(true);
      return;
    }
    const started = await startBackendRecorder("system");
    setSystemEnabled(started);
  }, [startBackendRecorder, stopRecorder, setSystemEnabled, streamingAvailable]);

  useEffect(() => {
    if (streamingAvailable || !micEnabled) {
      if (!streamingAvailable) stopRecorder("mic");
      return;
    }

    void startBackendRecorder("mic").then((started) => {
      if (!started) setMicEnabled(false);
    });

    return () => {
      stopRecorder("mic");
    };
  }, [micEnabled, startBackendRecorder, stopRecorder, setMicEnabled, streamingAvailable]);

  useEffect(() => {
    if (streamingAvailable || !systemEnabled) {
      if (!streamingAvailable) stopRecorder("system");
      return;
    }

    void startBackendRecorder("system").then((started) => {
      if (!started) setSystemEnabled(false);
    });

    return () => {
      stopRecorder("system");
    };
  }, [startBackendRecorder, stopRecorder, setSystemEnabled, streamingAvailable, systemEnabled]);

  return (
    <section className="page-shell live-page live-coach-page" id="page-live" role="tabpanel" aria-label="Live assist">
      <div className="page-heading live-coach-heading">
        <div>
          <span className="eyebrow">Interview Coach</span>
          <h2>Live Assist</h2>
          <p className="live-coach-subtitle">Questions are detected from the conversation and answered automatically below.</p>
        </div>
        <div className="live-top-controls live-coach-controls">
          <AudioToggle enabled={autoAnswerEnabled} icon={<Sparkles size={17} />} label="Auto" onChange={setAutoAnswerEnabled} />
          <AudioToggle enabled={systemEnabled} icon={<MonitorDot size={17} />} label="Interviewer" onChange={toggleSystemCapture} />
          <AudioToggle enabled={micEnabled} icon={<Mic2 size={17} />} label="You" onChange={toggleMicCapture} />
          <button className="ghost-action compact" type="button" onClick={() => setShowTranscriptRail((value) => !value)}>
            <AudioWaveform size={16} />
            {showTranscriptRail ? "Hide transcript" : "Show transcript"}
          </button>
        </div>
      </div>

      <div className="live-coach-toolbar">
        <ChipGroup
          label="Answer style"
          value={session.answerFormat}
          options={formatOptions}
          onChange={(answerFormat) => void onSessionPatch({ answerFormat })}
        />
        <VoiceSelector
          voiceProfile={session.voiceProfile}
          customVoice={session.customVoice}
          onChange={(patch) => void onSessionPatch(patch)}
        />
        <span className="live-coach-status">
          {micEnabled || systemEnabled ? (streamingAvailable ? "Streaming live" : "Listening") : "Enable Interviewer audio to start"}
          {isAnswering ? " · Generating answer..." : autoAnswerEnabled ? " · Auto mode on" : " · Manual mode"}
        </span>
      </div>

      <div className={`live-coach-layout${showTranscriptRail ? "" : " transcript-hidden"}`}>
        <section className="coach-feed" aria-label="Detected questions and answers">
          {!coachQuestions.length && (
            <EmptyState
              title="Waiting for the first question"
              detail="Turn on Interviewer audio. When the interviewer asks something, the question and a speakable answer script will appear here."
            />
          )}
          {coachQuestions.map((question) => {
            const answer = resolveAnswer(question.id);
            const isActive = question.id === selectedQuestion?.id;
            const isGenerating = answeringQuestionIds.includes(question.id);
            return (
              <article className={`coach-card${isActive ? " active" : ""}${isGenerating ? " generating" : ""}`} key={question.id}>
                <header className="coach-card-header">
                  <div>
                    <span className="coach-badge">Question detected</span>
                    <strong>{question.framedQuestion || question.rawText}</strong>
                    <p>{question.evaluationIntent}</p>
                  </div>
                  <div className="coach-card-actions">
                    <span className="status-dot new">{question.type}</span>
                    <button className="ghost-action compact" type="button" onClick={() => void onAnswerQuestion(question.id)} disabled={isGenerating}>
                      <Sparkles size={15} />
                      Regenerate
                    </button>
                    <button className="ghost-action compact" type="button" onClick={() => void onUpdateQuestionStatus(question.id, "dismissed")}>
                      <X size={15} />
                    </button>
                  </div>
                </header>
                <div className="coach-script-block">
                  <div className="coach-script-label">
                    <WandSparkles size={16} />
                    <span>Say this</span>
                    {answer && (
                      <button className="ghost-action compact" type="button" onClick={() => void copyCoachAnswer(answer)}>
                        <Copy size={15} />
                        Copy script
                      </button>
                    )}
                  </div>
                  <p className="coach-script">
                    {answer?.stages.structured || (isGenerating ? "Drafting your speakable answer..." : "Answer will appear here automatically.")}
                  </p>
                  {Boolean(answer?.stages.bullets.length) && (
                    <div className="coach-joggers">
                      {answer?.stages.bullets.map((bullet) => (
                        <span className="coach-jogger" key={bullet}>{bullet}</span>
                      ))}
                    </div>
                  )}
                  {answer?.stages.risk && <p className="coach-risk">{answer.stages.risk}</p>}
                </div>
              </article>
            );
          })}
        </section>

        {showTranscriptRail && (
          <aside className="live-transcript-rail" aria-label="Live transcript">
            <PanelHeader eyebrow="Live feed" icon={<AudioWaveform size={18} />} title="Transcript" action={String(transcript.length)} />
            <div className="live-transcript-rail-list">
              {latestTranscript.map((event) => (
                <article className={`transcript-rail-item ${event.source}`} key={event.id}>
                  <strong>{event.source === "mic" ? "You" : "Interviewer"}</strong>
                  <p>{event.text}</p>
                </article>
              ))}
              {Object.entries(interimBySource).map(([source, text]) => (
                text ? (
                  <article className={`transcript-rail-item interim ${source}`} key={`interim-${source}`}>
                    <strong>{source === "mic" ? "You" : "Interviewer"}</strong>
                    <p>{text}</p>
                  </article>
                ) : null
              ))}
              {!latestTranscript.length && !interimBySource.system && !interimBySource.mic && (
                <EmptyState title="No transcript yet" detail="Enable Interviewer audio to capture the conversation." />
              )}
            </div>
            <div className="live-transcript-rail-manual">
              <input
                aria-label="Add transcript line"
                placeholder="Add a line manually..."
                value={manualText}
                onChange={(event) => setManualText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitManualTranscript();
                }}
              />
              <button className="primary-action compact" type="button" onClick={() => void submitManualTranscript()}>Add</button>
            </div>
          </aside>
        )}
      </div>

      {(liveNotice || captureNotice) && (
        <p className="live-notice live-coach-notice" role="status">{liveNotice || captureNotice}</p>
      )}
    </section>
  );
}

function documentStatusLabel(status: DocumentSummary["status"]): string {
  if (status === "indexed") return "searchable";
  if (status === "processing") return "indexing";
  return status;
}

function SetupPage({
  documents,
  onAddPastedDocument,
  onDeleteDocument,
  onNotice,
  onSessionChange,
  onStart,
  onStartNewSession,
  onUploadDocument,
  session
}: {
  documents: DocumentSummary[];
  onAddPastedDocument: () => Promise<void>;
  onDeleteDocument: (documentId: string) => Promise<void>;
  onNotice: (notice: { tone: "error" | "info"; message: string } | null) => void;
  onSessionChange: (session: SessionSetup) => void;
  onStart: () => void;
  onStartNewSession: (sessionInput?: Partial<SessionSetup>) => Promise<boolean>;
  onUploadDocument: (file: File) => Promise<void>;
  session: SessionSetup;
}) {
  const saveAndStart = async () => {
    const started = await onStartNewSession(session);
    if (started) {
      onStart();
    }
  };

  const updateSession = (patch: Partial<SessionSetup>) => {
    onSessionChange({ ...session, ...patch });
  };

  return (
    <section className="page-shell" id="page-setup" role="tabpanel" aria-label="Session setup">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Session Setup</span>
          <h2>Session Setup</h2>
        </div>
        <button className="primary-action" type="button" onClick={saveAndStart}>
          <Play size={17} />
          Start session
        </button>
      </div>

      <div className="setup-grid">
        <section className="setup-card wide-card">
          <PanelHeader eyebrow="Step 1" icon={<BriefcaseBusiness size={18} />} title="Role and company" />
          <div className="field-grid">
            <Field
              label="Target role"
              value={session.role}
              onChange={(role) => updateSession({
                role,
                title: buildSessionTitle(role, session.company),
              })}
            />
            <Field
              label="Company"
              value={session.company}
              onChange={(company) => updateSession({
                company,
                title: buildSessionTitle(session.role, company),
              })}
            />
            <SelectField
              label="Round"
              value={session.round}
              options={roundOptions}
              onChange={(round) => updateSession({ round })}
            />
            <Field label="Seniority" value={session.seniority} onChange={(seniority) => updateSession({ seniority })} />
          </div>
        </section>
        <section className="setup-card wide-card">
          <PanelHeader eyebrow="Documents" icon={<Upload size={18} />} title="Upload interview context" />
          <div className="setup-document-grid">
            {documents.map((document) => (
              <article className="setup-document" key={document.id}>
                <FileText size={18} />
                <div>
                  <strong>{document.name}</strong>
                  <span>{document.category.replace("-", " ")} · {document.wordCount.toLocaleString()} words</span>
                </div>
                <span className={`doc-status ${document.status}`}>
                  {document.status === "indexed" && <Check size={13} />}
                  {documentStatusLabel(document.status)}
                </span>
                <button
                  className="ghost-action compact"
                  type="button"
                  aria-label={`Delete ${document.name}`}
                  onClick={() => void onDeleteDocument(document.id)}
                >
                  <Trash2 size={15} />
                </button>
              </article>
            ))}
            <DocumentImportTile onAddPastedDocument={onAddPastedDocument} onUploadDocument={onUploadDocument} />
          </div>
        </section>
        <section className="setup-card">
          <PanelHeader eyebrow="Voice & style" icon={<UserRoundCheck size={18} />} title="How answers should sound" />
          <div className="preference-list">
            {responseStyleOptions.map((option) => (
              <Preference
                key={option.value}
                title={option.title}
                detail={option.detail}
                active={session.responseStyle === option.value}
                onClick={() => updateSession({ responseStyle: option.value })}
              />
            ))}
          </div>
          <div className="setup-style-controls">
            <ChipGroup
              label="Answer style"
              value={session.answerFormat}
              options={formatOptions}
              onChange={(answerFormat) => updateSession({ answerFormat })}
            />
            <VoiceSelector
              voiceProfile={session.voiceProfile}
              customVoice={session.customVoice}
              onChange={(patch) => updateSession(patch)}
            />
          </div>
        </section>
        <section className="setup-card">
          <PanelHeader eyebrow="Capture" icon={<Mic2 size={18} />} title="Audio readiness" />
          <div className="capture-list">
            <Fact label="Mic" value="Clean" />
            <Fact label="System" value="Ready" />
            <Fact label="Language" value={session.language} />
          </div>
        </section>
      </div>
    </section>
  );
}

function KnowledgePage({
  documents,
  onAddPastedDocument,
  onDeleteDocument,
  onUploadDocument
}: {
  documents: DocumentSummary[];
  onAddPastedDocument: () => Promise<void>;
  onDeleteDocument: (documentId: string) => Promise<void>;
  onUploadDocument: (file: File) => Promise<void>;
}) {
  return (
    <section className="page-shell" id="page-knowledge" role="tabpanel" aria-label="Knowledge">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Knowledge</span>
          <h2>Knowledge</h2>
        </div>
        <div className="inline-actions">
          <button className="ghost-action" type="button" onClick={() => void onAddPastedDocument()}>
            <FileText size={17} />
            Paste text
          </button>
          <DocumentUploadButton onUploadDocument={onUploadDocument} />
        </div>
      </div>

      <div className="document-grid">
        {documents.length ? documents.map((document) => (
          <article className="document-card" key={document.id}>
            <div className="document-icon">
              <FileText size={22} />
            </div>
            <div>
              <strong>{document.name}</strong>
              <span>{document.category.replace("-", " ")}</span>
            </div>
            <span className={`doc-status ${document.status}`}>
              {document.status === "indexed" && <Check size={13} />}
              {documentStatusLabel(document.status)}
            </span>
            <p>
              {document.status === "indexed"
                ? `${document.wordCount.toLocaleString()} words indexed for semantic retrieval.`
                : document.status === "processing"
                  ? "Semantic indexing in progress..."
                  : document.status === "failed"
                    ? "Indexing failed. Delete and upload again."
                    : `${document.wordCount.toLocaleString()} words uploaded.`}
            </p>
            <button
              className="ghost-action compact"
              type="button"
              aria-label={`Delete ${document.name}`}
              onClick={() => void onDeleteDocument(document.id)}
            >
              <Trash2 size={15} />
              Delete
            </button>
          </article>
        )) : <EmptyState title="No documents yet" detail="Upload a resume, job description, or notes from Session Setup." />}
      </div>
    </section>
  );
}

function DocumentImportTile({
  onAddPastedDocument,
  onUploadDocument
}: {
  onAddPastedDocument: () => Promise<void>;
  onUploadDocument: (file: File) => Promise<void>;
}) {
  return (
    <div className="upload-tile split-upload">
      <Upload size={18} />
      <div>
        <strong>Add resume, JD, or notes</strong>
        <span>TXT, Markdown, DOCX, PDF, or pasted text</span>
      </div>
      <div className="upload-actions">
        <DocumentUploadButton onUploadDocument={onUploadDocument} compact />
        <button className="ghost-action compact" type="button" onClick={() => void onAddPastedDocument()}>
          Paste
        </button>
      </div>
    </div>
  );
}

function DocumentUploadButton({
  compact = false,
  onUploadDocument
}: {
  compact?: boolean;
  onUploadDocument: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={`primary-action ${compact ? "compact" : ""}`} type="button" onClick={() => inputRef.current?.click()}>
        <Upload size={17} />
        Upload
      </button>
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        aria-label="Upload interview context document"
        accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void onUploadDocument(file);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

function PromptStudioPage({
  session,
  onSessionPatch,
}: {
  session: SessionSetup;
  onSessionPatch: (patch: Partial<SessionSetup>) => Promise<void>;
}) {
  const [prompts, setPrompts] = useState<PromptSetting[]>([]);
  const [activePromptId, setActivePromptId] = useState<PromptSetting["id"]>("answer-generator");
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const activePrompt = prompts.find((prompt) => prompt.id === activePromptId) || prompts[0];

  useEffect(() => {
    fetch("/api/prompts")
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error(await apiErrorMessage(response, "Prompt settings are unavailable.")))))
      .then((items: PromptSetting[]) => {
        setPrompts(items);
        setActivePromptId(items[0]?.id || "answer-generator");
        setDraft(items[0]?.body || "");
      })
      .catch((error: unknown) => setSaveStatus(error instanceof Error ? error.message : "Prompt settings are unavailable."));
  }, []);

  const selectPrompt = (prompt: PromptSetting) => {
    setActivePromptId(prompt.id);
    setDraft(prompt.body);
    setSaveStatus("");
  };
  const savePrompt = async () => {
    if (!activePrompt) return;
    setSaveStatus("Saving...");
    const response = await fetch(`/api/prompts/${activePrompt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: draft })
    });
    if (!response.ok) {
      setSaveStatus(await apiErrorMessage(response, "Prompt could not be saved."));
      return;
    }
    const updated = (await response.json()) as PromptSetting;
    setPrompts((current) => current.map((prompt) => prompt.id === updated.id ? updated : prompt));
    setSaveStatus("Saved.");
  };

  return (
    <section className="page-shell prompt-page" id="page-prompts" role="tabpanel" aria-label="Prompt studio">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Prompt Studio</span>
          <h2>Prompt Studio</h2>
        </div>
        <button className="primary-action" type="button" onClick={savePrompt} disabled={!activePrompt}>
          <Check size={17} />
          Save prompt
        </button>
      </div>

      <div className="prompt-grid">
        <section className="prompt-library">
          <PanelHeader eyebrow="Profiles" icon={<Settings2 size={18} />} title="Answer personalities" />
          {promptProfiles.map((option) => (
            <button
              className={`profile-card ${session.voiceProfile === option.value ? "active" : ""}`}
              key={option.value}
              type="button"
              onClick={() => void onSessionPatch({ voiceProfile: option.value })}
            >
              <strong>{option.label}</strong>
              <span>{option.note}</span>
            </button>
          ))}
          {session.voiceProfile === "custom" && (
            <input
              className="voice-custom-input"
              placeholder="Describe your voice, e.g. warm senior IC, data-driven PM..."
              value={session.customVoice}
              onChange={(event) => void onSessionPatch({ customVoice: event.target.value })}
            />
          )}
        </section>
        <section className="prompt-editor">
          <PanelHeader eyebrow="System prompt" icon={<SlidersHorizontal size={18} />} title={activePrompt?.title || "Prompt editor"} />
          <div className="prompt-switcher" aria-label="Prompt template">
            {prompts.map((prompt) => (
              <button
                className={activePromptId === prompt.id ? "active" : ""}
                key={prompt.id}
                type="button"
                onClick={() => selectPrompt(prompt)}
              >
                {prompt.title}
              </button>
            ))}
          </div>
          <textarea
            className="prompt-textarea"
            aria-label="System prompt"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="variable-row">
            {(activePrompt?.variables || []).map((variable) => (
              <span key={variable}>{variable}</span>
            ))}
          </div>
          {saveStatus && <p className="live-notice" role="status">{saveStatus}</p>}
        </section>
      </div>
    </section>
  );
}

function ReviewPage({ questions }: { questions: QuestionCard[] }) {
  const [report, setReport] = useState<SessionReport | null>(null);
  const [archives, setArchives] = useState<SessionArchiveSummary[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [reportNotice, setReportNotice] = useState("");
  const loadArchives = async () => {
    const response = await fetch("/api/sessions/history");
    if (response.ok) setArchives(await response.json());
  };
  useEffect(() => {
    void loadArchives();
  }, []);
  const generateReport = async () => {
    setIsGenerating(true);
    setReportNotice("");
    const response = await fetch("/api/reports", { method: "POST" });
    setIsGenerating(false);
    if (response.ok) {
      setReport(await response.json());
      setReportNotice("Report generated.");
      return;
    }
    setReportNotice(await apiErrorMessage(response, "Report could not be generated."));
  };
  const archiveCurrentSession = async () => {
    const response = await fetch("/api/sessions/archive", { method: "POST" });
    if (!response.ok) {
      setReportNotice(await apiErrorMessage(response, "Session could not be archived."));
      return;
    }
    const archive = (await response.json()) as SessionArchiveSummary;
    setArchives((current) => [archive, ...current.filter((item) => item.id !== archive.id)]);
    setReportNotice("Session archived.");
  };
  const exportSession = (id = "current", format: "json" | "markdown" = "markdown") => {
    window.open(`/api/sessions/${id}/export?format=${format}`, "_blank", "noopener,noreferrer");
  };

  return (
    <section className="page-shell" id="page-review" role="tabpanel" aria-label="Review">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Review</span>
          <h2>Review</h2>
        </div>
        <div className="inline-actions">
          <button className="ghost-action" type="button" onClick={() => exportSession()}>
            <Copy size={17} />
            Export
          </button>
          <button className="ghost-action" type="button" onClick={archiveCurrentSession}>
            <History size={17} />
            Archive
          </button>
          <button className="primary-action" type="button" onClick={generateReport} disabled={isGenerating}>
            <ListChecks size={17} />
            {isGenerating ? "Generating" : "Generate report"}
          </button>
        </div>
      </div>
      {reportNotice && <p className="live-notice" role="status">{reportNotice}</p>}

      <div className="review-grid">
        <section className="review-card">
          <PanelHeader eyebrow="Timeline" icon={<History size={18} />} title="Question history" />
          {questions.length ? questions.map((question) => (
            <div className="timeline-item" key={question.id}>
              <span className={`status-dot ${question.status}`} />
              <div>
                <strong>{question.rawText}</strong>
                <p>{question.type} - {Math.round(question.confidence * 100)}% confidence</p>
              </div>
            </div>
          )) : <EmptyState title="No session history yet" detail="Detected questions and answers will appear after a live session." />}
        </section>
        <section className="review-card">
          <PanelHeader eyebrow="Practice queue" icon={<LayoutDashboard size={18} />} title="Next prep focus" />
          {report ? (
            <div className="practice-stack">
              <Preference title="Session summary" detail={report.summary} active />
              {report.focus.map((item) => (
                <Preference title="Prep focus" detail={item} key={item} />
              ))}
            </div>
          ) : (
            <div className="practice-stack">
              <Preference title="Generate a session report" detail="Create a practice queue from answered and unresolved questions." active />
              <Preference title="Evidence check" detail="Answered items will show whether the response used document context." />
              <Preference title="Follow-up prep" detail="Unanswered questions become the next practice list." />
            </div>
          )}
        </section>
        <section className="review-card wide-card">
          <PanelHeader eyebrow="Session history" icon={<History size={18} />} title="Archived sessions" />
          {archives.length ? (
            <div className="history-stack">
              {archives.map((archive) => (
                <article className="archive-card" key={archive.id}>
                  <div>
                    <strong>{archive.title}</strong>
                    <span>{archive.role || "Role not set"} {archive.company ? `at ${archive.company}` : ""}</span>
                  </div>
                  <div className="archive-metrics">
                    <Fact label="Questions" value={String(archive.questionCount)} />
                    <Fact label="Answers" value={String(archive.answerCount)} />
                    <Fact label="Docs" value={String(archive.documentCount)} />
                  </div>
                  <button className="ghost-action" type="button" onClick={() => exportSession(archive.id)}>
                    Export
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="No archived sessions yet" detail="Archive a completed session to keep it in history." />
          )}
        </section>
      </div>
    </section>
  );
}

function QuestionCandidate({
  onAnswer,
  onDismiss,
  onSelect,
  onSave,
  question,
  selected
}: {
  onAnswer: () => void;
  onDismiss: () => void;
  onSelect: () => void;
  onSave: () => void;
  question: QuestionCard;
  selected: boolean;
}) {
  return (
    <article className={`question-candidate ${selected ? "selected" : ""}`} role="listitem" aria-current={selected ? "true" : undefined}>
      <div className="question-meta">
        <span className={`status-dot ${question.status}`} />
        <span>{question.type}</span>
        <span>{Math.round(question.confidence * 100)}%</span>
      </div>
      <strong>{question.rawText}</strong>
      <p>{question.framedQuestion}</p>
      <div className="question-actions">
        <button
          className="icon-action"
          type="button"
          onClick={onSave}
          aria-label={question.status === "saved" ? "Unsave question" : "Save question"}
          title={question.status === "saved" ? "Unsave question" : "Save question"}
        >
          <Bookmark size={16} fill={question.status === "saved" ? "currentColor" : "none"} />
        </button>
        <button className="icon-action" type="button" onClick={onDismiss} aria-label="Dismiss question" title="Dismiss question">
          <X size={16} />
        </button>
        <button className="ghost-action" type="button" onClick={onSelect}>
          Inspect
        </button>
        <button className="primary-action compact" type="button" onClick={onAnswer}>
          Answer now
        </button>
      </div>
    </article>
  );
}

function TranscriptBubble({
  event,
  onToggle,
  selected
}: {
  event: TranscriptEvent;
  onToggle: () => void;
  selected: boolean;
}) {
  const fromUser = event.source === "mic";
  return (
    <article className={`transcript-bubble ${fromUser ? "user" : "system"} ${selected ? "selected" : ""}`} role="listitem">
      <button
        className="select-transcript"
        type="button"
        onClick={onToggle}
        aria-label={`${selected ? "Unselect" : "Select"} transcript segment`}
        aria-pressed={selected}
      >
        {selected ? <CheckSquare size={16} /> : <span />}
      </button>
      <div className="bubble-avatar">{fromUser ? <Mic2 size={16} /> : <MonitorDot size={16} />}</div>
      <div>
        <span>{fromUser ? "You" : event.source === "system" ? "Interviewer" : "Second Chair"}</span>
        <p>{event.text}</p>
      </div>
    </article>
  );
}

function AudioToggle({
  enabled,
  icon,
  label,
  onChange
}: {
  enabled: boolean;
  icon: React.ReactNode;
  label: string;
  onChange: (value: boolean) => void | Promise<void>;
}) {
  return (
    <button className={`audio-toggle ${enabled ? "active" : ""}`} type="button" onClick={() => onChange(!enabled)} aria-pressed={enabled}>
      {icon}
      <span>{label}</span>
      <strong>{enabled ? "On" : "Off"}</strong>
    </button>
  );
}

function PanelHeader({
  action,
  eyebrow,
  id,
  icon,
  title
}: {
  action?: string;
  eyebrow: string;
  id?: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="panel-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h3 id={id}>
          {icon}
          {title}
        </h3>
      </div>
      {action && <span className="panel-action">{action}</span>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Field({ label, onChange, value }: { label: string; onChange?: (value: string) => void; value: string }) {
  return (
    <label className="field-control">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange?.(event.target.value)} readOnly={!onChange} />
    </label>
  );
}

function SelectField<TValue extends string>({
  label,
  onChange,
  options,
  value
}: {
  label: string;
  onChange: (value: TValue) => void;
  options: { label: string; value: TValue }[];
  value: TValue;
}) {
  return (
    <label className="field-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as TValue)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function Notice({
  message,
  onDismiss,
  tone
}: {
  message: string;
  onDismiss: () => void;
  tone: "error" | "info";
}) {
  return (
    <div className={`app-notice ${tone}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"}>
      <span>{message}</span>
      <button className="icon-button" type="button" aria-label="Dismiss notice" onClick={onDismiss}>
        <Check size={15} />
      </button>
    </div>
  );
}

function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const steps = [
    {
      title: "Add your NVIDIA API key",
      detail: "Second Chair defaults to NVIDIA for answers, live captions, and document search. Open Settings anytime to switch providers.",
      content: (
        <>
          <ApiKeyGuideCard guide={DEFAULT_API_KEY_GUIDE} compact />
          <p className="wizard-note">
            Prefer OpenAI, Gemini, or Claude? Go to Settings, choose another provider, and follow the short key guide shown there.
          </p>
        </>
      ),
    },
    {
      title: "Start with setup",
      detail: "Enter the role, company, round, seniority, and upload the documents that should ground answers."
    },
    {
      title: "Run Live Assist",
      detail: "Turn on microphone and system audio, watch the transcript populate, and select transcript segments."
    },
    {
      title: "Use the overlay",
      detail: "Open the floating overlay during calls. Tap Listen for live captions, then Answer when a question is detected. Use Open cockpit in the overlay for full setup and Settings."
    },
    {
      title: "Answer from context",
      detail: "Use Ask AI for selected transcript text, or Answer now from possible questions detected from the transcript."
    },
    {
      title: "Tune and review",
      detail: "Use Settings for API keys and models, Prompt Studio for system prompts, and Review for the session timeline."
    }
  ];
  const [stepIndex, setStepIndex] = useState(0);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  useEffect(() => {
    nextButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="wizard-backdrop" role="presentation">
      <section className="wizard-dialog" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
        <span className="eyebrow">Product tour</span>
        <h2 id="wizard-title">{step.title}</h2>
        <p>{step.detail}</p>
        {"content" in step && step.content}
        <div className="wizard-progress" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
          {steps.map((item, index) => (
            <span className={index <= stepIndex ? "active" : ""} key={item.title} />
          ))}
        </div>
        <div className="wizard-actions">
          <button className="ghost-action" type="button" onClick={onClose}>
            Skip
          </button>
          <button
            className="primary-action"
            type="button"
            ref={nextButtonRef}
            onClick={() => {
              if (isLast) {
                onClose();
                return;
              }
              setStepIndex((index) => index + 1);
            }}
          >
            {isLast ? "Finish" : "Next"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Preference({
  active = false,
  detail,
  onClick,
  title
}: {
  active?: boolean;
  detail: string;
  onClick?: () => void;
  title: string;
}) {
  const Component = onClick ? "button" : "div";
  return (
    <Component
      className={`preference ${active ? "active" : ""}`}
      type={onClick ? "button" : undefined}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
    >
      <strong>{title}</strong>
      <span>{detail}</span>
    </Component>
  );
}

function SegmentedControl<TValue extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: TValue;
  options: { label: string; value: TValue }[];
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="segmented-control" aria-label={label} role="radiogroup">
      {options.map((option) => (
        <button
          className={value === option.value ? "active" : ""}
          key={option.value}
          type="button"
          aria-checked={value === option.value}
          role="radio"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function VoiceSelector({
  voiceProfile,
  customVoice,
  onChange,
}: {
  voiceProfile: VoiceProfile;
  customVoice: string;
  onChange: (patch: Partial<Pick<SessionSetup, "voiceProfile" | "customVoice">>) => void;
}) {
  return (
    <div className="voice-selector">
      <ChipGroup
        label="Voice"
        value={voiceProfile}
        options={voiceChipOptions}
        onChange={(profile) => onChange({ voiceProfile: profile })}
      />
      {voiceProfile === "custom" && (
        <input
          className="voice-custom-input"
          placeholder="Custom voice, e.g. warm staff engineer, executive consultant..."
          value={customVoice}
          onChange={(event) => onChange({ customVoice: event.target.value })}
        />
      )}
    </div>
  );
}

function ChipGroup<TValue extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: TValue;
  options: { label: string; value: TValue }[];
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="chip-group" aria-label={label}>
      <span>{label}</span>
      <div className="chip-row">
        {options.map((option) => (
          <button
            className={value === option.value ? "active" : ""}
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export { App };
