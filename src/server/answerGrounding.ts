import type { QuestionCard } from "../shared/domain";
import type { RetrievedDocumentChunk } from "./repository";

export type GroundingStance = "direct" | "partial" | "inferred" | "absent";

export interface FocusTermEvidence {
  term: string;
  level: "direct" | "indirect" | "absent";
  chunkId?: string;
  documentName?: string;
  excerpt?: string;
}

export interface GroundingAnalysis {
  focusTerms: string[];
  stance: GroundingStance;
  primaryChunkId?: string;
  termEvidence: FocusTermEvidence[];
  instruction: string;
  rankedChunks: RetrievedDocumentChunk[];
}

const techFocusTerms = [
  "pytorch", "tensorflow", "keras", "jax", "scikit-learn", "sklearn",
  "langchain", "langgraph", "crewai", "crew ai", "llamaindex", "openai",
  "pinecone", "weaviate", "chromadb", "postgres", "postgresql", "redis",
  "kubernetes", "docker", "spark", "kafka", "react", "typescript", "python",
  "java", "rust", "golang", "aws", "gcp", "azure", "snowflake", "dbt",
  "huggingface", "transformers", "sentence-transformers", "sentence transformers",
  "rag", "llm", "fine-tuning", "fine tuning", "embeddings", "vector",
];

const indirectRelations: Record<string, string[]> = {
  pytorch: ["langchain", "langgraph", "huggingface", "transformers", "tensorflow", "keras"],
  tensorflow: ["keras", "huggingface", "transformers"],
  langchain: ["openai", "llm", "embeddings", "rag"],
  crewai: ["langchain", "agent", "llm"],
};

