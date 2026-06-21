import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeAudioCapture } from "./hooks/useRealtimeAudioCapture";
import type { ReactNode } from "react";
import { ApiKeyGuideCard } from "./ApiKeyGuideCard";
import { DEFAULT_API_KEY_GUIDE } from "../shared/apiKeyGuides";
import {
  Bot,
  Captions,
  Copy,
  ExternalLink,
  EyeOff,
  GripHorizontal,
  LayoutPanelLeft,
  Mic2,
  MonitorDot,
  PanelTopOpen,
  Pause,
  Play,
  Radio,
  Send,
  Settings2,
  Sparkles,
  X
} from "lucide-react";
import type {
  AnswerDraft,
  AnswerFormat,
  DocumentSummary,
  QuestionCard,
  SessionMode,
  SessionSetup,
  TranscriptEvent
} from "../shared/domain";

type OverlayPanel = "answer" | "questions" | "transcript" | "settings";
type InterviewDomain =
  | "general"
  | "behavioral"
  | "technical-verbal"
  | "system-design"
  | "devops-cloud"
  | "support"
  | "sales-engineering"
  | "product-operations"
  | "coding";
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

interface BootstrapState {
  session: SessionSetup | null;
  documents: DocumentSummary[];
  transcriptEvents: TranscriptEvent[];
  questionCards: QuestionCard[];
  answerDrafts: AnswerDraft[];
}

const formatOptions: { label: string; value: AnswerFormat }[] = [
  { label: "Bullets", value: "quick-bullets" },
  { label: "STAR", value: "star" },
  { label: "Technical", value: "technical" },
  { label: "Executive", value: "executive" }
];

const domainOptions: { label: string; value: InterviewDomain }[] = [
  { label: "General", value: "general" },
  { label: "Behavioral", value: "behavioral" },
  { label: "Technical", value: "technical-verbal" },
  { label: "System", value: "system-design" },
  { label: "DevOps", value: "devops-cloud" },
  { label: "Support", value: "support" },
  { label: "Sales Eng", value: "sales-engineering" },
  { label: "Product/Ops", value: "product-operations" },
  { label: "Coding", value: "coding" }
];

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.clone().json();
    if (typeof payload.error === "string") return payload.error;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // Use the contextual fallback.
  }
  return fallback;
}

function latestQuestion(questions: QuestionCard[]) {
  return [...questions]
    .filter((question) => question.status !== "dismissed")
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

function useLatestState(refreshMs = 1800) {
  const [state, setState] = useState<BootstrapState>({
    session: null,
    documents: [],
    transcriptEvents: [],
    questionCards: [],
    answerDrafts: []
  });
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) {
      setNotice(await apiErrorMessage(response, "Latest state is unavailable."));
      return;
    }
    setState(await response.json());
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), refreshMs);
    return () => window.clearInterval(id);
  }, [refresh, refreshMs]);

  return { notice, refresh, setNotice, state, setState };
}

