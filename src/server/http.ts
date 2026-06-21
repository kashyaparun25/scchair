import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnswerDraft,
  AnswerFormat,
  QuestionCard,
  ProviderSettings,
  SessionSetup,
  TranscriptEvent,
  VoiceProfile,
} from "../shared/domain";
import {
  answerFormats,
  responsePersonas,
} from "../shared/domain";
import { detectQuestionFromText } from "./questionDetection";
import {
  AnswerGenerationError,
  generateAnswerDraft,
  streamAnswerDraft
} from "./aiAnswerGeneration";
import {
  createIngestedDocumentFromText,
  createIngestedDocumentFromUpload,
  UnsupportedDocumentTypeError
} from "./documentIngestion";
import { DocumentEmbeddingError } from "./documentEmbeddings";
import { buildProviderAdapters } from "./providerSettings";
import { getProviderSettings, initAppConfigStore, patchAppConfig, patchProviderSettings, toPublicAppConfig } from "./appConfigStore";
import { resolveCapability } from "./providerRegistry";
import { createSqliteRepository } from "./repository";
import type { RetrievedDocumentChunk } from "./repository";
import {
  createConfiguredSpeechToTextAdapter,
  SpeechToTextTranscriptionError,
  SpeechToTextUnavailableError
} from "./speechToText";
import { generateScreenshotPromptAnswer } from "./screenshotPrompt";
import { attachStreamingTranscriptionServer } from "./streamingTranscription";
import { appendTranscriptAndDetect } from "./transcriptPipeline";
import {
  formatConversationForPrompt,
  resolveQuestionAtAnswerTime,
} from "./conversationContext";
import {
  analyzeAndRankChunks,
  focusTermsForRetrieval,
} from "./answerGrounding";
import {
  buildInterviewContinuity,
  buildPriorAnswerHistory,
} from "./interviewMemory";
import { runtimeEnv } from "./runtimeEnv";
import { resolveStreamingSttCapabilities } from "./streamingStt";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = runtimeEnv("DATA_DIR") || path.resolve(__dirname, "../../.local-data");
initAppConfigStore(dataDir);
const stateFile = path.join(dataDir, "state.json");
const sqliteFile = path.join(dataDir, "state.sqlite");
const port = Number(process.env.API_PORT || 5180);
const repository = createSqliteRepository({ dbPath: sqliteFile, legacyStateFile: stateFile });

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function safeFileName(title: string): string {
  return (title || "interview-session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function renderSessionMarkdown(state: ReturnType<typeof repository.snapshot>): string {
  const session = state.session;
  if (!session) return "# Interview Session\n\nNo active session.";
  const lines = [
    `# ${session.title}`,
    "",
    `- Mode: ${session.mode}`,
    `- Role: ${session.role || "Not set"}`,
    `- Company: ${session.company || "Not set"}`,
    `- Round: ${session.round}`,
    `- Meeting topic: ${session.meetingTopic || "Not set"}`,
    `- Meeting audience: ${session.meetingAudience || "Not set"}`,
    `- Meeting goal: ${session.meetingGoal || "Not set"}`,
    `- Documents: ${state.documents.length}`,
    `- Questions: ${state.questionCards.length}`,
    "",
    "## Questions And Answers",
    ""
  ];

  for (const question of state.questionCards) {
    const answer = state.answerDrafts.find((candidate) => candidate.questionId === question.id);
    lines.push(`### ${question.framedQuestion}`, "", `Type: ${question.type} | Status: ${question.status}`, "");
    if (answer) {
      lines.push(answer.stages.structured, "");
      for (const bullet of answer.stages.bullets) lines.push(`- ${bullet}`);
      if (answer.stages.sources.length) lines.push("", `Sources: ${answer.stages.sources.join(", ")}`);
      lines.push("", answer.stages.risk, "");
    } else {
      lines.push("_No answer generated._", "");
    }
  }

  lines.push("## Transcript", "");
  for (const event of state.transcriptEvents) {
    lines.push(`- ${new Date(event.timestamp).toISOString()} [${event.source}] ${event.text}`);
  }
  return `${lines.join("\n")}\n`;
}

class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      status: error.status,
      requestId: res.locals.requestId
    }
  });
}

const app = express();
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024
  }
});
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});
const parseRawAudio = express.raw({
  limit: "25mb",
  type: ["audio/*", "application/octet-stream"]
});

app.use((req, res, next) => {
  const requestId = makeId("req");
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});
app.use(express.json({ limit: "20mb" }));