export function extractFocusTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();

  for (const term of techFocusTerms) {
    if (lower.includes(term)) found.add(term);
  }

  if (/\bmachine learning\b|\bml framework|\bml tool|\bdeep learning\b/i.test(lower)) {
    ["langchain", "crewai", "langgraph", "pytorch", "tensorflow", "sklearn", "rag", "llm", "embeddings"].forEach((term) => found.add(term));
  }
  if (/\b(other|any other)\b.*\b(tool|framework|system|platform)s?\b/i.test(lower)) {
    ["langchain", "crewai", "langgraph", "fastapi", "pinecone", "postgresql", "gemini", "openai", "claude"].forEach((term) => found.add(term));
  }
  if (/\b(support|customer|ticket|crm|helpdesk)\b/i.test(lower)) {
    ["zendesk", "salesforce", "freshdesk", "intercom", "servicenow"].forEach((term) => found.add(term));
  }

  const properNounMatches = text.match(/\b[A-Z][A-Za-z0-9+.#-]{2,}\b/g) || [];
  for (const match of properNounMatches) {
    const normalized = match.toLowerCase();
    if (!["the", "and", "for", "how", "what", "when", "where", "who"].includes(normalized)) {
      found.add(normalized);
    }
  }

  const usePattern = lower.match(/\b(?:use|used|using|with|in)\s+([a-z0-9][a-z0-9+.#-]{2,})/g) || [];
  for (const phrase of usePattern) {
    const term = phrase.replace(/\b(?:use|used|using|with|in)\s+/, "").trim();
    if (term.length >= 3) found.add(term);
  }

  return [...found];
}

export function focusTermsForRetrieval(question: QuestionCard): string {
  const terms = extractFocusTerms(`${question.rawText} ${question.framedQuestion}`);
  return terms.join(" ");
}

export function analyzeAndRankChunks(
  question: QuestionCard,
  chunks: RetrievedDocumentChunk[],
): GroundingAnalysis {
  const focusTerms = extractFocusTerms(`${question.rawText} ${question.framedQuestion}`);
  const termEvidence = focusTerms.map((term) => classifyTermEvidence(term, chunks));
  const rankedChunks = rerankChunks(chunks, focusTerms, termEvidence);
  const stance = deriveStance(termEvidence, rankedChunks);
  const primaryChunkId = rankedChunks[0]?.id;

  return {
    focusTerms,
    stance,
    primaryChunkId,
    termEvidence,
    rankedChunks,
    instruction: buildGroundingInstruction(question, focusTerms, termEvidence, stance, rankedChunks),
  };
}

function classifyTermEvidence(term: string, chunks: RetrievedDocumentChunk[]): FocusTermEvidence {
  for (const chunk of chunks) {
    if (termMatchesText(term, chunk.text)) {
      return {
        term,
        level: "direct",
        chunkId: chunk.id,
        documentName: chunk.documentName,
        excerpt: bestExcerpt(chunk.text, term),
      };
    }
  }

  const related = indirectRelations[term] || [];
  for (const chunk of chunks) {
    const lower = chunk.text.toLowerCase();
    if (related.some((relatedTerm) => lower.includes(relatedTerm))) {
      return {
        term,
        level: "indirect",
        chunkId: chunk.id,
        documentName: chunk.documentName,
        excerpt: bestExcerpt(chunk.text, related.find((relatedTerm) => lower.includes(relatedTerm)) || term),
      };
    }
  }

  return { term, level: "absent" };
}

function rerankChunks(
  chunks: RetrievedDocumentChunk[],
  focusTerms: string[],
  termEvidence: FocusTermEvidence[],
): RetrievedDocumentChunk[] {
  const directChunkIds = new Set(
    termEvidence.filter((item) => item.level === "direct" && item.chunkId).map((item) => item.chunkId!),
  );

  const scored = chunks.map((chunk) => {
    let score = chunk.score || 0;
    const lower = chunk.text.toLowerCase();

    for (const term of focusTerms) {
      if (termMatchesText(term, chunk.text)) score += 12;
      else {
        const related = indirectRelations[term] || [];
        if (related.some((relatedTerm) => lower.includes(relatedTerm))) score += 2;
      }
    }

    if (directChunkIds.has(chunk.id)) score += 8;

    return { chunk, score };
  });

  return scored
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({ ...entry.chunk, score: entry.score }));
}

function deriveStance(termEvidence: FocusTermEvidence[], chunks: RetrievedDocumentChunk[]): GroundingStance {
  if (!termEvidence.length) {
    const topScore = chunks[0]?.score || 0;
    if (topScore >= 4) return "partial";
    if (chunks.length > 0) return "inferred";
    return "absent";
  }
  const directCount = termEvidence.filter((item) => item.level === "direct").length;
  const absentCount = termEvidence.filter((item) => item.level === "absent").length;

  if (directCount === termEvidence.length) return "direct";
  if (directCount > 0 && absentCount === 0) return "partial";
  if (directCount > 0) return "partial";
  if (termEvidence.some((item) => item.level === "indirect")) return "inferred";
  if (chunks.length > 0 && (chunks[0]?.score || 0) >= 3) return "inferred";
  return "absent";
}

function buildGroundingInstruction(
  question: QuestionCard,
  focusTerms: string[],
  termEvidence: FocusTermEvidence[],
  stance: GroundingStance,
  rankedChunks: RetrievedDocumentChunk[],
): string {
  const lines = [
    "Evidence discipline (mandatory):",
    "- Answer ONLY from retrievedContext excerpts. Pick the project/story where the asked skill is explicitly mentioned.",
    "- Prefer the best-matching experience (work, internship, or academic) — not always the most recent job.",
    "- Never claim direct hands-on use of a tool unless that exact tool appears in the excerpt for that project.",
    '- Do NOT say you "used X indirectly through Y" or "under the hood" unless the excerpt states you configured or built with X.',
    "- Do not invent metrics, team sizes, model names, or libraries absent from context.",
  ];

  if (focusTerms.length) {
    lines.push(`- Question focus terms: ${focusTerms.join(", ")}.`);
    for (const evidence of termEvidence) {
      if (evidence.level === "direct") {
        lines.push(`- DIRECT evidence for "${evidence.term}" in ${evidence.documentName}: "${evidence.excerpt}". Lead with this story.`);
      } else if (evidence.level === "indirect") {
        lines.push(`- "${evidence.term}" is NOT directly stated; only related tools appear (${evidence.documentName}). Do not claim direct ${evidence.term} use for that project.`);
      } else {
        lines.push(`- No evidence for "${evidence.term}" in uploaded documents. Be honest; do not fabricate direct experience.`);
      }
    }
  }

  if (stance === "absent" || termEvidence.some((item) => item.level === "absent")) {
    lines.push(
      "- If a focus term lacks direct evidence: say so clearly, then either (a) pivot to a documented example where it does appear, or (b) describe adjacent documented experience without overstating.",
      '- Acceptable: "I haven\'t used PyTorch in that production role — there I used embeddings via API — but in my [documented project] I did..."',
      '- Acceptable: "That specific stack isn\'t on my resume; closest documented experience is..."',
    );
  }

  if (stance === "partial" && rankedChunks.length > 1) {
    lines.push("- Multiple contexts may apply. Use the excerpt that directly mentions the asked skill, even if it is an earlier academic project.");
  }

  if (question.type === "resume" || question.type === "technical") {
    lines.push("- Separate project goal from tools used. State what the project achieved, then only the tools evidenced in that same excerpt.");
  }

  return lines.join("\n");
}

function termMatchesText(term: string, text: string): boolean {
  const lower = text.toLowerCase();
  const normalized = term.toLowerCase();
  if (lower.includes(normalized)) return true;
  const compact = normalized.replace(/[\s-]+/g, "");
  return lower.replace(/[\s-]+/g, "").includes(compact);
}

function bestExcerpt(text: string, term: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 12);
  const match = sentences.find((sentence) => termMatchesText(term, sentence));
  const chosen = match || sentences[0] || text;
  return chosen.trim().slice(0, 240);
}

export function groundingRiskNote(analysis: GroundingAnalysis): string {
  if (analysis.stance === "direct") {
    return "Grounding: direct document evidence for the asked skill. Stay tied to the cited project.";
  }
  if (analysis.stance === "partial") {
    const missing = analysis.termEvidence.filter((item) => item.level === "absent").map((item) => item.term);
    return missing.length
      ? `Grounding: partial evidence. No direct proof for: ${missing.join(", ")}. Stay consistent with prior session answers.`
      : "Grounding: document evidence found. Stay consistent with prior session answers.";
  }
  if (analysis.stance === "inferred") {
    return "Grounding: related context found. Build on prior session answers; add new detail, don't repeat.";
  }
  return "Grounding: thin evidence. Be honest, stay consistent with what you already said in this interview.";
}
