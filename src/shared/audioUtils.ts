export const STREAMING_SAMPLE_RATE = 16000;

export function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accum += buffer[index];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

export function floatTo16BitPcm(float32Buffer: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(float32Buffer.length);

  for (let index = 0; index < float32Buffer.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Buffer[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcm.buffer;
}

export function streamingWebSocketUrl(endpoint: string): string {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    return endpoint;
  }

  const desktopApiBase = (window as unknown as { __SECOND_CHAIR_API_BASE_URL__?: string }).__SECOND_CHAIR_API_BASE_URL__;
  if (desktopApiBase) {
    const wsBase = desktopApiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/+$/, "");
    return `${wsBase}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}