app.get("/api/bootstrap", (_req, res) => {
  const documentIndex = repository.getDocumentIndexStatus();
  const snapshot = repository.snapshot();
  const statusById = new Map(documentIndex.documents.map((document) => [document.id, document.status]));
  res.json({
    ...snapshot,
    documents: snapshot.documents.map((document) => ({
      ...document,
      status: statusById.get(document.id) ?? document.status,
    })),
    documentIndex,
  });
});

app.get("/api/profiles", (_req, res) => {
  res.json({
    activeProfile: repository.getActiveProfile(),
    profiles: repository.listProfiles(),
  });
});

app.post("/api/profiles", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    sendApiError(res, new ApiError(400, "PROFILE_NAME_REQUIRED", "Profile name is required."));
    return;
  }
  const profile = repository.createProfile({ name });
  res.status(201).json({
    profile,
    activeProfile: repository.getActiveProfile(),
    profiles: repository.listProfiles(),
  });
});

app.post("/api/profiles/:id/select", (req, res) => {
  const profile = repository.selectProfile(req.params.id);
  if (!profile) {
    sendApiError(res, new ApiError(404, "PROFILE_NOT_FOUND", "Profile not found."));
    return;
  }
  res.json({
    activeProfile: profile,
    profiles: repository.listProfiles(),
    state: repository.snapshot(),
  });
});

app.get("/api/audit-events", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  res.json(repository.listAuditEvents(limit));
});

function latestBy<T>(items: T[], timestamp: (item: T) => number): T | null {
  return items.reduce<T | null>((latest, item) => {
    if (!latest || timestamp(item) >= timestamp(latest)) return item;
    return latest;
  }, null);
}

function latestOverlayState() {
  const state = repository.snapshot();
  const latestQuestion = latestBy(state.questionCards, (question) => question.createdAt);
  const answerForLatestQuestion = latestQuestion
    ? state.answerDrafts.find((answer) => answer.questionId === latestQuestion.id) || null
    : null;
  const latestAnswerDraft = latestBy(state.answerDrafts, (answer) => {
    const question = state.questionCards.find((candidate) => candidate.id === answer.questionId);
    return question?.createdAt || 0;
  });
  return {
    ...state,
    latest: {
      transcriptEvent: latestBy(state.transcriptEvents, (event) => event.timestamp),
      question: latestQuestion,
      answer: answerForLatestQuestion || latestAnswerDraft,
      answerForLatestQuestion,
      answerDraft: latestAnswerDraft,
    },
    overlay: {
      serverTime: Date.now(),
      imagePromptAvailable: resolveCapability("llm").adapterType === "openai-compatible-chat"
        && resolveCapability("llm").enabled,
    },
  };
}

app.get("/api/latest-state", (_req, res) => {
  res.json(latestOverlayState());
});

app.get("/api/overlay/latest-state", (_req, res) => {
  res.json(latestOverlayState());
});

app.get("/api/sessions/history", (_req, res) => {
  res.json(repository.listSessionArchives());
});

function buildSessionTitle(role = "", company = ""): string {
  const trimmedRole = role.trim();
  const trimmedCompany = company.trim();
  if (trimmedRole && trimmedCompany) return `${trimmedRole} @ ${trimmedCompany}`;
  if (trimmedRole) return trimmedRole;
  return "Interview session";
}

function buildMeetingTitle(topic = "", audience = ""): string {
  const trimmedTopic = topic.trim();
  const trimmedAudience = audience.trim();
  if (trimmedTopic && trimmedAudience) return `${trimmedTopic} with ${trimmedAudience}`;
  if (trimmedTopic) return trimmedTopic;
  return "Meeting session";
}

function isVoiceProfile(value: unknown): value is VoiceProfile {
  return typeof value === "string" && responsePersonas.includes(value as VoiceProfile);
}

function isAnswerFormat(value: unknown): value is AnswerFormat {
  return typeof value === "string" && answerFormats.includes(value as AnswerFormat);
}

function normalizeAnswerFormat(value: unknown): AnswerFormat | undefined {
  return isAnswerFormat(value) ? value : undefined;
}

