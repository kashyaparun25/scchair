import type { ProviderSettings } from "../shared/domain";
import {
  cosineSimilarity,
  createEmbeddingClient,
  embedInBatches,
  type EmbeddingClient,
} from "./documentEmbeddings";
import type { RetrievedDocumentChunk } from "./repository";

const queryTermSynonyms: Record<string, string[]> = {
  rag: ["rag", "retrieval", "augmented", "generation", "vector", "embedding", "embeddings", "semantic", "retriever", "chunking"],
  llm: ["llm", "language", "model", "inference", "prompt", "prompts"],
  agent: ["agent", "agentic", "tool", "tools", "workflow", "orchestration"],
};

export async function searchDocumentChunksWithEmbeddings(
  query: string,
  chunks: RetrievedDocumentChunk[],
  embeddingsByChunkId: Map<string, number[]>,
  settings: ProviderSettings,
  limit = 4,
): Promise<RetrievedDocumentChunk[]> {
  if (!chunks.length) return [];

  const client = createEmbeddingClient(settings);
  if (client && embeddingsByChunkId.size > 0) {
    try {
      const queryVector = await client.embedQuery(query);
      const ranked = chunks
        .map((chunk) => {
          const embedding = embeddingsByChunkId.get(chunk.id);
          const semanticScore = embedding?.length ? cosineSimilarity(queryVector, embedding) : 0;
          const keywordScore = keywordMatchScore(query, chunk.text, chunk.category);
          const score = semanticScore * 0.85 + keywordScore * 0.15 + categoryBoost(
            chunk.category,
            expandQueryTerms(query),
            chunk.text.toLowerCase(),
          );
          return { ...chunk, score };
        })
        .filter((chunk) => chunk.score > 0.05)
        .sort((left, right) => right.score - left.score);

      if (ranked.length) return ranked.slice(0, limit);
    } catch (error) {
      console.warn("Embedding retrieval failed; falling back to keyword search.", error);
    }
  }

  return rankDocumentChunksByKeyword(query, chunks, limit);
}

export async function indexChunkEmbeddings(
  client: EmbeddingClient,
  chunks: RetrievedDocumentChunk[],
): Promise<Map<string, number[]>> {
  const vectors = await embedInBatches(client, chunks.map((chunk) => chunk.text), 16, "passage");
  const embeddings = new Map<string, number[]>();
  chunks.forEach((chunk, index) => {
    const vector = vectors[index];
    if (vector?.length) embeddings.set(chunk.id, vector);
  });
  return embeddings;
}

function rankDocumentChunksByKeyword(
  query: string,
  chunks: RetrievedDocumentChunk[],
  limit = 4,
): RetrievedDocumentChunk[] {
  const ranked = chunks
    .map((chunk) => ({ ...chunk, score: keywordMatchScore(query, chunk.text, chunk.category) }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score);

  if (ranked.length) return ranked.slice(0, limit);

  const resumeChunks = chunks.filter((chunk) => chunk.category === "resume");
  const fallbackPool = resumeChunks.length ? resumeChunks : chunks;
  return fallbackPool.slice(0, limit).map((chunk, index) => ({
    ...chunk,
    score: Math.max(0.1, 0.4 - index * 0.05),
  }));
}

function keywordMatchScore(query: string, text: string, category: RetrievedDocumentChunk["category"]): number {
  const queryTerms = expandQueryTerms(query);
  if (!queryTerms.size) return 0;

  const chunkTerms = importantTerms(text);
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (chunkTerms.has(term)) score += term.length > 6 ? 2 : 1;
    if (term.length >= 4 && lowerText.includes(term)) score += term.length >= 6 ? 4 : 2;
  }
  return score + categoryBoost(category, queryTerms, lowerText);
}

function categoryBoost(
  category: RetrievedDocumentChunk["category"],
  queryTerms: Set<string>,
  lowerText: string,
): number {
  const hasStrongTermMatch = [...queryTerms].some(
    (term) => term.length >= 4 && lowerText.includes(term),
  );
  if (hasStrongTermMatch) {
    if (category === "resume") return 0.15;
    if (category === "project-notes") return 0.2;
    return 0.1;
  }
  if (category === "resume") return 0.35;
  if (category === "job-description") return 0.2;
  return 0;
}

function expandQueryTerms(text: string): Set<string> {
  const terms = importantTerms(text);
  const expanded = new Set(terms);
  for (const term of terms) {
    for (const [key, synonyms] of Object.entries(queryTermSynonyms)) {
      if (term === key || synonyms.includes(term)) {
        synonyms.forEach((synonym) => expanded.add(synonym));
      }
    }
  }
  return expanded;
}

function importantTerms(text: string): Set<string> {
  const stopWords = new Set([
    "about", "after", "again", "also", "because", "been", "being", "could", "from", "have",
    "into", "that", "their", "there", "this", "through", "what", "when", "where", "which",
    "with", "would", "your", "you", "the", "and", "for", "are", "was", "were", "how", "can",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((term) => term.replace(/^-+|-+$/g, ""))
      .filter((term) => term.length > 2 && !stopWords.has(term)),
  );
}
