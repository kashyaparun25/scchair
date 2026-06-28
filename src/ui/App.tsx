import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeAudioCapture } from "./hooks/useRealtimeAudioCapture";
import { SettingsPage } from "./SettingsPage";
import {
  AudioWaveform,
  BookOpen,
  BriefcaseBusiness,
  Check,
  Copy,
  Database,
  ExternalLink,
  FileText,
  History,
  LayoutDashboard,
  ListChecks,
  Mic2,
  MonitorDot,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Target,
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
  LocalProfile,
  QuestionCard,
  InterviewRound,
  SessionArchiveSummary,
  SessionSetup,
  TranscriptEvent,
  VoiceProfile,
} from "../shared/domain";
import {
  answerFormatOptions,
  responsePersonaOptions,
} from "../shared/domain";
import type { SttLanguageMetadata } from "../shared/providerPresets";

type AppDrawer = "knowledge" | "review" | "settings" | null;
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

type StealthPersona = {
  id: string;
  label: string;
  processTitle: string;
  appName: string;
};

type StealthConfig = {
  enabled: boolean;
  persona: string;
  defaultClickThrough: boolean;
  autoHideOnBlur: boolean;
  panicHideMain: boolean;
};

type StealthInfo = {
  config: StealthConfig;
  personas: StealthPersona[];
  shortcuts: Record<string, string>;
  overlayClickThrough: boolean;
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
      stealth?: {
        get: () => Promise<StealthInfo>;
        update: (patch: Partial<StealthConfig>) => Promise<{ config: StealthConfig; overlayClickThrough: boolean }>;
        setClickThrough: (enabled: boolean) => Promise<{ clickThrough: boolean }>;
        panic: () => Promise<{ visible: boolean }>;
      };
      shortcuts?: {
        on: (
          channel:
            | "shortcut:captureScreenshot"
            | "shortcut:toggleAnswer"
            | "shortcut:toggleOverlay"
            | "shortcut:hideOverlays"
            | "shortcut:toggleVisibility"
            | "shortcut:toggleInteraction"
            | "stealth:changed",
          listener: (payload: unknown) => void
        ) => () => void;
      };
    };
    secondChair?: Window["interviewCopilot"];
  }
}

const formatOptions: { label: string; value: AnswerFormat }[] = [...answerFormatOptions];
const responsePersonas = [...responsePersonaOptions];
const personaOptions = responsePersonas.map(({ label, value }) => ({ label, value }));

function personaNote(value: VoiceProfile): string {
  return responsePersonas.find((option) => option.value === value)?.note || "Clear, specific, and easy to read aloud.";
}

function roundLabel(round: InterviewRound): string {
  return roundOptions.find((option) => option.value === round)?.label || "Interview";
}

function buildSessionTitle(role: string, company: string): string {
  const trimmedRole = role.trim();
  const trimmedCompany = company.trim();
  if (trimmedRole && trimmedCompany) return `${trimmedRole} @ ${trimmedCompany}`;
  if (trimmedRole) return trimmedRole;
  return "Interview session";
}

function buildMeetingTitle(topic: string, audience: string): string {
  const trimmedTopic = topic.trim();
  const trimmedAudience = audience.trim();
  if (trimmedTopic && trimmedAudience) return `${trimmedTopic} with ${trimmedAudience}`;
  if (trimmedTopic) return trimmedTopic;
  return "Meeting session";
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

const setupFlowSteps = [
  { title: "Profile", detail: "Choose the local identity that owns this session." },
  { title: "Setup", detail: "Define the interview or meeting context." },
  { title: "Knowledge", detail: "Attach the files that should ground answers." },
  { title: "Assist", detail: "Start capture and let answers follow the transcript." },
];

interface BootstrapState {
  activeProfile?: LocalProfile;
  profiles?: LocalProfile[];
  session: SessionSetup | null;
  documents: DocumentSummary[];
  transcriptEvents: TranscriptEvent[];
  questionCards: QuestionCard[];
  answerDrafts: AnswerDraft[];
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
    meetingTopic: "",
    meetingAudience: "",
    meetingGoal: "",
    meetingNotes: "",
    responseStyle: "balanced",
    language: "English",
    voiceProfile: "staff-engineer",
    customVoice: "",
    answerFormat: "technical",
    documents
  };
}

function blankProfile(now = Date.now()): LocalProfile {
  return {
    id: "local-default",
    name: "Default",
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };
}

const baseLanguageOptions = [
  { label: "English", value: "English" },
  { label: "Spanish", value: "Spanish" },
  { label: "French", value: "French" },
  { label: "German", value: "German" },
  { label: "Italian", value: "Italian" },
  { label: "Portuguese", value: "Portuguese" },
  { label: "Hindi", value: "Hindi" },
];

