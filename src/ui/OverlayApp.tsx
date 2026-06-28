import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeAudioCapture } from "./hooks/useRealtimeAudioCapture";
import type { ReactNode } from "react";
import {
  Captions,
  Copy,
  ExternalLink,
  EyeOff,
  GripHorizontal,
  Mic2,
  MonitorDot,
  Pause,
  Play,
  Radio
} from "lucide-react";
import type {
  AnswerDraft,
  AnswerFormat,
  DocumentSummary,
  QuestionCard,
  SessionSetup,
  TranscriptEvent
} from "../shared/domain";

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
  const [domain] = useState<InterviewDomain>("general");
  const [format] = useState<AnswerFormat>("technical");
  const [listenEnabled, setListenEnabled] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [clickThrough, setClickThrough] = useState(false);
  const [isAnswering, setIsAnswering] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    segmentTimer: ReturnType<typeof setInterval> | null;
  } | null>(null);
  const backendSttUnavailableRef = useRef(false);

  const activeQuestion = useMemo(() => latestQuestion(state.questionCards), [state.questionCards]);
  const activeAnswer = useMemo(() => {
    if (!activeQuestion) return null;
    return [...state.answerDrafts]
      .reverse()
      .find((answer) => answer.questionId === activeQuestion.id && answer.format === format)
      || state.answerDrafts.find((answer) => answer.questionId === activeQuestion.id)
      || null;
  }, [format, activeQuestion, state.answerDrafts]);
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

  const openDetachedAnswer = useCallback(() => {
    if (window.interviewCopilot?.windows?.show) {
      void window.interviewCopilot.windows.show("answer");
      return;
    }
    window.open("?view=answer", "second-chair-answer", "width=720,height=820,noopener,noreferrer");
  }, []);

  const hideOverlay = () => {
    void window.interviewCopilot?.windows?.hide?.("overlay");
  };

  const captureScreenshotPrompt = useCallback(async () => {
    if (!window.interviewCopilot?.capture?.screenshot) {
      setNotice("Desktop screenshot capture is only available in the Electron app.");
      return;
    }
    setIsCapturing(true);
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
      const result = await window.interviewCopilot?.stealth?.setClickThrough?.(next);
      if (typeof result?.clickThrough === "boolean") setClickThrough(result.clickThrough);
      setNotice(next ? "Click-through enabled. Use the global overlay shortcut to restore interaction." : "Click-through disabled.");
    } catch {
      setNotice("Click-through is available only in the Electron app.");
      setClickThrough(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void window.interviewCopilot?.stealth?.get?.().then((payload) => {
      if (!cancelled) setClickThrough(Boolean(payload.overlayClickThrough));
    }).catch(() => {
      // Browser preview does not expose desktop window controls.
    });
    const removeCaptureListener = window.interviewCopilot?.shortcuts?.on?.("shortcut:captureScreenshot", () => {
      void captureScreenshotPrompt();
    });
    const removeStealthListener = window.interviewCopilot?.shortcuts?.on?.("stealth:changed", (payload) => {
      const next = payload as { overlayClickThrough?: boolean } | undefined;
      if (typeof next?.overlayClickThrough === "boolean") setClickThrough(next.overlayClickThrough);
    });
    return () => {
      cancelled = true;
      removeCaptureListener?.();
      removeStealthListener?.();
    };
  }, [captureScreenshotPrompt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        </div>
      </header>

      <section className="overlay-controls" aria-label="Overlay controls">
        <TogglePill icon={<Mic2 size={15} />} label="Listen" enabled={listenEnabled} onClick={() => setListenEnabled((value) => !value)} />
        <TogglePill icon={<Captions size={15} />} label={isCapturing ? "Capturing" : "Capture"} enabled={isCapturing} onClick={() => void captureScreenshotPrompt()} />
        <button className="primary-action compact" type="button" onClick={() => void answerQuestion()} disabled={isAnswering || !activeQuestion}>
          {isAnswering ? <Pause size={15} /> : <Play size={15} />}
          {isAnswering ? "Answering" : "Answer"}
        </button>
        <button className="ghost-action compact" type="button" onClick={() => void copyAnswer()} disabled={!activeAnswer}>
          <Copy size={15} />
          Copy
        </button>
        <button className="ghost-action compact" type="button" onClick={hideOverlay}>
          <EyeOff size={15} />
          Hide
        </button>
        <button className="ghost-action compact" type="button" onClick={openDetachedAnswer}>
          <ExternalLink size={15} />
          Detach
        </button>
      </section>

      <section className="overlay-panel-body">
        <div className="overlay-question">
          <span>{state.session?.role || "Current question"} {state.session?.company ? `at ${state.session.company}` : ""}</span>
          <strong>{activeQuestion?.rawText || "Waiting for a detected question"}</strong>
        </div>
        <div className="overlay-answer-card">
          <p>{activeAnswer?.stages.structured || "Answer preview will appear here after you capture or answer a question."}</p>
          {Boolean(activeAnswer?.stages.bullets.length) && (
            <ul>
              {activeAnswer?.stages.bullets.slice(0, 3).map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
          )}
        </div>
        {interimBySource.system ? (
          <div className="overlay-empty">Listening: {interimBySource.system}</div>
        ) : null}
        <button className="ghost-action compact" type="button" aria-pressed={clickThrough} onClick={() => void toggleClickThrough()}>
          <MonitorDot size={15} />
          {clickThrough ? "Interaction off" : "Click-through"}
        </button>
      </section>

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

export { OverlayApp };