function mergeSessionInput(existing: SessionSetup | null, input: Record<string, unknown>): SessionSetup {
  const role = String(input.role ?? existing?.role ?? "");
  const company = String(input.company ?? existing?.company ?? "");
  const mode = input.mode === "meeting" ? "meeting" : "interview";
  const meetingTopic = String(input.meetingTopic ?? existing?.meetingTopic ?? "");
  const meetingAudience = String(input.meetingAudience ?? existing?.meetingAudience ?? "");
  return {
    id: existing?.id || makeId("session"),
    mode,
    title: String(input.title || (mode === "meeting" ? buildMeetingTitle(meetingTopic, meetingAudience) : buildSessionTitle(role, company))),
    role,
    company,
    round: (input.round as SessionSetup["round"]) || existing?.round || "hiring-manager",
    seniority: String(input.seniority ?? existing?.seniority ?? ""),
    meetingTopic,
    meetingAudience,
    meetingGoal: String(input.meetingGoal ?? existing?.meetingGoal ?? ""),
    meetingNotes: String(input.meetingNotes ?? existing?.meetingNotes ?? ""),
    responseStyle: (input.responseStyle as SessionSetup["responseStyle"]) || existing?.responseStyle || "balanced",
    language: String(input.language ?? existing?.language ?? "English"),
    voiceProfile: isVoiceProfile(input.voiceProfile) ? input.voiceProfile : existing?.voiceProfile || "staff-engineer",
    customVoice: String(input.customVoice ?? existing?.customVoice ?? ""),
    answerFormat: isAnswerFormat(input.answerFormat) ? input.answerFormat : existing?.answerFormat || "technical",
    documents: repository.listDocuments(),
  };
}

app.post("/api/sessions", (req, res) => {
  const session = mergeSessionInput(repository.getSession(), req.body || {});
  res.status(201).json(repository.saveSession(session));
});

app.patch("/api/sessions/current", (req, res) => {
  const existing = repository.getSession();
  if (!existing) {
    sendApiError(res, new ApiError(404, "SESSION_NOT_FOUND", "No active session."));
    return;
  }
  const session = mergeSessionInput(existing, { ...existing, ...(req.body || {}) });
  res.json(repository.saveSession(session));
});

app.post("/api/sessions/start", (req, res) => {
  const input = req.body?.session || req.body || {};
  const existingSession = repository.getSession();
  const hasLiveData = repository.listTranscriptEvents().length > 0
    || repository.listQuestions().length > 0
    || repository.listAnswerDrafts().length > 0;

  if (req.body?.archive !== false && existingSession && hasLiveData) {
    repository.archiveCurrentSession(makeId("archive"));
  }

  repository.clearLiveSessionData();

  const session = mergeSessionInput(null, {
    ...input,
    id: makeId("session"),
    title: input.title || (
      input.mode === "meeting"
        ? buildMeetingTitle(String(input.meetingTopic || existingSession?.meetingTopic || ""), String(input.meetingAudience || existingSession?.meetingAudience || ""))
        : buildSessionTitle(String(input.role || existingSession?.role || ""), String(input.company || existingSession?.company || ""))
    ),
    role: input.role ?? existingSession?.role ?? "",
    company: input.company ?? existingSession?.company ?? "",
    round: input.round ?? existingSession?.round ?? "hiring-manager",
    seniority: input.seniority ?? existingSession?.seniority ?? "",
    meetingTopic: input.meetingTopic ?? existingSession?.meetingTopic ?? "",
    meetingAudience: input.meetingAudience ?? existingSession?.meetingAudience ?? "",
    meetingGoal: input.meetingGoal ?? existingSession?.meetingGoal ?? "",
    meetingNotes: input.meetingNotes ?? existingSession?.meetingNotes ?? "",
    responseStyle: input.responseStyle ?? existingSession?.responseStyle ?? "balanced",
    language: input.language ?? existingSession?.language ?? "English",
    voiceProfile: input.voiceProfile ?? existingSession?.voiceProfile ?? "staff-engineer",
    customVoice: input.customVoice ?? existingSession?.customVoice ?? "",
    answerFormat: input.answerFormat ?? existingSession?.answerFormat ?? "technical",
  });

  repository.saveSession(session);
  res.status(201).json(repository.snapshot());
});

app.post("/api/sessions/archive", (_req, res) => {
  const archived = repository.archiveCurrentSession(makeId("archive"));
  if (!archived) {
    sendApiError(res, new ApiError(400, "SESSION_ARCHIVE_UNAVAILABLE", "No active session to archive."));
    return;
  }
  res.status(201).json(archived);
});

