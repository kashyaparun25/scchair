import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeAudioCapture } from "./hooks/useRealtimeAudioCapture";
import { SettingsPage } from "./SettingsPage";
import { ApiKeyGuideCard } from "./ApiKeyGuideCard";
import { DEFAULT_API_KEY_GUIDE } from "../shared/apiKeyGuides";
import {
  AudioWaveform,
  BriefcaseBusiness,
  Check,
  Copy,
  Database,
  ExternalLink,
  EyeOff,
  FileText,
  Gauge,
  History,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  Mic2,
  MonitorDot,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
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
  AuditEvent,
  DocumentSummary,
  LocalProfile,
  PromptSetting,
  QuestionCard,
  InterviewRound,
  SessionArchiveSummary,
  SessionMode,
  SessionSetup,
  TranscriptEvent,
  VoiceProfile,
} from "../shared/domain";
import {
  answerFormatOptions,
  responsePersonaOptions,
} from "../shared/domain";
import type { SttLanguageMetadata } from "../shared/providerPresets";

type AppPage = "live" | "setup" | "knowledge" | "prompts" | "review" | "settings";
type AppDrawer = "knowledge" | "prompts" | "review" | "settings" | null;
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

interface BootstrapState {
  activeProfile?: LocalProfile;
  profiles?: LocalProfile[];
  session: SessionSetup | null;
  documents: DocumentSummary[];
  transcriptEvents: TranscriptEvent[];
  questionCards: QuestionCard[];
  answerDrafts: AnswerDraft[];
  auditEvents?: AuditEvent[];
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

const pageTabs: { id: AppPage; label: string; icon: typeof MessageCircle; shortLabel?: string }[] = [
  { id: "setup", label: "Setup", shortLabel: "Setup", icon: BriefcaseBusiness },
  { id: "live", label: "Live", shortLabel: "Live", icon: MessageCircle },
  { id: "knowledge", label: "Knowledge", shortLabel: "Files", icon: Database },
  { id: "prompts", label: "Prompts", shortLabel: "Prompts", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", shortLabel: "Provider", icon: Settings2 },
  { id: "review", label: "Review", shortLabel: "Review", icon: History }
];

function sessionContextLabel(session: SessionSetup): string {
  if (session.mode === "meeting") return session.meetingTopic || "Meeting not set";
  return session.role || "Role not set";
}

function sessionPartnerLabel(session: SessionSetup): string {
  if (session.mode === "meeting") return session.meetingAudience || session.company || "Audience not set";
  return session.company || "Company not set";
}

function App() {
  const initialPage = getInitialPage();
  const [activePage, setActivePage] = useState<AppPage>(initialPage);
  const [session, setSession] = useState<SessionSetup>(() => blankSession());
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<AnswerDraft[]>([]);
  const [activeProfile, setActiveProfile] = useState<LocalProfile>(() => blankProfile());
  const [profiles, setProfiles] = useState<LocalProfile[]>(() => [blankProfile()]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
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
  const [drawer, setDrawer] = useState<AppDrawer>(initialPage === "live" || initialPage === "setup" ? null : initialPage);
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
    setMode(loadedSession.mode || "interview");
    setTranscript(state.transcriptEvents || []);
    setQuestions(state.questionCards || []);
    setAnswerDrafts(state.answerDrafts || []);
    setAuditEvents(state.auditEvents || []);
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
  const setupReady = session.mode === "meeting"
    ? Boolean(session.meetingTopic.trim() || session.meetingGoal.trim())
    : Boolean(session.role.trim() || session.company.trim());
  const indexedDocumentCount = documents.filter((document) => document.status === "indexed").length;
  const knowledgeReady = indexedDocumentCount > 0;
  const liveReady = micEnabled || systemEnabled || transcript.length > 0;
  const providerReady = true;
  const reviewReady = questions.length > 0 || answerDrafts.length > 0;
  const languageOptions = useMemo(() => languageOptionsForStt(sttLanguageMetadata), [sttLanguageMetadata]);
  const languageNote = useMemo(() => languageNoteForStt(sttLanguageMetadata), [sttLanguageMetadata]);

  useEffect(() => {
    if (!languageOptions.some((option) => option.value === session.language)) {
      setSession((current) => ({ ...current, language: languageOptions[0]?.value || "English" }));
    }
  }, [languageOptions, session.language]);
  const readinessItems = {
    setup: setupReady,
    knowledge: knowledgeReady,
    settings: providerReady,
    live: liveReady,
    review: reviewReady,
    prompts: true,
  } satisfies Record<AppPage, boolean>;
  const readinessScore = [setupReady, knowledgeReady, providerReady, liveReady].filter(Boolean).length;

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
    <main className="console-app-frame">
      <header className="console-topbar">
        <div className="brand-lockup console-brand-lockup">
          <div className="brand-mark">
            <MonitorDot size={22} strokeWidth={2.4} />
          </div>
          <div>
            <span className="eyebrow">Local command console</span>
            <h1>Second Chair</h1>
          </div>
        </div>

        <div className="console-profile-strip" aria-label="Profile and session">
          <label className="console-profile-select" title="Profile switching is local to this device">
            <UserRoundCheck size={15} />
            <select value={activeProfile.id} onChange={(event) => void selectProfile(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
          <button className="console-profile-add" type="button" title="Create local profile" aria-label="Create local profile" onClick={() => void createProfile()}>
            <Plus size={14} />
          </button>
          <span className="console-status-chip">{session.mode === "meeting" ? "Meeting" : roundLabel(session.round)}</span>
          <span className="console-status-chip primary">{sessionContextLabel(session)}</span>
          <span className="console-status-chip">{sessionPartnerLabel(session)}</span>
        </div>

        <div className="console-actions" aria-label="Utilities">
          <button className={`console-live-chip ${micEnabled || systemEnabled ? "active" : ""}`} type="button" title="Live capture state">
            <Radio size={13} />
            {micEnabled || systemEnabled ? "Listening" : "Idle"}
          </button>
          <button className="icon-button" type="button" title="Knowledge" aria-label="Open knowledge drawer" onClick={() => setDrawer("knowledge")}>
            <Database size={16} />
          </button>
          <button className="icon-button" type="button" title="Prompt behavior" aria-label="Open prompt behavior drawer" onClick={() => setDrawer("prompts")}>
            <SlidersHorizontal size={16} />
          </button>
          <button className="icon-button" type="button" title="Audit and history" aria-label="Open audit and history drawer" onClick={() => setDrawer("review")}>
            <History size={16} />
          </button>
          <button className="icon-button" type="button" title="Settings" aria-label="Open settings drawer" onClick={() => setDrawer("settings")}>
            <Settings2 size={16} />
          </button>
          <button className="icon-button" type="button" title="Floating overlay window" aria-label="Open floating overlay window" onClick={openOverlay}>
            <MonitorDot size={16} />
          </button>
          <button className="icon-button" type="button" title="Detached answer window" aria-label="Open detached answer window" onClick={openAnswerWindow}>
            <ExternalLink size={16} />
          </button>
          <button className="icon-button" type="button" title="Hide overlay windows" aria-label="Hide overlay windows" onClick={hideOverlays}>
            <EyeOff size={16} />
          </button>
        </div>
      </header>

      {appNotice && (
        <Notice
          message={appNotice.message}
          tone={appNotice.tone}
          onDismiss={() => setAppNotice(null)}
        />
      )}

      <div className="console-readiness-row" aria-label="Session readiness">
        <Fact label="Setup" value={setupReady ? "Ready" : "Needs context"} />
        <Fact label="Knowledge" value={`${indexedDocumentCount}/${documents.length} indexed`} />
        <Fact label="Capture" value={liveReady ? "Active" : "Idle"} />
        <Fact label="Audit" value={reviewReady || auditEvents.length ? `${questions.length + answerDrafts.length + auditEvents.length} events` : "No events"} />
      </div>

      <section className="console-workspace" aria-label="Second Chair command workspace">
        <ConsoleSetupRail
          documents={documents}
          onAddPastedDocument={addPastedDocument}
          onDeleteDocument={deleteDocument}
          onOpenKnowledge={() => setDrawer("knowledge")}
          onSessionChange={setSession}
          onStartNewSession={startNewSession}
          onUploadDocument={uploadDocument}
          languageNote={languageNote}
          languageOptions={languageOptions}
          readinessScore={readinessScore}
          session={session}
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

        <ConsoleAuditRail
          answerDrafts={answerDrafts}
          auditEvents={auditEvents}
          documents={documents}
          onArchive={() => setDrawer("review")}
          questions={questions}
          transcript={transcript}
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
          {drawer === "prompts" && (
            <PromptStudioPage
              session={session}
              onSessionPatch={patchSession}
            />
          )}
          {drawer === "settings" && <SettingsPage />}
          {drawer === "review" && <ReviewPage questions={questions} />}
        </UtilityDrawer>
      )}

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

function drawerLabel(drawer: Exclude<AppDrawer, null>): string {
  if (drawer === "knowledge") return "Knowledge";
  if (drawer === "prompts") return "Prompt behavior";
  if (drawer === "review") return "Audit and history";
  return "Settings";
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

function ConsoleSetupRail({
  documents,
  languageNote,
  languageOptions,
  onAddPastedDocument,
  onDeleteDocument,
  onOpenKnowledge,
  onSessionChange,
  onStartNewSession,
  onUploadDocument,
  readinessScore,
  session
}: {
  documents: DocumentSummary[];
  languageNote: string;
  languageOptions: { label: string; value: string }[];
  onAddPastedDocument: () => Promise<void>;
  onDeleteDocument: (documentId: string) => Promise<void>;
  onOpenKnowledge: () => void;
  onSessionChange: (session: SessionSetup) => void;
  onStartNewSession: (sessionInput?: Partial<SessionSetup>) => Promise<boolean>;
  onUploadDocument: (file: File) => Promise<void>;
  readinessScore: number;
  session: SessionSetup;
}) {
  const indexedDocuments = documents.filter((document) => document.status === "indexed").length;
  const updateSession = (patch: Partial<SessionSetup>) => {
    onSessionChange({ ...session, ...patch });
  };
  const saveAndStart = async () => {
    await onStartNewSession(session);
  };

  return (
    <aside className="console-setup-rail" aria-label="Session setup">
      <header className="rail-header">
        <div>
          <span className="eyebrow">Session</span>
          <h2>{session.mode === "meeting" ? "Meeting setup" : "Interview setup"}</h2>
        </div>
        <span className="readiness-stat compact" title="Setup readiness">
          <Gauge size={13} />
          {readinessScore}/4
        </span>
      </header>

      <div className="rail-section">
        <SegmentedControl
          label="Mode"
          value={session.mode}
          options={[
            { label: "Interview", value: "interview" },
            { label: "Meeting", value: "meeting" },
          ]}
          onChange={(nextMode) => updateSession({
            mode: nextMode,
            title: nextMode === "meeting"
              ? buildMeetingTitle(session.meetingTopic, session.meetingAudience)
              : buildSessionTitle(session.role, session.company),
          })}
        />
        {session.mode === "meeting" ? (
          <>
            <Field
              label="Topic"
              value={session.meetingTopic}
              onChange={(meetingTopic) => updateSession({
                meetingTopic,
                title: buildMeetingTitle(meetingTopic, session.meetingAudience),
              })}
            />
            <Field
              label="Audience"
              value={session.meetingAudience}
              onChange={(meetingAudience) => updateSession({
                meetingAudience,
                title: buildMeetingTitle(session.meetingTopic, meetingAudience),
              })}
            />
            <TextAreaField label="Goal" value={session.meetingGoal} onChange={(meetingGoal) => updateSession({ meetingGoal })} />
          </>
        ) : (
          <>
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
            <SelectField label="Round" value={session.round} options={roundOptions} onChange={(round) => updateSession({ round })} />
          </>
        )}
      </div>

      <div className="rail-section">
        <PanelHeader eyebrow="Behavior" icon={<UserRoundCheck size={18} />} title="Answer behavior" />
        <SelectField
          label="Response style"
          value={session.responseStyle}
          options={responseStyleOptions.map((option) => ({ label: option.title, value: option.value }))}
          onChange={(responseStyle) => updateSession({ responseStyle })}
        />
        <SelectField label="Answer format" value={session.answerFormat} options={formatOptions} onChange={(answerFormat) => updateSession({ answerFormat })} />
        <PersonaSelector
          voiceProfile={session.voiceProfile}
          customVoice={session.customVoice}
          onChange={(patch) => updateSession(patch)}
        />
        <SelectField label="Answer language" value={session.language} options={languageOptions} onChange={(language) => updateSession({ language })} />
        <p className="persona-note">{languageNote}</p>
      </div>

      <div className="rail-section">
        <PanelHeader
          eyebrow="Knowledge"
          icon={<Upload size={18} />}
          title="Materials"
          action={`${indexedDocuments}/${documents.length}`}
        />
        <div className="rail-document-list">
          {documents.slice(0, 4).map((document) => (
            <article className="rail-document" key={document.id}>
              <FileText size={15} />
              <div>
                <strong>{document.name}</strong>
                <span>{documentStatusLabel(document.status)}</span>
              </div>
              <button className="icon-action" type="button" aria-label={`Delete ${document.name}`} onClick={() => void onDeleteDocument(document.id)}>
                <Trash2 size={14} />
              </button>
            </article>
          ))}
          {!documents.length && <p className="setup-card-hint">Add a resume, JD, notes, or meeting brief to ground answers.</p>}
        </div>
        <div className="inline-actions rail-actions">
          <DocumentUploadButton onUploadDocument={onUploadDocument} compact />
          <button className="ghost-action compact" type="button" onClick={() => void onAddPastedDocument()}>
            Paste
          </button>
          <button className="ghost-action compact" type="button" onClick={onOpenKnowledge}>
            All
          </button>
        </div>
      </div>

      <button className="primary-action console-start-button" type="button" onClick={() => void saveAndStart()}>
        <Play size={17} />
        Start fresh session
      </button>
    </aside>
  );
}

function ConsoleAuditRail({
  answerDrafts,
  auditEvents,
  documents,
  onArchive,
  questions,
  transcript
}: {
  answerDrafts: AnswerDraft[];
  auditEvents: AuditEvent[];
  documents: DocumentSummary[];
  onArchive: () => void;
  questions: QuestionCard[];
  transcript: TranscriptEvent[];
}) {
  const answered = questions.filter((question) => question.status === "answered" || question.status === "saved").length;
  const latestQuestions = [...questions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  const latestAuditEvents = auditEvents.slice(0, 4);

  return (
    <aside className="console-audit-rail" aria-label="Audit timeline">
      <header className="rail-header">
        <div>
          <span className="eyebrow">Audit</span>
          <h2>Session trace</h2>
        </div>
        <button className="ghost-action compact" type="button" onClick={onArchive}>
          <History size={14} />
          Open
        </button>
      </header>
      <div className="audit-metric-grid">
        <Fact label="Questions" value={String(questions.length)} />
        <Fact label="Answered" value={String(answered)} />
        <Fact label="Docs" value={String(documents.length)} />
        <Fact label="Transcript" value={String(transcript.length)} />
      </div>
      <div className="audit-timeline">
        {latestQuestions.map((question) => (
          <article className="audit-event" key={question.id}>
            <span className={`status-dot ${question.status}`} />
            <div>
              <strong>{question.status}</strong>
              <p>{question.rawText}</p>
            </div>
          </article>
        ))}
        {answerDrafts.slice(-3).reverse().map((answer) => (
          <article className="audit-event" key={answer.id}>
            <span className="status-dot answered" />
            <div>
              <strong>answer {answer.format}</strong>
              <p>{answer.stages.structured || "Draft created"}</p>
            </div>
          </article>
        ))}
        {latestAuditEvents.map((event) => (
          <article className="audit-event" key={event.id}>
            <span className="status-dot saved" />
            <div>
              <strong>{event.eventType.replace(".", " ")}</strong>
              <p>{event.message}</p>
            </div>
          </article>
        ))}
        {!questions.length && !answerDrafts.length && !auditEvents.length && (
          <EmptyState title="No audit events yet" detail="Questions, answers, copies, and archives will appear here." />
        )}
      </div>
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
    <section className="page-shell live-page live-coach-page" id="page-live" role="tabpanel" aria-label="Live assist">
      <div className="page-heading live-coach-heading">
        <div className="live-coach-title">
          <span className="eyebrow">Live workspace</span>
          <h2>{session.mode === "meeting" ? "Meeting Assist" : "Interview Assist"}</h2>
          <p className="live-coach-subtitle">
            <span className="live-coach-status-pill">
              {micEnabled || systemEnabled
                ? (streamingAvailable ? "Streaming live" : "Listening")
                : "Enable Interviewer audio to start"}
            </span>
            {isAnswering && (
              <span className="live-coach-status-pill working">
                <Sparkles size={12} />
                Generating answer
              </span>
            )}
            <span className="live-coach-status-pill">
              {activeQuestions.length} questions · {answeredCount} answered
            </span>
          </p>
        </div>
        <div className="live-top-controls live-coach-controls">
          <AudioToggle enabled={systemEnabled} icon={<MonitorDot size={17} />} label="Interviewer" onChange={toggleSystemCapture} />
          <AudioToggle enabled={micEnabled} icon={<Mic2 size={17} />} label="You" onChange={toggleMicCapture} />
          <AudioToggle enabled={autoAnswerEnabled} icon={<Sparkles size={17} />} label="Auto" onChange={setAutoAnswerEnabled} />
          <button
            className="ghost-action compact"
            type="button"
            onClick={() => setShowTranscriptRail((value) => !value)}
            aria-pressed={showTranscriptRail}
          >
            <AudioWaveform size={16} />
            {showTranscriptRail ? "Hide transcript" : "Show transcript"}
          </button>
        </div>
      </div>

      <div className="live-coach-toolbar">
        <ChipGroup
          label="Answer format"
          value={session.answerFormat}
          options={formatOptions}
          onChange={(answerFormat) => void onSessionPatch({ answerFormat })}
        />
        <PersonaSelector
          voiceProfile={session.voiceProfile}
          customVoice={session.customVoice}
          onChange={(patch) => void onSessionPatch(patch)}
        />
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
  const indexedDocuments = documents.filter((document) => document.status === "indexed").length;

  return (
    <section className="page-shell" id="page-setup" role="tabpanel" aria-label="Session setup">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Session Setup</span>
          <h2>{session.mode === "meeting" ? "Prepare the meeting" : "Prepare the interview"}</h2>
          <p className="page-lede">{session.title}</p>
        </div>
        <button className="primary-action" type="button" onClick={saveAndStart}>
          <Play size={17} />
          Start session
        </button>
      </div>

      <div className="setup-grid">
        <section className="setup-card setup-card-primary wide-card">
          <PanelHeader eyebrow="Context" icon={<Target size={18} />} title={session.mode === "meeting" ? "Meeting context" : "Role and company"} />
          <SegmentedControl
            label="Session mode"
            value={session.mode}
            options={[
              { label: "Interview", value: "interview" },
              { label: "Meeting", value: "meeting" },
            ]}
            onChange={(nextMode) => updateSession({
              mode: nextMode,
              title: nextMode === "meeting"
                ? buildMeetingTitle(session.meetingTopic, session.meetingAudience)
                : buildSessionTitle(session.role, session.company),
            })}
          />
          <div className="field-grid">
            {session.mode === "meeting" ? (
              <>
                <Field
                  label="Meeting topic"
                  value={session.meetingTopic}
                  onChange={(meetingTopic) => updateSession({
                    meetingTopic,
                    title: buildMeetingTitle(meetingTopic, session.meetingAudience),
                  })}
                />
                <Field
                  label="Audience"
                  value={session.meetingAudience}
                  onChange={(meetingAudience) => updateSession({
                    meetingAudience,
                    title: buildMeetingTitle(session.meetingTopic, meetingAudience),
                  })}
                />
                <Field label="Your role" value={session.role} onChange={(role) => updateSession({ role })} />
                <Field label="Organization" value={session.company} onChange={(company) => updateSession({ company })} />
                <TextAreaField
                  label="Meeting goal"
                  value={session.meetingGoal}
                  onChange={(meetingGoal) => updateSession({ meetingGoal })}
                />
                <TextAreaField
                  label="Key notes"
                  value={session.meetingNotes}
                  onChange={(meetingNotes) => updateSession({ meetingNotes })}
                />
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </section>
        <section className="setup-card wide-card">
          <PanelHeader
            eyebrow="Knowledge"
            icon={<Upload size={18} />}
            title={session.mode === "meeting" ? "Meeting materials" : "Interview materials"}
            action={`${indexedDocuments}/${documents.length} indexed`}
          />
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
          <PanelHeader eyebrow="Persona" icon={<UserRoundCheck size={18} />} title="Response style" />
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
              label="Answer format"
              value={session.answerFormat}
              options={formatOptions}
              onChange={(answerFormat) => updateSession({ answerFormat })}
            />
            <PersonaSelector
              voiceProfile={session.voiceProfile}
              customVoice={session.customVoice}
              onChange={(patch) => updateSession(patch)}
            />
          </div>
        </section>
        <section className="setup-card">
          <PanelHeader eyebrow="Capture" icon={<Mic2 size={18} />} title="Audio and language" />
          <Field label="Spoken language" value={session.language} onChange={(language) => updateSession({ language })} />
          <p className="setup-card-hint">
            Microphone and system audio are turned on from the Live tab during the session.
          </p>
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
  const draftWordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  const draftVariableCount = activePrompt?.variables.length || 0;

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
          <span className="eyebrow">Prompts</span>
          <h2>Prompt Studio</h2>
          <p className="page-lede">Pick a response persona and edit the system prompts that shape every answer.</p>
        </div>
        <button className="primary-action" type="button" onClick={savePrompt} disabled={!activePrompt}>
          <Check size={17} />
          Save prompt
        </button>
      </div>

      <div className="prompt-grid">
        <section className="prompt-library">
          <PanelHeader eyebrow="Personas" icon={<Settings2 size={18} />} title="Answer personas" />
          <PersonaSelector
            voiceProfile={session.voiceProfile}
            customVoice={session.customVoice}
            onChange={(patch) => void onSessionPatch(patch)}
          />
        </section>
        <section className="prompt-editor">
          <PanelHeader eyebrow="System prompt" icon={<SlidersHorizontal size={18} />} title="Prompt template" />
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
          <div className="prompt-meta-strip" aria-label="Prompt statistics">
            <Fact label="Words" value={draftWordCount.toLocaleString()} />
            <Fact label="Variables" value={draftVariableCount.toLocaleString()} />
            <Fact label="Template" value={activePrompt?.title || "Loading"} />
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

function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const steps = [
    {
      title: "Add your NVIDIA API key",
      detail: "Second Chair defaults to NVIDIA for answers, live captions, and document search. You can switch providers anytime from Settings.",
      content: (
        <>
          <ApiKeyGuideCard guide={DEFAULT_API_KEY_GUIDE} compact />
          <p className="wizard-note">
            Prefer OpenAI, Gemini, or Claude? Go to Settings, pick another provider, and follow its key guide.
          </p>
        </>
      ),
    },
    {
      title: "Set the context",
      detail: "Open Setup, choose Interview or Meeting, and add the role, round, and any documents (resume, JD, notes) that should ground every answer."
    },
    {
      title: "Run Live Assist",
      detail: "On the Live tab, turn on Interviewer (and You) audio. Detected questions and a speakable answer appear automatically. Open the floating overlay window from the top bar during real calls."
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
