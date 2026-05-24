import { useCallback, useEffect, useRef, useState } from "react";
import type { QuestionCard, TranscriptEvent } from "../../shared/domain";
import { floatTo16BitPcm, downsampleBuffer, STREAMING_SAMPLE_RATE, streamingWebSocketUrl } from "../../shared/audioUtils";

export interface StreamingSttCapabilities {
  available: boolean;
  provider: "deepgram" | "nvidia-nim" | "openai" | null;
  model: string | null;
  transport: "websocket-pcm";
  sampleRate: number;
  endpoint: string;
}

export interface RealtimeTranscriptPayload {
  event: TranscriptEvent;
  questions: QuestionCard[];
}

interface SourceCaptureState {
  socket: WebSocket;
  stream: MediaStream;
  captureStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  silentGain: GainNode;
}

interface UseRealtimeAudioCaptureOptions {
  micEnabled: boolean;
  systemEnabled: boolean;
  onTranscriptUpdate: (payload: RealtimeTranscriptPayload) => void;
  onInterimTranscript?: (source: TranscriptEvent["source"], text: string) => void;
  onStatus?: (message: string) => void;
  onUnavailable?: () => void;
}

async function getSystemAudioStream(): Promise<{ stream: MediaStream; captureStream: MediaStream }> {
  const captureStream = await navigator.mediaDevices.getDisplayMedia({
    audio: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    },
    video: true,
    systemAudio: "include",
  } as DisplayMediaStreamOptions);

  const audioTracks = captureStream.getAudioTracks();
  if (!audioTracks.length) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error("No system audio track was shared.");
  }

  captureStream.getVideoTracks().forEach((track) => {
    track.enabled = false;
  });

  return {
    stream: new MediaStream(audioTracks),
    captureStream,
  };
}

async function getMicAudioStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    },
  });
}

export function useRealtimeAudioCapture({
  micEnabled,
  systemEnabled,
  onTranscriptUpdate,
  onInterimTranscript,
  onStatus,
  onUnavailable,
}: UseRealtimeAudioCaptureOptions) {
  const [capabilities, setCapabilities] = useState<StreamingSttCapabilities | null>(null);
  const [interimBySource, setInterimBySource] = useState<Partial<Record<TranscriptEvent["source"], string>>>({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletReadyRef = useRef<Promise<void> | null>(null);
  const sourceStatesRef = useRef<Partial<Record<TranscriptEvent["source"], SourceCaptureState>>>({});
  const callbacksRef = useRef({ onTranscriptUpdate, onInterimTranscript, onStatus, onUnavailable });
  callbacksRef.current = { onTranscriptUpdate, onInterimTranscript, onStatus, onUnavailable };

  useEffect(() => {
    void fetch("/api/audio/streaming")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload) setCapabilities(payload as StreamingSttCapabilities);
      })
      .catch(() => undefined);
  }, []);

  const ensureAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (!workletReadyRef.current) {
      workletReadyRef.current = audioContextRef.current.audioWorklet.addModule("/audio-worklet.js");
    }

    await workletReadyRef.current;
    return audioContextRef.current;
  }, []);

  const stopSource = useCallback((source: TranscriptEvent["source"]) => {
    const current = sourceStatesRef.current[source];
    if (!current) return;

    if (current.socket.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: "stop" }));
      current.socket.close();
    }

    current.sourceNode.disconnect();
    current.workletNode.disconnect();
    current.silentGain.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());
    current.captureStream?.getTracks().forEach((track) => track.stop());
    delete sourceStatesRef.current[source];
    setInterimBySource((previous) => {
      const next = { ...previous };
      delete next[source];
      return next;
    });
  }, []);

  const startSource = useCallback(async (source: TranscriptEvent["source"]) => {
    if (!capabilities?.available) {
      callbacksRef.current.onUnavailable?.();
      return false;
    }
    if (sourceStatesRef.current[source]) return true;

    try {
      const audioContext = await ensureAudioContext();
      const sampleRate = capabilities.sampleRate || STREAMING_SAMPLE_RATE;
      const streamBundle = source === "mic"
        ? { stream: await getMicAudioStream(), captureStream: null }
        : await getSystemAudioStream();

      const { stream, captureStream } = streamBundle;
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        captureStream?.getTracks().forEach((track) => track.stop());
        callbacksRef.current.onStatus?.(
          source === "system" ? "No system audio track was shared." : "No microphone audio track was available.",
        );
        return false;
      }

      const socket = new WebSocket(streamingWebSocketUrl(capabilities.endpoint));
      socket.binaryType = "arraybuffer";

      const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      const sourceNode = audioContext.createMediaStreamSource(stream);

      sourceNode.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioContext.destination);

      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const downsampled = downsampleBuffer(event.data, audioContext.sampleRate, sampleRate);
        socket.send(floatTo16BitPcm(downsampled));
      };

      sourceStatesRef.current[source] = {
        socket,
        stream,
        captureStream,
        sourceNode,
        workletNode,
        silentGain,
      };

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "start", source, sampleRate }));
      };

      socket.onmessage = (event) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (payload.type === "ready") {
          callbacksRef.current.onStatus?.(
            source === "mic" ? "Mic streaming transcription is active." : "System audio streaming transcription is active.",
          );
          return;
        }

        if (payload.type === "error") {
          callbacksRef.current.onStatus?.(String(payload.message || "Streaming transcription failed."));
          return;
        }

        if (payload.type === "transcript" && typeof payload.text === "string") {
          const text = payload.text.trim();
          if (!text) return;

          if (payload.isFinal) {
            setInterimBySource((previous) => {
              const next = { ...previous };
              delete next[source];
              return next;
            });
          } else {
            setInterimBySource((previous) => ({ ...previous, [source]: text }));
            callbacksRef.current.onInterimTranscript?.(source, text);
          }
          return;
        }

        if (payload.type === "session_update" && payload.event && payload.questions) {
          callbacksRef.current.onTranscriptUpdate({
            event: payload.event as TranscriptEvent,
            questions: payload.questions as QuestionCard[],
          });
        }
      };

      socket.onclose = () => {
        stopSource(source);
      };

      audioTracks.forEach((track) => {
        track.addEventListener("ended", () => {
          stopSource(source);
          callbacksRef.current.onStatus?.(
            source === "mic" ? "Mic capture ended." : "System audio capture ended.",
          );
        });
      });

      return true;
    } catch (error) {
      callbacksRef.current.onStatus?.(error instanceof Error ? error.message : "Audio capture could not start.");
      stopSource(source);
      return false;
    }
  }, [capabilities, ensureAudioContext, stopSource]);

  useEffect(() => {
    if (!capabilities?.available) return undefined;

    if (micEnabled) void startSource("mic");
    else stopSource("mic");

    if (systemEnabled) void startSource("system");
    else stopSource("system");

    return () => {
      stopSource("mic");
      stopSource("system");
    };
  }, [capabilities?.available, micEnabled, systemEnabled, startSource, stopSource]);

  useEffect(() => () => {
    stopSource("mic");
    stopSource("system");
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    workletReadyRef.current = null;
  }, [stopSource]);

  return {
    streamingAvailable: Boolean(capabilities?.available),
    streamingProvider: capabilities?.provider || null,
    interimBySource,
  };
}
