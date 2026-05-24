#!/usr/bin/env python3
import argparse
import json
import os
import sys
import wave


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe one audio file through NVIDIA Riva ASR.")
    parser.add_argument("--input-file", required=True)
    parser.add_argument("--server", default=os.environ.get("NVIDIA_RIVA_ASR_SERVER", "grpc.nvcf.nvidia.com:443"))
    parser.add_argument("--function-id", default=os.environ.get("NVIDIA_RIVA_ASR_FUNCTION_ID", "1598d209-5e27-4d3c-8079-4751568b1081"))
    parser.add_argument("--language-code", default=os.environ.get("NVIDIA_RIVA_ASR_LANGUAGE_CODE", "en-US"))
    parser.add_argument("--model", default=os.environ.get("NVIDIA_RIVA_ASR_MODEL_NAME", ""))
    parser.add_argument("--chunk-frames", type=int, default=int(os.environ.get("NVIDIA_RIVA_ASR_CHUNK_FRAMES", "1600")))
    parser.add_argument("--automatic-punctuation", action="store_true", default=os.environ.get("NVIDIA_RIVA_ASR_PUNCTUATION", "true").lower() != "false")
    return parser.parse_args()


def main():
    args = parse_args()
    api_key = os.environ.get("NVIDIA_API_KEY") or os.environ.get("NVIDIA_NIM_API_KEY")
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is required for NVIDIA Parakeet ASR.")

    try:
        import riva.client
    except ModuleNotFoundError as exc:
        raise RuntimeError("Missing NVIDIA Riva Python client. Install it with: pip install -U nvidia-riva-client") from exc

    auth = riva.client.Auth(
        use_ssl=True,
        uri=args.server,
        metadata_args=[
            ["function-id", args.function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr_service = riva.client.ASRService(auth)
    config = riva.client.StreamingRecognitionConfig(
        config=riva.client.RecognitionConfig(
            encoding=riva.client.AudioEncoding.LINEAR_PCM,
            language_code=args.language_code,
            model=args.model,
            max_alternatives=1,
            enable_automatic_punctuation=args.automatic_punctuation,
            audio_channel_count=1,
            sample_rate_hertz=16000,
        ),
        interim_results=False,
    )

    transcripts = []
    for response in asr_service.streaming_response_generator(audio_chunks=audio_chunks(args.input_file, args.chunk_frames), streaming_config=config):
        for result in response.results:
            if result.alternatives:
                transcripts.append(result.alternatives[0].transcript)

    print(json.dumps({"text": " ".join(part.strip() for part in transcripts if part.strip())}))


def audio_chunks(input_file, chunk_frames):
    with wave.open(input_file, "rb") as wav_file:
        while True:
            chunk = wav_file.readframes(chunk_frames)
            if not chunk:
                break
            yield chunk


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
