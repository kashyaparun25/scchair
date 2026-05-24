import type { ProviderSettings } from "../shared/domain";
import { resolveCapability } from "./providerRegistry";

export class DocumentEmbeddingError extends Error {
  constructor(message = "Document embedding failed.") {
    super(message);
    this.name = "DocumentEmbeddingError";
  }
}

export interface EmbeddingClient {
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  model: string;
}

export function createEmbeddingClient(_settings: ProviderSettings): EmbeddingClient | null {
  const resolved = resolveCapability("embeddings");
  if (!resolved.enabled || resolved.endpointId === "local") {
    return null;
  }

  if (resolved.adapterType === "openai-compatible-embeddings") {
    return createOpenAiCompatibleEmbeddingClient(resolved.model, resolved.apiKey, resolved.baseUrl);
  }

  if (resolved.adapterType === "gemini-embeddings") {
    return createGeminiEmbeddingClient(resolved.model, resolved.apiKey, resolved.baseUrl);
  }

  return null;
}

function createOpenAiCompatibleEmbeddingClient(model: string, apiKey: string, baseUrl: string): EmbeddingClient {
  const needsInputType = /embedqa|nemoretriever|nemotron-embed|e5-v5/i.test(model);
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  async function embed(input: string[], inputType?: "passage" | "query"): Promise<number[][]> {
    if (!input.length) return [];

    const body: Record<string, unknown> = {
      model,
      input,
      encoding_format: "float",
    };
    if (needsInputType && inputType) {
      body.input_type = inputType;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = await response.json() as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new DocumentEmbeddingError(json.error?.message || `Embeddings failed (${response.status}).`);
    }

    const rows = [...(json.data || [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    return rows.map((row) => row.embedding || []);
  }

  return {
    model,
    embedPassages: (texts) => embed(texts, needsInputType ? "passage" : undefined),
    embedQuery: async (text) => {
      const [vector] = await embed([text], needsInputType ? "query" : undefined);
      if (!vector?.length) throw new DocumentEmbeddingError("Query embedding was empty.");
      return vector;
    },
  };
}

function createGeminiEmbeddingClient(model: string, apiKey: string, baseUrl: string): EmbeddingClient {
  const modelId = model.startsWith("models/") ? model : `models/${model}`;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/${modelId}:batchEmbedContents`;

  async function embed(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[][]> {
    if (!texts.length) return [];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: modelId,
          content: { parts: [{ text }] },
          taskType,
        })),
      }),
    });

    const json = await response.json() as {
      embeddings?: Array<{ values?: number[] }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new DocumentEmbeddingError(json.error?.message || `Gemini embeddings failed (${response.status}).`);
    }

    return (json.embeddings || []).map((entry) => entry.values || []);
  }

  return {
    model,
    embedPassages: (texts) => embed(texts, "RETRIEVAL_DOCUMENT"),
    embedQuery: async (text) => {
      const [vector] = await embed([text], "RETRIEVAL_QUERY");
      if (!vector?.length) throw new DocumentEmbeddingError("Query embedding was empty.");
      return vector;
    },
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }

  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export async function embedInBatches(
  client: EmbeddingClient,
  texts: string[],
  batchSize = 16,
  mode: "passage" | "query" = "passage",
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const embedded = mode === "query"
      ? [await client.embedQuery(batch[0] || "")]
      : await client.embedPassages(batch);
    vectors.push(...embedded);
  }
  return vectors;
}