app.get("/api/sessions/:id/export", (req, res) => {
  const state = req.params.id === "current" ? repository.snapshot() : repository.getSessionArchive(req.params.id);
  if (!state?.session) {
    sendApiError(res, new ApiError(404, "SESSION_NOT_FOUND", "Session not found."));
    return;
  }
  const format = String(req.query.format || "json");
  if (format === "markdown") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${safeFileName(state.session.title)}.md\"`);
    res.send(renderSessionMarkdown(state));
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"${safeFileName(state.session.title)}.json\"`);
  res.json(state);
});

app.post("/api/documents", async (req, res, next) => {
  try {
    const input = req.body || {};
    const ingested = createIngestedDocumentFromText({
      id: makeId("doc"),
      name: input.name,
      category: input.category,
      text: input.text
    });
    const saved = repository.saveDocument(ingested.document, ingested.text);
    const indexed = await repository.indexDocumentEmbeddings(saved.id);
    res.status(201).json(indexed || saved);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/documents/:id", (req, res) => {
  const deleted = repository.deleteDocument(req.params.id);
  if (!deleted) {
    sendApiError(res, new ApiError(404, "DOCUMENT_NOT_FOUND", "Document not found."));
    return;
  }
  res.json({
    deleted,
    documentIndex: repository.getDocumentIndexStatus(),
  });
});

app.post("/api/documents/:id/reindex", async (req, res, next) => {
  try {
    const indexed = await repository.indexDocumentEmbeddings(req.params.id);
    if (!indexed) {
      sendApiError(res, new ApiError(404, "DOCUMENT_NOT_FOUND", "Document not found."));
      return;
    }
    res.json(indexed);
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/upload", (req, res, next) => {
  uploadDocument.single("file")(req, res, (uploadError) => {
    if (uploadError) {
      const message = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE"
        ? "Uploaded document must be 15 MB or smaller."
        : "Document upload failed.";
      sendApiError(res, new ApiError(400, "DOCUMENT_UPLOAD_FAILED", message));
      return;
    }

    void (async () => {
      const file = req.file;
      if (!file) {
        sendApiError(res, new ApiError(400, "DOCUMENT_FILE_REQUIRED", "Upload a document using the multipart field name \"file\"."));
        return;
      }

      const ingested = await createIngestedDocumentFromUpload({
        id: makeId("doc"),
        originalName: file.originalname,
        mimeType: file.mimetype,
        buffer: file.buffer,
        category: req.body?.category
      });

      const saved = repository.saveDocument(ingested.document, ingested.text);
      const indexed = await repository.indexDocumentEmbeddings(saved.id);
      res.status(201).json(indexed || saved);
    })().catch((error: unknown) => {
      if (error instanceof UnsupportedDocumentTypeError) {
        sendApiError(res, new ApiError(415, "UNSUPPORTED_DOCUMENT_TYPE", "Unsupported document type. Upload TXT, Markdown, DOCX, or PDF."));
        return;
      }
      if (error instanceof DocumentEmbeddingError) {
        sendApiError(res, new ApiError(502, "DOCUMENT_EMBEDDING_FAILED", error.message));
        return;
      }
      next(error);
    });
  });
});

app.get("/api/prompts", (_req, res) => {
  res.json(repository.listPrompts());
});

app.get("/api/settings/config", (_req, res) => {
  res.json({
    config: toPublicAppConfig(),
    providers: repository.getProviderSettings(),
    adapters: buildProviderAdapters(),
  });
});

app.patch("/api/settings/config", (req, res) => {
  const config = patchAppConfig(req.body || {});
  res.json({
    config: toPublicAppConfig(config),
    providers: repository.getProviderSettings(),
    adapters: buildProviderAdapters(),
  });
});

app.get("/api/settings/providers", (_req, res) => {
  res.json({
    settings: repository.getProviderSettings(),
    adapters: buildProviderAdapters(),
  });
});

app.patch("/api/settings/providers", (req, res) => {
  patchProviderSettings((req.body || {}) as Partial<ProviderSettings>);
  res.json({
    settings: getProviderSettings(),
    adapters: buildProviderAdapters(),
  });
});

app.patch("/api/prompts/:id", (req, res) => {
  const prompt = repository.getPrompt(req.params.id);
  if (!prompt) {
    sendApiError(res, new ApiError(404, "PROMPT_NOT_FOUND", "Prompt not found."));
    return;
  }
  const updated = {
    ...prompt,
    body: String(req.body?.body || prompt.body),
    updatedAt: Date.now()
  };
  res.json(repository.savePrompt(updated));
});

async function appendTranscriptAndDetectEvent(
  event: TranscriptEvent,
  options: { streamSnapshot?: string } = {},
): Promise<QuestionCard[]> {
  return appendTranscriptAndDetect(repository, event, options);
}

function audioSourceFromInput(source: unknown): TranscriptEvent["source"] {
  return source === "mic" || source === "mixed" ? source : "system";
}

app.get("/api/audio/streaming", (_req, res) => {
  res.json(resolveStreamingSttCapabilities(repository.getProviderSettings(), port));
});

app.post("/api/audio/transcriptions", (req, res, next) => {
  const parser = req.is("multipart/form-data") ? uploadAudio.single("file") : parseRawAudio;
  parser(req, res, (uploadError) => {
    if (uploadError) {
      const message = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE"
        ? "Uploaded audio must be 25 MB or smaller."
        : "Audio upload failed.";
      sendApiError(res, new ApiError(400, "AUDIO_UPLOAD_FAILED", message));
      return;
    }

    void (async () => {
      const file = req.file;
      const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
      const audio = file?.buffer || rawBody;
      if (!audio?.length) {
        sendApiError(res, new ApiError(400, "AUDIO_REQUIRED", "Send raw audio bytes or upload a file using multipart field name \"file\"."));
        return;
      }

      const adapter = createConfiguredSpeechToTextAdapter(repository.getProviderSettings());
      if (!adapter) throw new SpeechToTextUnavailableError();

      const text = await adapter.transcribe({
        audio,
        mimeType: file?.mimetype || req.get("content-type") || "application/octet-stream",
        fileName: file?.originalname || String(req.query.fileName || "audio-chunk"),
        sampleRate: Number(req.query.sampleRate || 16000),
        channels: Number(req.query.channels || 1),
        bitDepth: Number(req.query.bitDepth || 16)
      });

      const event: TranscriptEvent = {
        id: makeId("transcript"),
        source: audioSourceFromInput(req.query.source),
        text,
        isFinal: true,
        timestamp: Date.now()
      };
      const questions = await appendTranscriptAndDetectEvent(event);
      res.status(201).json({ event, questions });
    })().catch(next);
  });
});

app.post("/api/transcript", async (req, res, next) => {
  const input = req.body || {};
  const event: TranscriptEvent = {
    id: makeId("transcript"),
    source: audioSourceFromInput(input.source),
    text: String(input.text || ""),
    isFinal: input.isFinal !== false,
    timestamp: Date.now()
  };
  try {
    const questions = await appendTranscriptAndDetectEvent(event);
    res.status(201).json({ event, questions });
  } catch (error) {
    next(error);
  }
});

interface QuestionCreationResult {
  question: QuestionCard;
  created: boolean;
}

function createQuestionFromInput(input: Record<string, unknown>): QuestionCreationResult | ApiError {
  const rawText = String(input.rawText || input.text || "").trim();
  if (!rawText) {
    return new ApiError(400, "QUESTION_TEXT_REQUIRED", "Question text is required.");
  }

  const detected = detectQuestionFromText(rawText, repository.listQuestions().length, Date.now(), "question");
  const question: QuestionCard = detected || {
    id: makeId("question"),
    rawText,
    framedQuestion: rawText.endsWith("?") ? rawText : `Respond to: ${rawText.replace(/[.。]+$/, "")}.`,
    type: isQuestionType(input.type) ? input.type : "technical",
    confidence: 0.72,
    evaluationIntent: "User-selected transcript segment sent directly to the answer engine.",
    createdAt: Date.now(),
    status: "new"
  };

  const existing = repository.getQuestionByRawText(question.rawText);
  if (existing) return { question: existing, created: false };
  return { question: repository.saveQuestion(question), created: true };
}

function isQuestionType(value: unknown): value is QuestionCard["type"] {
  return typeof value === "string" && [
    "behavioral",
    "technical",
    "coding",
    "system-design",
    "situational",
    "culture",
    "resume",
    "follow-up",
    "logistics",
    "meeting",
  ].includes(value);
}

async function answerQuestion(question: QuestionCard, format?: AnswerFormat): Promise<AnswerDraft> {
  const session = repository.getSession();
  if (!session) {
    throw new ApiError(404, "ANSWER_CONTEXT_NOT_FOUND", "Question or session not found.");
  }

  repository.updateQuestionStatus(question.id, "answering");
  const answerInput = await buildAnswerInput(question, session, format);
  syncResolvedQuestion(question, answerInput.question);
  const answer = await generateAnswerDraft(
    answerInput,
    repository.getProviderSettings(),
  );
  repository.saveAnswerDraft(answer);
  repository.updateQuestionStatus(question.id, "answered");
  return answer;
}

app.post("/api/questions", (req, res) => {
  const result = createQuestionFromInput(req.body || {});
  if (result instanceof ApiError) {
    sendApiError(res, result);
    return;
  }
  res.status(result.created ? 201 : 200).json(result.question);
});

app.post("/api/questions/latest/answer", async (req, res, next) => {
  const input = req.body || {};
  const createdQuestion = input.rawText || input.text ? createQuestionFromInput(input) : null;
  if (createdQuestion instanceof ApiError) {
    sendApiError(res, createdQuestion);
    return;
  }

  const question = createdQuestion?.question
    || latestBy(repository.listQuestions(), (candidate) => candidate.createdAt);
  if (!question) {
    sendApiError(res, new ApiError(404, "QUESTION_NOT_FOUND", "No question is available to answer."));
    return;
  }

  try {
    const existingAnswer = !input.regenerate ? repository.getAnswerDraft(question.id) : undefined;
    const answer = existingAnswer || await answerQuestion(question, normalizeAnswerFormat(input.format));
    res.status(existingAnswer ? 200 : 201).json({ question, answer, state: latestOverlayState() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/questions/:id/answer", async (req, res, next) => {
  const question = repository.getQuestion(req.params.id);
  if (!question) {
    sendApiError(res, new ApiError(404, "ANSWER_CONTEXT_NOT_FOUND", "Question or session not found."));
    return;
  }
  try {
    const answer = await answerQuestion(question, normalizeAnswerFormat(req.body?.format));
    res.status(201).json(answer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/overlay/screenshot-prompt", async (req, res, next) => {
  const input = req.body || {};
  const imageData = String(input.imageData || input.image || input.dataUrl || "").trim();
  if (!imageData) {
    sendApiError(res, new ApiError(400, "SCREENSHOT_IMAGE_REQUIRED", "Screenshot image data is required."));
    return;
  }

  try {
    const result = await generateScreenshotPromptAnswer({
      imageData,
      imageMimeType: typeof input.imageMimeType === "string" ? input.imageMimeType : undefined,
      prompt: typeof input.prompt === "string" ? input.prompt : undefined,
      domain: typeof input.domain === "string" ? input.domain : undefined,
      format: normalizeAnswerFormat(input.format),
      language: typeof input.language === "string" ? input.language : undefined,
      session: repository.getSession(),
    }, repository.getProviderSettings(), makeId);
    const rawText = String(input.prompt || `Screenshot prompt for ${result.metadata.domain}`).trim();
    const questionType = questionTypeFromDomain(result.metadata.domain);
    const question: QuestionCard = {
      id: makeId("question"),
      rawText,
      framedQuestion: rawText.endsWith("?") ? rawText : `Respond to the visible ${result.metadata.domain} prompt.`,
      type: questionType,
      confidence: result.usedFallback ? 0.58 : 0.82,
      evaluationIntent: result.usedFallback
        ? "Screenshot captured, but image analysis was unavailable. The response is a safe fallback."
        : `Screenshot-derived ${result.metadata.domain} prompt analyzed by the configured image provider.`,
      createdAt: result.createdAt,
      status: "answered"
    };
    const savedQuestion = repository.saveQuestion(question);
    const answer: AnswerDraft = {
      id: `answer-${savedQuestion.id}-${result.createdAt}`,
      questionId: savedQuestion.id,
      format: result.metadata.format,
      stages: {
        bullets: result.answer
          .split(/\n+/)
          .map((line) => line.replace(/^[-*\d.]+\s*/, "").trim())
          .filter(Boolean)
          .slice(0, 4),
        structured: result.answer,
        sources: ["Screenshot capture"],
        risk: result.usedFallback
          ? `Image analysis fallback: ${result.fallbackReason || "provider unavailable"}. Verify the visible prompt before using this answer.`
          : "Grounding: answer is based on the captured screenshot and current session context."
      }
    };
    const savedAnswer = repository.saveAnswerDraft(answer);
    res.status(201).json({
      ...result,
      question: savedQuestion,
      answer: savedAnswer,
      state: latestOverlayState()
    });
  } catch (error) {
    next(error);
  }
});

function questionTypeFromDomain(domain: string): QuestionCard["type"] {
  const normalized = domain.toLowerCase();
  if (normalized.includes("coding") || normalized.includes("algorithm")) return "coding";
  if (normalized.includes("system")) return "system-design";
  if (normalized.includes("behavior")) return "behavioral";
  if (normalized.includes("support") || normalized.includes("customer")) return "situational";
  if (normalized.includes("meeting")) return "meeting";
  return "technical";
}

app.patch("/api/questions/:id/status", (req, res) => {
  const status = req.body?.status as QuestionCard["status"] | undefined;
  if (!status || !["new", "answering", "answered", "saved", "dismissed"].includes(status)) {
    sendApiError(res, new ApiError(400, "QUESTION_STATUS_UNSUPPORTED", "Unsupported question status."));
    return;
  }

  const question = repository.updateQuestionStatus(req.params.id, status);
  if (!question) {
    sendApiError(res, new ApiError(404, "QUESTION_NOT_FOUND", "Question not found."));
    return;
  }
  res.json(question);
});

app.patch("/api/answers/:id", (req, res) => {
  const metadata: Pick<AnswerDraft, "pinned" | "copiedAt"> = {};
  if (typeof req.body?.pinned === "boolean") metadata.pinned = req.body.pinned;
  if (typeof req.body?.copiedAt === "number") metadata.copiedAt = req.body.copiedAt;

  const answer = repository.updateAnswerDraftMetadata(req.params.id, metadata);
  if (!answer) {
    sendApiError(res, new ApiError(404, "ANSWER_NOT_FOUND", "Answer not found."));
    return;
  }
  res.json(answer);
});

async function buildAnswerInput(
  question: QuestionCard,
  session: SessionSetup,
  format?: AnswerFormat,
  extras: { responseProfile?: string } = {},
) {
  const resolvedFormat = format || session.answerFormat;
  const transcriptEvents = repository.listTranscriptEvents();
  const resolved = resolveQuestionAtAnswerTime(question, transcriptEvents);
  const enrichedQuestion: QuestionCard = {
    ...question,
    rawText: resolved.rawText,
    framedQuestion: resolved.framedQuestion,
  };

  const retrievalQuery = [
    resolved.rawText,
    resolved.framedQuestion,
    ...resolved.contextTurns.map((turn) => turn.text),
    session.role,
    session.seniority,
    session.round,
    enrichedQuestion.type,
  ].join(" ");

  const focusQuery = focusTermsForRetrieval(enrichedQuestion);
  const baseChunks = await repository.searchDocumentChunks(retrievalQuery, 6);
  const focusChunks = focusQuery.trim()
    ? await repository.searchDocumentChunks(`${focusQuery} ${enrichedQuestion.rawText}`, 5)
    : [];
  const mergedChunks = dedupeRetrievedChunks([...focusChunks, ...baseChunks]);
  const groundingAnalysis = analyzeAndRankChunks(enrichedQuestion, mergedChunks);
  const priorAnswers = buildPriorAnswerHistory(
    repository.listQuestions(),
    repository.listAnswerDrafts(),
    question.id,
  );
  const continuity = buildInterviewContinuity(enrichedQuestion, priorAnswers);

  return {
    question: enrichedQuestion,
    session,
    conversationContext: resolved.contextTurns,
    conversationTranscript: formatConversationForPrompt(resolved.contextTurns),
    priorAnswers,
    continuity,
    retrievedContext: groundingAnalysis.rankedChunks.slice(0, 5),
    groundingAnalysis,
    format: resolvedFormat,
    responseProfile: resolveResponseProfile(session, extras.responseProfile),
    answerPromptTemplate: repository.getPrompt("answer-generator")?.body,
  };
}

function dedupeRetrievedChunks(chunks: RetrievedDocumentChunk[]): RetrievedDocumentChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    if (seen.has(chunk.id)) return false;
    seen.add(chunk.id);
    return true;
  });
}

function resolveResponseProfile(session: SessionSetup, override?: string): string | undefined {
  if (override?.startsWith("custom:")) return override;
  if (override && override !== "custom") return override;
  if (session.voiceProfile === "custom") {
    const custom = session.customVoice.trim();
    return custom ? `custom:${custom}` : undefined;
  }
  return session.voiceProfile;
}

function syncResolvedQuestion(original: QuestionCard, resolved: QuestionCard): QuestionCard {
  if (resolved.rawText === original.rawText && resolved.framedQuestion === original.framedQuestion) {
    return original;
  }
  return repository.saveQuestion({
    ...original,
    rawText: resolved.rawText,
    framedQuestion: resolved.framedQuestion,
    type: resolved.type,
  });
}

app.post("/api/questions/:id/answer/stream", async (req, res) => {
  const question = repository.getQuestion(req.params.id);
  const session = repository.getSession();
  if (!question || !session) {
    sendApiError(res, new ApiError(404, "ANSWER_CONTEXT_NOT_FOUND", "Question or session not found."));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  try {
    const answerInput = await buildAnswerInput(question, session, normalizeAnswerFormat(req.body?.format), {
      responseProfile: typeof req.body?.profile === "string" ? req.body.profile : undefined,
    });
    syncResolvedQuestion(question, answerInput.question);
    res.write(`data: ${JSON.stringify({ type: "question_update", question: answerInput.question })}\n\n`);
    if (typeof (res as Response & { flush?: () => void }).flush === "function") {
      (res as Response & { flush: () => void }).flush();
    }

    let completedAnswer: AnswerDraft | undefined;
    for await (const event of streamAnswerDraft(
      answerInput,
      repository.getProviderSettings(),
      0,
    )) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (typeof (res as Response & { flush?: () => void }).flush === "function") {
        (res as Response & { flush: () => void }).flush();
      }
      if (event.type === "complete") completedAnswer = event.answer;
    }

    if (completedAnswer) {
      repository.saveAnswerDraft(completedAnswer);
      repository.updateQuestionStatus(question.id, "answered");
    }
    res.end();
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: { code: "ANSWER_STREAM_FAILED", message: "Answer stream failed.", status: 500, requestId: res.locals.requestId } })}\n\n`);
    res.end();
  }
});

app.post("/api/reports", (_req, res) => {
  const state = repository.snapshot();
  const answered = state.questionCards.filter((question) => question.status === "answered");
  const unresolved = state.questionCards.filter((question) => question.status !== "answered");
  const mostCommonType = state.questionCards.reduce<Record<string, number>>((counts, question) => {
    counts[question.type] = (counts[question.type] || 0) + 1;
    return counts;
  }, {});
  const focusType = Object.entries(mostCommonType).sort((a, b) => b[1] - a[1])[0]?.[0] || "general";

  res.status(201).json({
    id: makeId("report"),
    generatedAt: Date.now(),
    summary: `${answered.length} answered question${answered.length === 1 ? "" : "s"} from ${state.questionCards.length} detected item${state.questionCards.length === 1 ? "" : "s"}.`,
    strengths: answered.slice(0, 3).map((question) => `Handled ${question.type} question: ${question.framedQuestion}`),
    focus: unresolved.length
      ? unresolved.slice(0, 3).map((question) => `Prepare a tighter answer for: ${question.framedQuestion}`)
      : [`Keep a prepared ${focusType} story ready with metrics, tradeoffs, and one clear result.`]
  });
});

app.delete("/api/state", (_req, res) => {
  repository.reset();
  res.status(204).end();
});

app.use((_req, res) => {
  sendApiError(res, new ApiError(404, "ROUTE_NOT_FOUND", "Route not found."));
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    req.socket.destroy();
    return;
  }

  if (error instanceof ApiError) {
    sendApiError(res, error);
    return;
  }

  if (error instanceof SpeechToTextUnavailableError) {
    sendApiError(res, new ApiError(503, "STT_NOT_CONFIGURED", error.message));
    return;
  }

  if (error instanceof SpeechToTextTranscriptionError) {
    sendApiError(res, new ApiError(502, "STT_TRANSCRIPTION_FAILED", error.message));
    return;
  }

  if (error instanceof AnswerGenerationError) {
    sendApiError(res, new ApiError(502, "ANSWER_PROVIDER_FAILED", error.message));
    return;
  }

  if (error instanceof DocumentEmbeddingError) {
    sendApiError(res, new ApiError(502, "DOCUMENT_EMBEDDING_FAILED", error.message));
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    sendApiError(res, new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."));
    return;
  }

  console.error(error);
  sendApiError(res, new ApiError(500, "INTERNAL_SERVER_ERROR", "Something went wrong. Try again."));
});

const server = http.createServer(app);
attachStreamingTranscriptionServer(server, {
  appendTranscriptAndDetect: appendTranscriptAndDetectEvent,
  makeId,
  getProviderSettings: () => repository.getProviderSettings(),
});

server.listen(port, "127.0.0.1", () => {
  const streaming = resolveStreamingSttCapabilities(repository.getProviderSettings());
  console.log(`Second Chair API running on http://127.0.0.1:${port}`);
  if (streaming.available) {
    console.log(`Streaming STT ready via ${streaming.provider} at ws://127.0.0.1:${port}${streaming.endpoint}`);
  }
});
