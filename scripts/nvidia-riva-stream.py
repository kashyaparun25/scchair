#!/usr/bin/env python3
import json
import os
import signal
import sys

CHUNK_FRAMES = int(os.environ.get("NVIDIA_RIVA_ASR_CHUNK_FRAMES", "1600"))
_stop_requested = False


def emit(payload):
    print(json.dumps(payload), flush=True)


def request_stop(*_args):
    global _stop_requested
    _stop_requested = True


def stdin_audio_chunks(chunk_bytes):
    while not _stop_requested:
        data = sys.stdin.buffer.read(chunk_bytes)
        if not data:
            return
        yield data


def main():
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    api_key = os.environ.get("NVIDIA_API_KEY") or os.environ.get("NVIDIA_NIM_API_KEY")
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is required for NVIDIA Parakeet streaming ASR.")

    try:
        import riva.client
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Missing NVIDIA Riva Python client. Install it with: pip install -U nvidia-riva-client"
        ) from exc

    auth = riva.client.Auth(
        use_ssl=True,
        uri=os.environ.get("NVIDIA_RIVA_ASR_SERVER", "grpc.nvcf.nvidia.com:443"),
        metadata_args=[
            ["function-id", os.environ.get("NVIDIA_RIVA_ASR_FUNCTION_ID", "1598d209-5e27-4d3c-8079-4751568b1081")],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr_service = riva.client.ASRService(auth)
    config = riva.client.StreamingRecognitionConfig(
        config=riva.client.RecognitionConfig(
            encoding=riva.client.AudioEncoding.LINEAR_PCM,
            language_code=os.environ.get("NVIDIA_RIVA_ASR_LANGUAGE_CODE", "en-US"),
            model=os.environ.get("NVIDIA_RIVA_ASR_MODEL_NAME", ""),
            max_alternatives=1,
            enable_automatic_punctuation=os.environ.get("NVIDIA_RIVA_ASR_PUNCTUATION", "true").lower() != "false",
            audio_channel_count=1,
            sample_rate_hertz=16000,
        ),
        interim_results=True,
    )

    emit({"type": "ready"})
    chunk_bytes = CHUNK_FRAMES * 2
    for response in asr_service.streaming_response_generator(
        audio_chunks=stdin_audio_chunks(chunk_bytes),
        streaming_config=config,
    ):
        if _stop_requested:
            break
        for result in response.results:
            if not result.alternatives:
                continue
            text = result.alternatives[0].transcript.strip()
            if not text:
                continue
            emit({
                "type": "transcript",
                "text": text,
                "isFinal": bool(result.is_final),
                "speechFinal": bool(getattr(result, "is_final", False)),
            })


if __name__ == "__main__":
    try:
        main()
        emit({"type": "stopped"})
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        sys.exit(1)
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