function OverlayApp() {
  const { notice, refresh, setNotice, state, setState } = useLatestState();
  const [panel, setPanel] = useState<OverlayPanel>("answer");
  const [mode, setMode] = useState<SessionMode>("interview");
  const [domain, setDomain] = useState<InterviewDomain>("general");
  const [format, setFormat] = useState<AnswerFormat>("technical");
  const [listenEnabled, setListenEnabled] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [clickThrough, setClickThrough] = useState(false);
  const [isAnswering, setIsAnswering] = useState(false);
  const [manualText, setManualText] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [showIntroGuide, setShowIntroGuide] = useState(
    () => localStorage.getItem("interview-copilot-overlay-guide-seen") !== "true",
  );
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    segmentTimer: ReturnType<typeof setInterval> | null;
  } | null>(null);
  const backendSttUnavailableRef = useRef(false);

  useEffect(() => {
    if (state.session?.mode) setMode(state.session.mode);
  }, [state.session?.mode]);

  const activeQuestion = useMemo(() => latestQuestion(state.questionCards), [state.questionCards]);
  const activeAnswer = useMemo(() => {
    if (!activeQuestion) return null;
    return [...state.answerDrafts]
      .reverse()
      .find((answer) => answer.questionId === activeQuestion.id && answer.format === format)
      || state.answerDrafts.find((answer) => answer.questionId === activeQuestion.id)
      || null;
  }, [format, activeQuestion, state.answerDrafts]);
  const latestTranscript = state.transcriptEvents.slice(-5).reverse();

  const appendTranscript = async (source: TranscriptEvent["source"], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const response = await fetch("/api/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, text: trimmed, isFinal: true })
    });
    if (!response.ok) {
      setNotice(await apiErrorMessage(response, "Transcript could not be added."));
      return;
    }
    const payload = await response.json() as { event: TranscriptEvent; questions: QuestionCard[] };
    setState((current) => ({
      ...current,
      transcriptEvents: [...current.transcriptEvents, payload.event],
      questionCards: payload.questions
    }));
    setManualText("");
    setNotice(source === "mic" ? "Listen transcript added." : "Capture transcript added.");
  };

  const applyTranscriptPayload = useCallback((payload: { event: TranscriptEvent; questions: QuestionCard[] }) => {
    setState((current) => ({
      ...current,
      transcriptEvents: [...current.transcriptEvents, payload.event],
      questionCards: payload.questions
    }));
  }, [setState]);

  const { streamingAvailable, interimBySource } = useRealtimeAudioCapture({
    micEnabled: false,
    systemEnabled: listenEnabled,
    onTranscriptUpdate: applyTranscriptPayload,
    onStatus: setNotice,
  });

  const stopMicRecorder = useCallback(() => {
    const current = recorderRef.current;
    if (!current) return;
    if (current.segmentTimer) clearInterval(current.segmentTimer);
    recorderRef.current = null;
    if (current.recorder.state !== "inactive") current.recorder.stop();
    current.stream.getTracks().forEach((track) => track.stop());
  }, []);

  const uploadMicChunk = useCallback(async (blob: Blob) => {
    if (blob.size < 256 || backendSttUnavailableRef.current) return;
    const formData = new FormData();
    const extension = blob.type.includes("wav") ? "wav" : "webm";
    formData.append("file", blob, `overlay-mic-${Date.now()}.${extension}`);
    const response = await fetch("/api/audio/transcriptions?source=mic", {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const message = await apiErrorMessage(response, "Mic transcription is unavailable.");
      if (response.status === 503) {
        backendSttUnavailableRef.current = true;
        stopMicRecorder();
      }
      setNotice(message);
      setListenEnabled(false);
      return;
    }
    const payload = await response.json() as { event: TranscriptEvent; questions: QuestionCard[] };
    if (payload.event.text.trim()) applyTranscriptPayload(payload);
    setNotice("Mic audio transcribed.");
  }, [applyTranscriptPayload, stopMicRecorder]);

  const startBackendMicRecorder = useCallback(async () => {
    if (backendSttUnavailableRef.current) return false;
    if (recorderRef.current) return true;
    if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
      setNotice("Mic capture is unavailable here. Use manual transcript input.");
      setListenEnabled(false);
      return false;
    }

    try {
      const captureStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false
        }
      });
      const audioTracks = captureStream.getAudioTracks();
      if (!audioTracks.length) {
        captureStream.getTracks().forEach((track) => track.stop());
        setNotice("No microphone audio track was available.");
        setListenEnabled(false);
        return false;
      }
      const stream = new MediaStream(audioTracks);
      const webmMimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, webmMimeType ? { mimeType: webmMimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size >= 256) void uploadMicChunk(event.data);
      };
      recorder.onstop = () => {
        if (recorderRef.current) {
          if (recorder.state === "inactive") recorder.start();
          return;
        }
        stream.getTracks().forEach((track) => track.stop());
      };
      const segmentTimer = setInterval(() => {
        if (recorderRef.current?.recorder.state === "recording") {
          recorderRef.current.recorder.stop();
        }
      }, 5000);
      recorderRef.current = { recorder, stream, segmentTimer };
      recorder.start();
      setNotice("Mic audio upload is active.");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Mic capture could not start.");
      setListenEnabled(false);
      return false;
    }
  }, [uploadMicChunk]);

  useEffect(() => {
    if (streamingAvailable || !listenEnabled) {
      if (!streamingAvailable) stopMicRecorder();
      return;
    }

    void startBackendMicRecorder().then((started) => {
      if (!started) setListenEnabled(false);
    });

    return () => {
      stopMicRecorder();
    };
  }, [listenEnabled, startBackendMicRecorder, stopMicRecorder, streamingAvailable]);

  const answerQuestion = async () => {
    if (!activeQuestion) {
      setNotice("No detected question is available yet.");
      return;
    }
    setIsAnswering(true);
    setPanel("answer");
    const response = await fetch(`/api/questions/${activeQuestion.id}/answer`, {
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
    setCopyNotice("Copied.");
  };

  const openDetachedAnswer = () => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("answer");
      return;
    }
    window.open("?view=answer", "second-chair-answer", "width=720,height=820,noopener,noreferrer");
  };

  const openMainWindow = () => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("main");
      return;
    }
    window.open("/", "second-chair-main", "width=1280,height=860,noopener,noreferrer");
  };

  const openMainSettings = () => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("main");
    }
    window.open("/?page=settings", "second-chair-main", "width=1280,height=860,noopener,noreferrer");
  };

  const dismissIntroGuide = () => {
    localStorage.setItem("interview-copilot-overlay-guide-seen", "true");
    setShowIntroGuide(false);
  };

  const hideOverlay = () => {
    void window.interviewCopilot?.windows?.hide?.("overlay");
  };

  const hideAllOverlays = () => {
    if (window.interviewCopilot?.windows?.hideOverlays) {
      void window.interviewCopilot.windows.hideOverlays();
      return;
    }
    hideOverlay();
  };

  const captureScreenshotPrompt = useCallback(async () => {
    if (!window.interviewCopilot?.capture?.screenshot) {
      setNotice("Desktop screenshot capture is only available in the Electron app.");
      return;
    }
    setIsCapturing(true);
    setPanel("answer");
    try {
      const capture = await window.interviewCopilot.capture.screenshot();
      const response = await fetch("/api/overlay/screenshot-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageData: capture.dataUrl,
          imageMimeType: "image/png",
          domain,
          format,
          language: state.session?.language || "English",
          prompt: `Analyze this ${domain} interview prompt and prepare a response.`
        })
      });
      if (!response.ok) {
        setNotice(await apiErrorMessage(response, "Screenshot prompt could not be processed."));
        return;
      }
      const payload = await response.json() as { state?: BootstrapState };
      if (payload.state) setState(payload.state);
      else await refresh();
      setNotice(`Captured ${capture.name}.`);
      openDetachedAnswer();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Screenshot capture failed.");
    } finally {
      setIsCapturing(false);
    }
  }, [domain, format, openDetachedAnswer, refresh, setNotice, setState, state.session?.language]);

  const toggleClickThrough = async () => {
    const next = !clickThrough;
    setClickThrough(next);
    try {
      await window.interviewCopilot?.windows?.setClickThrough?.("overlay", next);
      setNotice(next ? "Click-through enabled. Use the global overlay shortcut to restore interaction." : "Click-through disabled.");
    } catch {
      setNotice("Click-through is available only in the Electron app.");
      setClickThrough(false);
    }
  };

  useEffect(() => {
    const removeCaptureListener = window.interviewCopilot?.shortcuts?.on?.("shortcut:captureScreenshot", () => {
      void captureScreenshotPrompt();
    });
    const removeAnswerListener = window.interviewCopilot?.shortcuts?.on?.("shortcut:toggleAnswer", () => {
      void answerQuestion();
    });
    const removeToggleOverlayListener = window.interviewCopilot?.shortcuts?.on?.("shortcut:toggleOverlay", () => {
      setClickThrough(false);
    });
    const removeHideListener = window.interviewCopilot?.shortcuts?.on?.("shortcut:hideOverlays", () => {
      setClickThrough(false);
    });
    return () => {
      removeCaptureListener?.();
      removeAnswerListener?.();
      removeToggleOverlayListener?.();
      removeHideListener?.();
    };
  }, [answerQuestion, captureScreenshotPrompt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const manualSource: TranscriptEvent["source"] = listenEnabled ? "system" : "mic";

  return (
    <main className="overlay-shell" aria-label="Second Chair overlay">
      <header className="overlay-topbar">
        <div className="overlay-brand" aria-hidden="true">
          <GripHorizontal size={16} className="overlay-drag-handle" />
          <MonitorDot size={17} />
          <strong>Second Chair</strong>
        </div>
        <div className="overlay-status">
          <span className={listenEnabled || isCapturing ? "active" : ""}>
            <Radio size={12} />
            {listenEnabled || isCapturing ? "Live" : "Idle"}
          </span>
          <button type="button" title="Open detached answer" aria-label="Open detached answer" onClick={openDetachedAnswer}>
            <ExternalLink size={15} />
          </button>
          <button type="button" title="Hide all overlays" aria-label="Hide all overlays" onClick={hideAllOverlays}>
            <EyeOff size={15} />
          </button>
          <button type="button" title="Hide overlay" aria-label="Hide overlay" onClick={hideOverlay}>
            <X size={15} />
          </button>
        </div>
      </header>

      {showIntroGuide && (
        <section className="overlay-intro-guide" aria-label="Overlay quick start">
          <div className="overlay-intro-copy">
            <strong>Quick start</strong>
            <p>
              Second Chair defaults to NVIDIA. Add your API key in Settings, then use Listen for live captions and Answer when a question appears.
            </p>
          </div>
          <div className="overlay-intro-actions">
            <button className="ghost-action compact" type="button" onClick={openMainSettings}>
              Open Settings
            </button>
            <button className="icon-button" type="button" aria-label="Dismiss quick start" onClick={dismissIntroGuide}>
              <X size={15} />
            </button>
          </div>
        </section>
      )}

      <section className="overlay-controls" aria-label="Overlay controls">
        <TogglePill icon={<MonitorDot size={15} />} label="Listen" enabled={listenEnabled} onClick={() => setListenEnabled((value) => !value)} />
        <TogglePill icon={<Captions size={15} />} label={isCapturing ? "Capturing" : "Capture"} enabled={isCapturing} onClick={() => void captureScreenshotPrompt()} />
        <select aria-label="Domain" value={domain} onChange={(event) => setDomain(event.target.value as InterviewDomain)}>
          {domainOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select aria-label="Answer format" value={format} onChange={(event) => setFormat(event.target.value as AnswerFormat)}>
          {formatOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </section>

      <nav className="overlay-panels" aria-label="Overlay panel">
        <PanelButton active={panel === "answer"} icon={<Bot size={15} />} label="Answer" onClick={() => setPanel("answer")} />
        <PanelButton active={panel === "questions"} icon={<Sparkles size={15} />} label="Questions" onClick={() => setPanel("questions")} />
        <PanelButton active={panel === "transcript"} icon={<LayoutPanelLeft size={15} />} label="Transcript" onClick={() => setPanel("transcript")} />
        <PanelButton active={panel === "settings"} icon={<Settings2 size={15} />} label="Settings" onClick={() => setPanel("settings")} />
      </nav>

      {panel === "answer" && (
        <section className="overlay-panel-body">
          <div className="overlay-question">
            <span>{state.session?.role || "Current session"} {state.session?.company ? `at ${state.session.company}` : ""}</span>
            <strong>{activeQuestion?.rawText || "Waiting for a detected question"}</strong>
          </div>
          <div className="overlay-answer-card">
            <p>{activeAnswer?.stages.structured || "Generate or open the answer window when a question appears."}</p>
            {Boolean(activeAnswer?.stages.bullets.length) && (
              <ul>
                {activeAnswer?.stages.bullets.slice(0, 3).map((bullet) => <li key={bullet}>{bullet}</li>)}
              </ul>
            )}
          </div>
          <div className="overlay-action-row">
            <button className="primary-action compact" type="button" onClick={() => void answerQuestion()} disabled={isAnswering || !activeQuestion}>
              {isAnswering ? <Pause size={15} /> : <Play size={15} />}
              {isAnswering ? "Answering" : "Answer"}
            </button>
            <button className="ghost-action compact" type="button" onClick={() => void copyAnswer()} disabled={!activeAnswer}>
              <Copy size={15} />
              Copy
            </button>
          </div>
        </section>
      )}

      {panel === "questions" && (
        <section className="overlay-panel-body">
          <div className="overlay-list">
            {state.questionCards.filter((question) => question.status !== "dismissed").slice(-5).reverse().map((question) => (
              <article key={question.id} className="overlay-list-item">
                <strong>{question.rawText}</strong>
                <span>{question.type} - {Math.round(question.confidence * 100)}%</span>
              </article>
            ))}
            {!state.questionCards.length && <EmptyOverlay text="No questions detected yet." />}
          </div>
        </section>
      )}

      {panel === "transcript" && (
        <section className="overlay-panel-body">
          <div className="overlay-manual">
            <input
              aria-label="Add overlay transcript"
              placeholder={listenEnabled ? "Add interviewer text..." : "Add your line..."}
              value={manualText}
              onChange={(event) => setManualText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void appendTranscript(manualSource, manualText);
              }}
            />
            <button type="button" aria-label="Add transcript" onClick={() => void appendTranscript(manualSource, manualText)}>
              <Send size={15} />
            </button>
          </div>
          <div className="overlay-list">
            {latestTranscript.map((event) => (
              <article key={event.id} className="overlay-list-item">
                <strong>{event.source === "mic" ? "You" : "Interviewer"}</strong>
                <span>{event.text}</span>
              </article>
            ))}
            {interimBySource.system ? (
              <article className="overlay-list-item interim">
                <strong>Interviewer</strong>
                <span>{interimBySource.system}</span>
              </article>
            ) : null}
            {!latestTranscript.length && !interimBySource.system && <EmptyOverlay text="Transcript will appear here." />}
          </div>
        </section>
      )}

      {panel === "settings" && (
        <section className="overlay-panel-body">
          <div className="overlay-settings-intro">
            <strong>AI setup</strong>
            <p>NVIDIA is the default provider. Open Settings in the main app to paste your API key or switch to OpenAI, Gemini, or Claude.</p>
          </div>
          <ApiKeyGuideCard guide={DEFAULT_API_KEY_GUIDE} compact />
          <div className="overlay-settings-grid">
          <Fact label="Panel" value={panel} />
          <Fact label="Mode" value={mode} />
          <Fact label="Domain" value={domainOptions.find((option) => option.value === domain)?.label || domain} />
          <Fact label="Format" value={formatOptions.find((option) => option.value === format)?.label || format} />
          <Fact label="Docs" value={`${state.documents.filter((document) => document.status === "indexed").length} indexed`} />
        </div>
          <button className="ghost-action compact" type="button" onClick={openMainSettings}>
            <Settings2 size={15} />
            Open Settings
          </button>
          <button className="ghost-action compact" type="button" onClick={() => void refresh()}>
            <PanelTopOpen size={15} />
            Refresh latest state
          </button>
          <button className="ghost-action compact" type="button" aria-pressed={clickThrough} onClick={() => void toggleClickThrough()}>
            <MonitorDot size={15} />
            {clickThrough ? "Interaction off" : "Click-through"}
          </button>
        </section>
      )}

      {(notice || copyNotice) && <p className="overlay-notice" role="status">{copyNotice || notice}</p>}
    </main>
  );
}

function TogglePill({
  enabled,
  icon,
  label,
  onClick
}: {
  enabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`overlay-toggle ${enabled ? "active" : ""}`} type="button" aria-pressed={enabled} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function PanelButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} type="button" aria-pressed={active} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="overlay-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyOverlay({ text }: { text: string }) {
  return <div className="overlay-empty">{text}</div>;
}

export { OverlayApp };
