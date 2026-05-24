import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { DocumentSummary } from "../shared/domain";

type DocumentCategory = DocumentSummary["category"];

export interface CreateDocumentInput {
  id: string;
  name?: string;
  text?: string;
  category?: unknown;
}

export interface UploadDocumentInput {
  id: string;
  originalName: string;
  mimeType?: string;
  buffer: Buffer;
  category?: unknown;
}

export interface ExtractedDocumentText {
  text: string;
  format: "text" | "markdown" | "docx" | "pdf";
}

export interface IngestedDocument {
  document: DocumentSummary;
  text: string;
  format: ExtractedDocumentText["format"];
}

const defaultCategory: DocumentCategory = "project-notes";
const allowedCategories = new Set<DocumentCategory>([
  "resume",
  "job-description",
  "company-notes",
  "project-notes",
  "qa-bank",
  "meeting-brief"
]);

const textMimeTypes = new Set([
  "text/plain"
]);

const markdownMimeTypes = new Set([
  "text/markdown",
  "text/x-markdown",
  "application/markdown"
]);

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function createDocumentFromText(input: CreateDocumentInput): DocumentSummary {
  return createIngestedDocumentFromText(input).document;
}

export function createIngestedDocumentFromText(input: CreateDocumentInput): IngestedDocument {
  const text = String(input.text || "");
  return {
    document: {
      id: input.id,
      name: String(input.name || "Untitled document"),
      category: normalizeCategory(input.category),
      wordCount: countWords(text),
      status: "indexed"
    },
    text,
    format: "text"
  };
}

export async function createDocumentFromUpload(input: UploadDocumentInput): Promise<DocumentSummary> {
  return (await createIngestedDocumentFromUpload(input)).document;
}

export async function createIngestedDocumentFromUpload(input: UploadDocumentInput): Promise<IngestedDocument> {
  const extracted = await extractDocumentText(input.buffer, input.originalName, input.mimeType);

  return {
    document: {
      id: input.id,
      name: normalizeDocumentName(input.originalName || "Uploaded document"),
      category: normalizeCategory(input.category),
      wordCount: countWords(extracted.text),
      status: "indexed"
    },
    text: extracted.text,
    format: extracted.format
  };
}

export async function extractDocumentText(
  buffer: Buffer,
  fileName: string,
  mimeType = ""
): Promise<ExtractedDocumentText> {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".md" || extension === ".markdown" || markdownMimeTypes.has(mimeType)) {
    return { text: decodeTextBuffer(buffer), format: "markdown" };
  }

  if (extension === ".txt" || textMimeTypes.has(mimeType)) {
    return { text: decodeTextBuffer(buffer), format: "text" };
  }

  if (extension === ".docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, format: "docx" };
  }

  if (extension === ".pdf" || mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: result.text, format: "pdf" };
    } finally {
      await parser.destroy();
    }
  }

  throw new UnsupportedDocumentTypeError(fileName, mimeType);
}

export class UnsupportedDocumentTypeError extends Error {
  constructor(fileName: string, mimeType: string) {
    super(`Unsupported document type for "${fileName}"${mimeType ? ` (${mimeType})` : ""}.`);
    this.name = "UnsupportedDocumentTypeError";
  }
}

function decodeTextBuffer(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function normalizeCategory(category: unknown): DocumentCategory {
  return allowedCategories.has(category as DocumentCategory) ? category as DocumentCategory : defaultCategory;
}

function normalizeDocumentName(name: string): string {
  return path.basename(name).trim() || "Untitled document";
}