function languageOptionsForStt(metadata: SttLanguageMetadata | null): { label: string; value: string }[] {
  if (metadata?.scope === "english-only") return [baseLanguageOptions[0]];
  if (metadata?.scope === "multilingual") return baseLanguageOptions;
  return [baseLanguageOptions[0]];
}

function languageNoteForStt(metadata: SttLanguageMetadata | null): string {
  if (!metadata) return "Language choices follow the active speech-to-text model.";
  if (metadata.scope === "english-only") return "The selected caption model is English-only.";
  if (metadata.scope === "multilingual") return "The selected caption model supports multilingual input.";
  return "Language support depends on the selected speech-to-text provider.";
}

function sessionDisplayName(session: SessionSetup): string {
  if (session.mode === "meeting") return session.meetingTopic || session.title || "Untitled meeting";
  return session.role || session.title || "Untitled interview";
}

function answerText(answer: AnswerDraft | null): string {
  if (!answer) return "";
  if (answer.stages.structured.trim()) return answer.stages.structured.trim();
  if (answer.stages.bullets.length) return answer.stages.bullets.join("\n");
  return "";
}

function App() {
  const [session, setSession] = useState<SessionSetup>(() => blankSession());
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<AnswerDraft[]>([]);
  const [activeProfile, setActiveProfile] = useState<LocalProfile>(() => blankProfile());
  const [profiles, setProfiles] = useState<LocalProfile[]>(() => [blankProfile()]);
  const [transcript, setTranscript] = useState<TranscriptEvent[]>([]);
  const [isAnswering, setIsAnswering] = useState(false);
  const [answeringQuestionIds, setAnsweringQuestionIds] = useState<string[]>([]);
  const answeringIdsRef = useRef<Set<string>>(new Set());
  const answerQuestionRef = useRef<(questionId: string) => Promise<void>>(async () => undefined);
  const [liveNotice, setLiveNotice] = useState("");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [micEnabled, setMicEnabled] = useState(false);
  const [systemEnabled, setSystemEnabled] = useState(false);
  const [appNotice, setAppNotice] = useState<{ tone: "error" | "info"; message: string } | null>(null);
  const [autoAnswerEnabled, setAutoAnswerEnabled] = useState(true);
  const autoAnsweredIdsRef = useRef<Set<string>>(new Set());
  const [showSetupModal, setShowSetupModal] = useState(true);
  const [drawer, setDrawer] = useState<AppDrawer>(null);
  const [sttLanguageMetadata, setSttLanguageMetadata] = useState<SttLanguageMetadata | null>(null);

  const applyBootstrapState = useCallback((state: BootstrapState) => {
    const fallbackProfile = blankProfile();
    const nextActiveProfile = state.activeProfile || fallbackProfile;
    const nextProfiles = state.profiles?.length ? state.profiles : [nextActiveProfile];
    const loadedDocuments = state.documents || [];
    const loadedSession = state.session || blankSession(loadedDocuments);
    setActiveProfile(nextActiveProfile);
    setProfiles(nextProfiles);
    setDocuments(loadedDocuments);
    setSession({ ...loadedSession, documents: loadedDocuments });
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

  useEffect(() => {
    void fetch("/api/audio/streaming")
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error("Streaming metadata unavailable."))))
      .then((payload: { language?: SttLanguageMetadata }) => {
        if (payload.language) setSttLanguageMetadata(payload.language);
      })
      .catch(() => setSttLanguageMetadata(null));
  }, []);

  const selectProfile = useCallback(async (profileId: string) => {
    if (!profileId || profileId === activeProfile.id) return;
    const response = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/select`, { method: "POST" });
    if (!response.ok) {
      setAppNotice({ tone: "error", message: await apiErrorMessage(response, "Could not switch profile.") });
      return;
    }
    const payload = (await response.json()) as { state?: BootstrapState; activeProfile?: LocalProfile; profiles?: LocalProfile[] };
    if (payload.state) {
      applyBootstrapState(payload.state);
    } else {
      setActiveProfile(payload.activeProfile || blankProfile());
      setProfiles(payload.profiles || [payload.activeProfile || blankProfile()]);
      await loadState();
    }
    resetLiveAssistState();
    setAppNotice({ tone: "info", message: "Profile switched. Local session state was reloaded." });
  }, [activeProfile.id, applyBootstrapState, loadState, resetLiveAssistState]);

  const createProfile = useCallback(async () => {
    const name = window.prompt("Profile name");
    if (!name?.trim()) return;
    const response = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!response.ok) {
      setAppNotice({ tone: "error", message: await apiErrorMessage(response, "Could not create profile.") });
      return;
    }
    const payload = (await response.json()) as { profile: LocalProfile; profiles: LocalProfile[] };
    setProfiles(payload.profiles);
    await selectProfile(payload.profile.id);
  }, [selectProfile]);

  const activeQuestions = useMemo(() => questions.filter((question) => question.status !== "dismissed"), [questions]);
  const selectedQuestion =
    activeQuestions.find((question) => question.id === selectedQuestionId) || activeQuestions[0] || null;
  const languageOptions = useMemo(() => languageOptionsForStt(sttLanguageMetadata), [sttLanguageMetadata]);
  const languageNote = useMemo(() => languageNoteForStt(sttLanguageMetadata), [sttLanguageMetadata]);

  useEffect(() => {
    if (!languageOptions.some((option) => option.value === session.language)) {
      setSession((current) => ({ ...current, language: languageOptions[0]?.value || "English" }));
    }
  }, [languageOptions, session.language]);

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
        body: JSON.stringify({
          format: session.answerFormat,
          profile: session.voiceProfile === "custom"
            ? (session.customVoice.trim() ? `custom:${session.customVoice.trim()}` : undefined)
            : session.voiceProfile,
        })
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
  }, [session.answerFormat, session.customVoice, session.voiceProfile]);

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

  const openAnswerWindow = () => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("answer");
      return;
    }
    window.open("?view=answer", "second-chair-answer", "width=720,height=820,noopener,noreferrer");
  };

  return (
    <main className="console-app-frame console-reference-shell">
      <header className="reference-titlebar">
        <div className="reference-brand">
          <div className="reference-logo"><SecondChairMark /></div>
          <strong>Second Chair</strong>
          <span>Command Console</span>
        </div>
        <div className="reference-window-actions" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </header>

      {appNotice && (
        <Notice
          message={appNotice.message}
          tone={appNotice.tone}
          onDismiss={() => setAppNotice(null)}
        />
      )}

      <section className="reference-toolbar" aria-label="Session controls">
        <label className="reference-profile-select">
          <span>Profile</span>
          <div>
            <UserRoundCheck size={16} />
            <select value={activeProfile.id} onChange={(event) => void selectProfile(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </div>
        </label>
        <SegmentedControl
          label="Mode"
          value={session.mode}
          options={[
            { label: "Interview", value: "interview" },
            { label: "Meeting", value: "meeting" },
          ]}
          onChange={(nextMode) => void patchSession({
            mode: nextMode,
            title: nextMode === "meeting"
              ? buildMeetingTitle(session.meetingTopic, session.meetingAudience)
              : buildSessionTitle(session.role, session.company),
          })}
        />
        <SelectField label="Language" value={session.language} options={languageOptions} onChange={(language) => void patchSession({ language })} />
        <div className="reference-toolbar-actions">
          <button className="reference-icon-action" type="button" onClick={() => setShowSetupModal(true)}><BriefcaseBusiness size={20} /><span>Setup</span></button>
          <button className="reference-icon-action" type="button" onClick={() => setDrawer("knowledge")}><Database size={20} /><span>Knowledge</span></button>
          <button className="reference-icon-action" type="button" onClick={() => setDrawer("review")}><History size={20} /><span>Audit Log</span></button>
          <button className="reference-icon-action" type="button" onClick={() => setDrawer("settings")}><Settings2 size={20} /><span>Settings</span></button>
          <button className="reference-detach-button" type="button" onClick={openAnswerWindow}><ExternalLink size={17} />Detach Answer</button>
        </div>
      </section>

      <section className="reference-workspace" aria-label="Second Chair workspace">
        <ReferenceSidebar
          activeProfile={activeProfile}
          profiles={profiles}
          session={session}
          questions={questions}
          answerDrafts={answerDrafts}
          transcript={transcript}
          onCreateProfile={createProfile}
          onSelectProfile={selectProfile}
          onStartNewSession={startNewSession}
        />

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

        <ReferenceAnswerPanel
          answerDrafts={answerDrafts}
          answeringQuestionIds={answeringQuestionIds}
          isAnswering={isAnswering}
          onAnswerQuestion={answerQuestion}
          onUpdateAnswerMetadata={updateAnswerMetadata}
          onUpdateQuestionStatus={updateQuestionStatus}
          questions={activeQuestions}
          selectedQuestion={selectedQuestion}
          setSelectedQuestionId={setSelectedQuestionId}
          session={session}
        />
      </section>

      {drawer && (
        <UtilityDrawer title={drawerLabel(drawer)} onClose={() => setDrawer(null)}>
          {drawer === "knowledge" && (
            <KnowledgePage
              documents={documents}
              onAddPastedDocument={addPastedDocument}
              onDeleteDocument={deleteDocument}
              onUploadDocument={uploadDocument}
            />
          )}
          {drawer === "settings" && <SettingsPage />}
          {drawer === "review" && <ReviewPage questions={questions} />}
        </UtilityDrawer>
      )}

      {showSetupModal && (
        <SetupModal
          activeProfile={activeProfile}
          documents={documents}
          languageNote={languageNote}
          languageOptions={languageOptions}
          profiles={profiles}
          session={session}
          onAddPastedDocument={addPastedDocument}
          onClose={() => setShowSetupModal(false)}
          onCreateProfile={createProfile}
          onDeleteDocument={deleteDocument}
          onOpenKnowledge={() => {
            setShowSetupModal(false);
            setDrawer("knowledge");
          }}
          onSave={async (nextSession) => {
            await patchSession(nextSession);
            setShowSetupModal(false);
          }}
          onSelectProfile={selectProfile}
          onStartNewSession={async (nextSession) => {
            const started = await startNewSession(nextSession);
            if (started) setShowSetupModal(false);
            return started;
          }}
          onUploadDocument={uploadDocument}
        />
      )}
    </main>
  );
}

function drawerLabel(drawer: Exclude<AppDrawer, null>): string {
  if (drawer === "knowledge") return "Knowledge";
  if (drawer === "review") return "Audit and history";
  return "Settings";
}

function SecondChairMark() {
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label="Second Chair logo">
      <path className="chair-mark-seat" d="M15 25.5h17.8c3.1 0 5.7 2.5 5.7 5.7v1.3H18.8c-2.1 0-3.8-1.7-3.8-3.8v-3.2Z" />
      <path className="chair-mark-back" d="M13.2 8.5h2.4c2 0 3.7 1.5 4 3.4l2 13.6h-5.2L13.2 8.5Z" />
      <path className="chair-mark-frame" d="M18 32.5v7m18-7v7M16.5 39.5h22" />
      <path className="chair-mark-second" d="M27.5 18.2h8.2c2.7 0 4.8 2.2 4.8 4.8v2.5h-9.8c-1.8 0-3.3-1.3-3.6-3.1l-.6-4.2Z" />
    </svg>
  );
}

function UtilityDrawer({
  children,
  onClose,
  title
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <div className="utility-drawer-backdrop" role="presentation">
      <aside className="utility-drawer" aria-label={title}>
        <header className="utility-drawer-header">
          <div>
            <span className="eyebrow">Utility drawer</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={`Close ${title}`} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="utility-drawer-body">
          {children}
        </div>
      </aside>
    </div>
  );
}

function SetupModal({
  activeProfile,
  documents,
  languageNote,
  languageOptions,
  onAddPastedDocument,
  onClose,
  onCreateProfile,
  onDeleteDocument,
  onOpenKnowledge,
  onSave,
  onSelectProfile,
  onStartNewSession,
  onUploadDocument,
  profiles,
  session,
}: {
  activeProfile: LocalProfile;
  documents: DocumentSummary[];
  languageNote: string;
  languageOptions: { label: string; value: string }[];
  onAddPastedDocument: () => Promise<void>;
  onClose: () => void;
  onCreateProfile: () => Promise<void>;
  onDeleteDocument: (documentId: string) => Promise<void>;
  onOpenKnowledge: () => void;
  onSave: (session: SessionSetup) => Promise<void>;
  onSelectProfile: (profileId: string) => Promise<void>;
  onStartNewSession: (sessionInput?: Partial<SessionSetup>) => Promise<boolean>;
  onUploadDocument: (file: File) => Promise<void>;
  profiles: LocalProfile[];
  session: SessionSetup;
}) {
  const [draft, setDraft] = useState(session);
  const [draftDirty, setDraftDirty] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const draftScopeRef = useRef("");
  const indexedDocuments = documents.filter((document) => document.status === "indexed").length;

  useEffect(() => {
    const nextScope = `${activeProfile.id}:${session.id || "current"}`;
    if (draftScopeRef.current !== nextScope || !draftDirty) {
      setDraft(session);
      setDraftDirty(false);
      draftScopeRef.current = nextScope;
    }
  }, [activeProfile.id, draftDirty, session]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const updateDraft = (patch: Partial<SessionSetup>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDraftDirty(true);
  };

  const saveSetup = async () => {
    await onSave(draft);
    setDraftDirty(false);
  };

  const startSession = async () => {
    await onStartNewSession(draft);
    setDraftDirty(false);
  };

  return (
    <div className="setup-modal-backdrop" role="presentation">
      <section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-modal-title">
        <header className="setup-modal-header">
          <div className="setup-modal-brand">
            <SecondChairMark />
            <div>
              <span>Session setup</span>
              <h2 id="setup-modal-title">Prepare the workspace</h2>
            </div>
          </div>
          <button className="reference-panel-close" type="button" aria-label="Close setup" onClick={onClose} ref={closeButtonRef}>
            <X size={18} />
          </button>
        </header>

        <div className="setup-flow-strip" aria-label="Setup flow">
          {setupFlowSteps.map((step, index) => (
            <article className={index < 3 ? "active" : ""} key={step.title}>
              <span>{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="setup-modal-body">
          <section className="setup-modal-card profile-card">
            <PanelHeader eyebrow="Profile" icon={<UserRoundCheck size={18} />} title="Local identity" action={activeProfile.name} />
            <label className="setup-select-row">
              <span>Active profile</span>
              <select value={activeProfile.id} onChange={(event) => void onSelectProfile(event.target.value)}>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </label>
            <button className="ghost-action compact" type="button" onClick={() => void onCreateProfile()}>
              <Plus size={15} />
              New profile
            </button>
          </section>

          <section className="setup-modal-card context-card">
            <PanelHeader eyebrow="Context" icon={<Target size={18} />} title={draft.mode === "meeting" ? "Meeting context" : "Interview context"} />
            <SegmentedControl
              label="Session mode"
              value={draft.mode}
              options={[
                { label: "Interview", value: "interview" },
                { label: "Meeting", value: "meeting" },
              ]}
              onChange={(nextMode) => updateDraft({
                mode: nextMode,
                title: nextMode === "meeting"
                  ? buildMeetingTitle(draft.meetingTopic, draft.meetingAudience)
                  : buildSessionTitle(draft.role, draft.company),
              })}
            />
            <div className="setup-modal-grid">
              {draft.mode === "meeting" ? (
                <>
                  <Field
                    label="Topic"
                    value={draft.meetingTopic}
                    onChange={(meetingTopic) => updateDraft({
                      meetingTopic,
                      title: buildMeetingTitle(meetingTopic, draft.meetingAudience),
                    })}
                  />
                  <Field
                    label="Audience"
                    value={draft.meetingAudience}
                    onChange={(meetingAudience) => updateDraft({
                      meetingAudience,
                      title: buildMeetingTitle(draft.meetingTopic, meetingAudience),
                    })}
                  />
                  <TextAreaField label="Goal" value={draft.meetingGoal} onChange={(meetingGoal) => updateDraft({ meetingGoal })} />
                  <TextAreaField label="Notes" value={draft.meetingNotes} onChange={(meetingNotes) => updateDraft({ meetingNotes })} />
                </>
              ) : (
                <>
                  <Field
                    label="Target role"
                    value={draft.role}
                    onChange={(role) => updateDraft({
                      role,
                      title: buildSessionTitle(role, draft.company),
                    })}
                  />
                  <Field
                    label="Company"
                    value={draft.company}
                    onChange={(company) => updateDraft({
                      company,
                      title: buildSessionTitle(draft.role, company),
                    })}
                  />
                  <SelectField label="Round" value={draft.round} options={roundOptions} onChange={(round) => updateDraft({ round })} />
                  <Field label="Seniority" value={draft.seniority} onChange={(seniority) => updateDraft({ seniority })} />
                </>
              )}
            </div>
          </section>

          <section className="setup-modal-card knowledge-card">
            <PanelHeader
              eyebrow="Knowledge"
              icon={<BookOpen size={18} />}
              title="Grounding materials"
              action={`${indexedDocuments}/${documents.length} indexed`}
            />
            <div className="setup-modal-documents">
              {documents.slice(0, 4).map((document) => (
                <article className="setup-document compact-document" key={document.id}>
                  <FileText size={16} />
                  <div>
                    <strong>{document.name}</strong>
                    <span>{documentStatusLabel(document.status)}</span>
                  </div>
                  <button className="icon-action" type="button" aria-label={`Delete ${document.name}`} onClick={() => void onDeleteDocument(document.id)}>
                    <Trash2 size={14} />
                  </button>
                </article>
              ))}
              {!documents.length && <p className="setup-card-hint">Add a resume, JD, meeting brief, or product notes before capture.</p>}
            </div>
            <div className="inline-actions">
              <DocumentUploadButton onUploadDocument={onUploadDocument} compact />
              <button className="ghost-action compact" type="button" onClick={() => void onAddPastedDocument()}>Paste</button>
              <button className="ghost-action compact" type="button" onClick={onOpenKnowledge}>Manage</button>
            </div>
          </section>

          <section className="setup-modal-card behavior-card">
            <PanelHeader eyebrow="Behavior" icon={<WandSparkles size={18} />} title="Answer behavior" />
            <div className="setup-modal-grid">
              <SelectField
                label="Response style"
                value={draft.responseStyle}
                options={responseStyleOptions.map((option) => ({ label: option.title, value: option.value }))}
                onChange={(responseStyle) => updateDraft({ responseStyle })}
              />
              <SelectField label="Answer format" value={draft.answerFormat} options={formatOptions} onChange={(answerFormat) => updateDraft({ answerFormat })} />
              <SelectField label="Language" value={draft.language} options={languageOptions} onChange={(language) => updateDraft({ language })} />
              <PersonaSelector
                voiceProfile={draft.voiceProfile}
                customVoice={draft.customVoice}
                onChange={(patch) => updateDraft(patch)}
              />
            </div>
            <p className="persona-note">{languageNote}</p>
          </section>
        </div>

        <footer className="setup-modal-footer">
          <button className="ghost-action" type="button" onClick={onClose}>Cancel</button>
          <button className="ghost-action" type="button" onClick={() => void saveSetup()}>Save setup</button>
          <button className="primary-action" type="button" onClick={() => void startSession()}>
            <Play size={17} />
            Start fresh session
          </button>
        </footer>
      </section>
    </div>
  );
}

function ReferenceSidebar({
  activeProfile,
  profiles,
  session,
  questions,
  answerDrafts,
  transcript,
  onCreateProfile,
  onSelectProfile,
  onStartNewSession,
}: {
  activeProfile: LocalProfile;
  profiles: LocalProfile[];
  session: SessionSetup;
  questions: QuestionCard[];
  answerDrafts: AnswerDraft[];
  transcript: TranscriptEvent[];
  onCreateProfile: () => Promise<void>;
  onSelectProfile: (profileId: string) => Promise<void>;
  onStartNewSession: (sessionInput?: Partial<SessionSetup>) => Promise<boolean>;
}) {
  const answered = questions.filter((question) => question.status === "answered" || question.status === "saved").length;
  const elapsed = transcript.length ? `${Math.max(1, Math.round(transcript.length * 1.5))}m` : "0m";
  const currentTitle = sessionDisplayName(session);

  return (
    <aside className="reference-sidebar" aria-label="Profiles and sessions">
      <section className="reference-sidebar-section">
        <div className="reference-sidebar-title">
          <span>Profile</span>
          <button type="button" onClick={() => void onCreateProfile()}>
            <Plus size={15} />
            <span className="label-wide">New Profile</span>
            <span className="label-compact">New</span>
          </button>
        </div>
        <div className="reference-profile-list">
          {profiles.map((profile) => (
            <button
              className={`reference-profile-row ${profile.id === activeProfile.id ? "active" : ""}`}
              key={profile.id}
              type="button"
              onClick={() => void onSelectProfile(profile.id)}
            >
              <UserRoundCheck size={16} />
              <span>{profile.name}</span>
              {profile.id === activeProfile.id && <strong>Default</strong>}
            </button>
          ))}
        </div>
      </section>

      <section className="reference-sidebar-section reference-session-list">
        <div className="reference-sidebar-title">
          <span>Sessions</span>
          <button type="button" onClick={() => void onStartNewSession(session)}>
            <Plus size={15} />
            New
          </button>
        </div>
        <div className="reference-session-group-label">Today</div>
        <button className="reference-session-row active" type="button">
          <span className="reference-session-dot" />
          <span>{currentTitle}</span>
          <time>{questions.length || answerDrafts.length ? `${answered}/${questions.length}` : "Now"}</time>
          <small>{elapsed}</small>
        </button>
        <button className="reference-session-row muted" type="button" onClick={() => void onStartNewSession(session)}>
          <span className="reference-session-dot" />
          <span>Start fresh session</span>
          <time>Archive</time>
          <small>New</small>
        </button>
      </section>

      <section className="reference-current-session">
        <div>
          <span>Current Session</span>
          <strong>{currentTitle}</strong>
        </div>
        <div className="reference-session-meter" aria-label="Session activity">
          {Array.from({ length: 18 }).map((_, index) => (
            <span className={index < Math.min(18, transcript.length + questions.length + 3) ? "active" : ""} key={index} />
          ))}
        </div>
        <p>{questions.length} questions · {answered} answered · {elapsed}</p>
      </section>

      <footer className="reference-sidebar-footer">
        <Mic2 size={16} />
        <span>Microphone Array</span>
        <strong>{transcript.length ? "Auto-saving" : "Ready"}</strong>
      </footer>
    </aside>
  );
}

function ReferenceAnswerPanel({
  answerDrafts,
  answeringQuestionIds,
  isAnswering,
  onAnswerQuestion,
  onUpdateAnswerMetadata,
  onUpdateQuestionStatus,
  questions,
  selectedQuestion,
  setSelectedQuestionId,
  session,
}: {
  answerDrafts: AnswerDraft[];
  answeringQuestionIds: string[];
  isAnswering: boolean;
  onAnswerQuestion: (questionId: string) => Promise<void>;
  onUpdateAnswerMetadata: (answerId: string, metadata: Pick<AnswerDraft, "pinned" | "copiedAt">) => Promise<void>;
  onUpdateQuestionStatus: (questionId: string, status: QuestionCard["status"]) => Promise<void>;
  questions: QuestionCard[];
  selectedQuestion: QuestionCard | null;
  setSelectedQuestionId: (value: string) => void;
  session: SessionSetup;
}) {
  const sortedQuestions = [...questions].sort((left, right) => right.createdAt - left.createdAt);
  const selectedAnswer = selectedQuestion
    ? answerDrafts.find((answer) => answer.questionId === selectedQuestion.id && answer.format === session.answerFormat)
      || answerDrafts.find((answer) => answer.questionId === selectedQuestion.id)
      || null
    : null;
  const recommended = answerText(selectedAnswer);
  const isGenerating = selectedQuestion ? answeringQuestionIds.includes(selectedQuestion.id) : isAnswering;

  const copyAnswer = async () => {
    if (!selectedAnswer || !recommended) return;
    await navigator.clipboard?.writeText(recommended);
    await onUpdateAnswerMetadata(selectedAnswer.id, { copiedAt: Date.now() });
  };

  return (
    <aside className="reference-answer-panel" aria-label="Answer panel">
      <header className="reference-panel-header">
        <div>
          <span>Answer</span>
          <h2>Recommended response</h2>
        </div>
        <button className="reference-panel-close" type="button" aria-label="Collapse answer panel">
          <X size={17} />
        </button>
      </header>

      <section className="reference-detected-box">
        <div className="reference-box-heading">
          <strong>Detected questions</strong>
          <span>{sortedQuestions.length}</span>
        </div>
        <div className="reference-question-list">
          {sortedQuestions.slice(0, 5).map((question) => (
            <button
              className={`reference-question-row ${question.id === selectedQuestion?.id ? "active" : ""}`}
              key={question.id}
              type="button"
              onClick={() => setSelectedQuestionId(question.id)}
            >
              <span>{question.framedQuestion || question.rawText}</span>
              <small>{question.type}</small>
            </button>
          ))}
          {!sortedQuestions.length && (
            <p className="reference-empty-copy">Questions detected from live transcript will appear here.</p>
          )}
        </div>
      </section>

      <section className="reference-recommended-box">
        <div className="reference-answer-heading">
          <div>
            <Sparkles size={18} />
            <strong>Suggested Answer</strong>
          </div>
          <div className="reference-answer-actions">
            <button type="button" aria-label="Copy answer" onClick={() => void copyAnswer()} disabled={!recommended}>
              <Copy size={16} />
            </button>
            <button
              type="button"
              aria-label="Regenerate answer"
              onClick={() => selectedQuestion && void onAnswerQuestion(selectedQuestion.id)}
              disabled={!selectedQuestion || isGenerating}
            >
              <RotateCcw size={16} />
            </button>
          </div>
        </div>
        <article className="reference-answer-copy">
          {isGenerating && !recommended && <p>Drafting your answer...</p>}
          {!isGenerating && !recommended && (
            <p>Select a detected question or enable live capture. A speakable answer will be generated here.</p>
          )}
          {recommended.split("\n").filter(Boolean).map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))}
        </article>
        <footer className="reference-answer-footer">
          <div>
            <span>Confidence</span>
            <strong>{selectedAnswer ? "High" : "Pending"}</strong>
          </div>
          <button className="reference-insert-button" type="button" onClick={() => void copyAnswer()} disabled={!recommended}>
            Insert
            <ExternalLink size={16} />
          </button>
        </footer>
      </section>

      {selectedQuestion && (
        <section className="reference-answer-meta">
          <button type="button" onClick={() => void onUpdateQuestionStatus(selectedQuestion.id, "saved")}>Mark answered</button>
          <button type="button" onClick={() => void onUpdateQuestionStatus(selectedQuestion.id, "dismissed")}>Dismiss</button>
        </section>
      )}
    </aside>
  );
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
  const answeredCount = activeQuestions.filter((question) => question.status === "answered" || question.status === "saved").length;
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
    <section className="reference-center" id="page-live" role="tabpanel" aria-label="Live assist">
      <header className="reference-center-header compact">
        <div className="reference-section-label">
          <AudioWaveform size={16} />
          <div>
            <span>Live transcript</span>
            <strong>{sessionDisplayName(session)}</strong>
          </div>
        </div>
        <div className="reference-live-actions">
          <button type="button" onClick={() => setAutoAnswerEnabled(!autoAnswerEnabled)} aria-pressed={autoAnswerEnabled}>
            <Sparkles size={15} />
            Auto {autoAnswerEnabled ? "On" : "Off"}
          </button>
          <span>{session.answerFormat.replace("-", " ")}</span>
        </div>
      </header>

      <section className="reference-live-transcript">
        <header>
          <div>
            <span className={`reference-live-dot ${micEnabled || systemEnabled ? "active" : ""}`} />
            <strong>Live Capture</strong>
            <em>{micEnabled || systemEnabled ? (streamingAvailable ? "Streaming..." : "Listening...") : "Paused"}</em>
          </div>
          <div className="reference-capture-actions">
            <AudioToggle enabled={systemEnabled} icon={<MonitorDot size={16} />} label="Interviewer" onChange={toggleSystemCapture} />
            <AudioToggle enabled={micEnabled} icon={<Mic2 size={16} />} label="You" onChange={toggleMicCapture} />
          </div>
        </header>

        <div className="reference-transcript-list">
          {transcript.slice(-18).map((event) => (
            <article className="reference-transcript-row" key={event.id}>
              <div className="reference-speaker-avatar"><UserRoundCheck size={15} /></div>
              <strong>{event.source === "mic" ? "You" : "Interviewer"}</strong>
              <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <p>{event.text}</p>
            </article>
          ))}
          {Object.entries(interimBySource).map(([source, text]) => (
            text ? (
              <article className="reference-transcript-row interim" key={`interim-${source}`}>
                <div className="reference-speaker-avatar"><AudioWaveform size={15} /></div>
                <strong>{source === "mic" ? "You" : "Interviewer"}</strong>
                <time>Live</time>
                <p>{text}</p>
              </article>
            ) : null
          ))}
          {!transcript.length && !interimBySource.system && !interimBySource.mic && (
            <div className="reference-transcript-empty">
              <AudioWaveform size={26} />
              <strong>No transcript yet</strong>
              <span>Turn on Interviewer audio or add a note manually.</span>
            </div>
          )}
        </div>

        <div className="reference-manual-note">
          <input
            aria-label="Add transcript line"
            placeholder="Add a note or key point..."
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitManualTranscript();
            }}
          />
          <select value={manualSource} onChange={(event) => setManualSource(event.target.value as TranscriptEvent["source"])}>
            <option value="system">Interviewer</option>
            <option value="mic">You</option>
          </select>
          <button type="button" onClick={() => void submitManualTranscript()}>Add Note</button>
        </div>
      </section>

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
  const indexedDocuments = documents.filter((document) => document.status === "indexed").length;
  const processingDocuments = documents.filter((document) => document.status === "processing").length;
  const summary = processingDocuments > 0
    ? `${indexedDocuments} searchable · ${processingDocuments} indexing`
    : `${indexedDocuments} of ${documents.length} searchable`;
  return (
    <section className="page-shell" id="page-knowledge" role="tabpanel" aria-label="Knowledge">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Knowledge</span>
          <h2>Knowledge base</h2>
          <p className="page-lede">{summary}</p>
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
  const answeredQuestions = questions.filter((question) => question.status === "answered" || question.status === "saved").length;

  return (
    <section className="page-shell" id="page-review" role="tabpanel" aria-label="Review">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Review</span>
          <h2>Review</h2>
          <p className="page-lede">Turn live sessions into exports, archives, and a focused follow-up queue.</p>
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

      <div className="review-summary-strip" aria-label="Review summary">
        <Fact label="Questions" value={questions.length.toLocaleString()} />
        <Fact label="Answered" value={answeredQuestions.toLocaleString()} />
        <Fact label="Archives" value={archives.length.toLocaleString()} />
        <Fact label="Report" value={report ? "Ready" : "Not generated"} />
      </div>

      <div className="review-grid">
        <section className="review-card">
          <PanelHeader eyebrow="Timeline" icon={<History size={18} />} title="Question history" />
          {questions.length ? questions.map((question) => (
            <div className="timeline-item" key={question.id}>
              <span className={`status-dot ${question.status}`} />
              <div>
                <strong>{question.rawText}</strong>
                <p>{question.type} · {Math.round(question.confidence * 100)}% confidence</p>
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
            <EmptyState
              title="No report yet"
              detail={questions.length
                ? "Generate a report to build a practice queue from this session."
                : "Run a live session, then generate a report to see your prep focus."}
            />
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

function TextAreaField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label className="field-control field-control-wide">
      <span>{label}</span>
      <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
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
      <span className="empty-state-mark" aria-hidden="true">
        <Sparkles size={18} />
      </span>
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

function PersonaSelector({
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
      <SelectField
        label="Response persona"
        value={voiceProfile}
        options={personaOptions}
        onChange={(profile) => onChange({ voiceProfile: profile })}
      />
      <p className="persona-note">{personaNote(voiceProfile)}</p>
      {voiceProfile === "custom" && (
        <input
          className="voice-custom-input"
          placeholder="Custom persona, e.g. warm staff engineer, executive consultant..."
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
