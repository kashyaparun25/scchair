import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  AnswerDraft,
  DocumentSummary,
  ProviderSettings,
  PromptSetting,
  QuestionCard,
  SessionArchiveSummary,
  SessionSetup,
  TranscriptEvent,
} from "../shared/domain";
import {
  cloneProviderSettings,
  defaultProviderSettings,
  normalizeProviderSettings,
} from "./providerSettings";
import { getProviderSettings as loadProviderSettingsFromConfig, patchProviderSettings } from "./appConfigStore";
import {
  createEmbeddingClient,
} from "./documentEmbeddings";
import {
  indexChunkEmbeddings,
  searchDocumentChunksWithEmbeddings,
} from "./documentRetrieval";

export interface RepositoryState {
  session: SessionSetup | null;
  documents: DocumentSummary[];
  transcriptEvents: TranscriptEvent[];
  questionCards: QuestionCard[];
  answerDrafts: AnswerDraft[];
  prompts: PromptSetting[];
  providerSettings: ProviderSettings;
}

export interface RetrievedDocumentChunk {
  id: string;
  documentId: string;
  documentName: string;
  category: DocumentSummary["category"];
  text: string;
  score: number;
}

export interface DocumentIndexStatus {
  totalDocuments: number;
  searchableDocuments: number;
  totalChunks: number;
  totalEmbeddings: number;
  documents: Array<DocumentSummary & { searchable: boolean; chunkCount: number; embeddingCount: number }>;
}

export interface SqliteRepositoryOptions {
  dbPath: string;
  legacyStateFile?: string;
}

export interface InterviewCopilotRepository {
  getSession(): SessionSetup | null;
  saveSession(session: SessionSetup): SessionSetup;
  listDocuments(): DocumentSummary[];
  saveDocument(document: DocumentSummary, extractedText?: string): DocumentSummary;
  indexDocumentEmbeddings(documentId: string): Promise<DocumentSummary | undefined>;
  deleteDocument(id: string): DocumentSummary | undefined;
  searchDocumentChunks(query: string, limit?: number): Promise<RetrievedDocumentChunk[]>;
  listTranscriptEvents(): TranscriptEvent[];
  appendTranscriptEvent(event: TranscriptEvent): TranscriptEvent;
  listQuestions(): QuestionCard[];
  getQuestion(id: string): QuestionCard | undefined;
  getQuestionByRawText(rawText: string): QuestionCard | undefined;
  saveQuestion(question: QuestionCard): QuestionCard;
  updateQuestionStatus(id: string, status: QuestionCard["status"]): QuestionCard | undefined;
  listAnswerDrafts(): AnswerDraft[];
  getAnswerDraft(questionId: string): AnswerDraft | undefined;
  saveAnswerDraft(answer: AnswerDraft): AnswerDraft;
  updateAnswerDraftMetadata(id: string, metadata: Pick<AnswerDraft, "pinned" | "copiedAt">): AnswerDraft | undefined;
  listPrompts(): PromptSetting[];
  getPrompt(id: string): PromptSetting | undefined;
  savePrompt(prompt: PromptSetting): PromptSetting;
  getProviderSettings(): ProviderSettings;
  saveProviderSettings(settings: Partial<ProviderSettings>): ProviderSettings;
  archiveCurrentSession(id: string, archivedAt?: number): SessionArchiveSummary | undefined;
  listSessionArchives(): SessionArchiveSummary[];
  getSessionArchive(id: string): RepositoryState | undefined;
  clearLiveSessionData(): void;
  getDocumentIndexStatus(): DocumentIndexStatus;
  reset(state?: Partial<RepositoryState>): void;
  snapshot(): RepositoryState;
}

const schemaVersion = 5;

const emptyState: RepositoryState = {
  session: null,
  documents: [],
  transcriptEvents: [],
  questionCards: [],
  answerDrafts: [],
  prompts: [],
  providerSettings: defaultProviderSettings(),
};

export function defaultPrompts(now = Date.now()): PromptSetting[] {
  return [
    {
      id: "answer-generator",
      title: "Interview answer generator",
      body: [
        "Draft a speakable first-person interview answer the candidate can read aloud verbatim.",
        "",
        "Grounding:",
        "- Prioritize retrieved resume and job context over generic textbook answers.",
        "- Use concrete examples from retrievedContext when present.",
        "- Never invent employers, titles, metrics, or project names absent from context.",
        "- Pick the project where the asked skill is explicitly mentioned — work, internship, or academic.",
        "- Never claim direct use of a tool unless the excerpt names it for that project.",
        '- Do not equate "used indirectly through LangChain/CrewAI" with hands-on PyTorch unless the resume says so.',
        "- If the skill is missing from documents: say so honestly, then pivot to documented adjacent experience or another project.",
        "",
        "Evidence tiers:",
        "- DIRECT: skill appears in the excerpt → answer from that project.",
        "- PARTIAL: related tools only → do not claim direct use of the asked skill for that role.",
        "- ABSENT: say what is documented; offer honest gap language instead of fabricating.",
        "",
        "Session continuity:",
        "- priorAnswersInSession contains what the candidate already said in THIS interview.",
        "- Never contradict prior answers. Do not repeat the same project paragraph verbatim.",
        "- 'If so' after a prior 'no': pivot — 'Since I haven't used X directly, the closest example is...'",
        "- 'Other tools/frameworks': add NEW examples not already stated.",
        "- 'Focus on what you know': lead with strengths; brief gap acknowledgment only if needed.",
        "- Applies to all interview types: technical, support, behavioral, sales, leadership.",
        "",
        "Adaptation (from session payload):",
        "- Match voiceProfile, round, seniority, responseStyle, and preferredFormat.",
        "- Recruiter rounds: motivation, fit, and clarity over deep technical depth.",
        "- Technical rounds: tradeoffs, architecture, and specifics.",
        "- Executive responseStyle: shorter, top-down, business impact first.",
        "",
        "Structure:",
        "- Open with the direct answer, then one supporting example when context allows.",
        "- 80–140 words, conversational, first person only.",
        "- No placeholders, brackets, meta-commentary, or filler openers unless natural.",
        "- If context is thin, stay honest and general without fabricating details.",
      ].join("\n"),
      variables: ["role", "company", "round", "seniority", "responseStyle", "voiceProfile", "question", "retrievedContext"],
      updatedAt: now,
    },
    {
      id: "question-framer",
      title: "Question framer",
      body: [
        "Rewrite transcript fragments into one precise interviewer question.",
        "",
        "Rules:",
        "- Preserve the original intent; infer missing context carefully.",
        "- Classify the question type (behavioral, technical, system-design, etc.).",
        "- Strip filler words and disfluencies from live speech.",
        "- Output a single clear question, not a list.",
      ].join("\n"),
      variables: ["transcript_window", "role", "round"],
      updatedAt: now,
    },
  ];
}

const legacyAnswerGeneratorPromptV1 =
  "Write a natural first-person interview answer the candidate can read aloud. Use resume and job context when available. Be specific, conversational, and never use placeholders.";

const legacyAnswerGeneratorPromptV2 = [
  "Draft a speakable first-person interview answer the candidate can read aloud verbatim.",
  "",
  "Grounding:",
  "- Prioritize retrieved resume and job context over generic textbook answers.",
  "- Use concrete examples from retrievedContext when present.",
  "- Never invent employers, titles, metrics, or project names absent from context.",
].join("\n");

export function createInMemoryRepository(
  initialState: Partial<RepositoryState> = emptyState,
): InterviewCopilotRepository {
  let session = cloneSession(initialState.session ?? null);
  let documents = (initialState.documents ?? []).map(cloneDocument);
  let documentChunks: RetrievedDocumentChunk[] = [];
  let chunkEmbeddings = new Map<string, number[]>();
  let transcriptEvents = (initialState.transcriptEvents ?? []).map(cloneTranscriptEvent);
  let questionCards = (initialState.questionCards ?? []).map(cloneQuestion);
  let answerDrafts = (initialState.answerDrafts ?? []).map(cloneAnswer);
  let prompts = clonePrompts(initialState.prompts);
  let providerSettings = cloneProviderSettings(initialState.providerSettings);
  let archives: { summary: SessionArchiveSummary; state: RepositoryState }[] = [];

  return {
    getSession() {
      return cloneSession(session);
    },
    saveSession(nextSession) {
      session = cloneSession(nextSession);
      documents = session?.documents.map(cloneDocument) || documents;
      return cloneSession(session) as SessionSetup;
    },
    listDocuments() {
      return documents.map(cloneDocument);
    },
    saveDocument(document, extractedText) {
      const usesExternalEmbeddings = Boolean(createEmbeddingClient(providerSettings));
      const nextDocument = cloneDocument({
        ...document,
        status: typeof extractedText === "string"
          ? documentStatusForText(extractedText, usesExternalEmbeddings)
          : document.status,
      });
      documents = upsertById(documents, nextDocument);
      if (typeof extractedText === "string") {
        documentChunks = [
          ...documentChunks.filter((chunk) => chunk.documentId !== nextDocument.id),
          ...chunkDocument(nextDocument, extractedText),
        ];
        chunkEmbeddings = new Map(
          [...chunkEmbeddings.entries()].filter(([chunkId]) => !chunkId.startsWith(`${nextDocument.id}:`)),
        );
      }
      if (session) session = { ...session, documents: documents.map(cloneDocument) };
      return cloneDocument(nextDocument);
    },
    async indexDocumentEmbeddings(documentId) {
      const document = documents.find((candidate) => candidate.id === documentId);
      if (!document) return undefined;

      const chunks = documentChunks.filter((chunk) => chunk.documentId === documentId);
      if (!chunks.length) {
        return updateInMemoryDocumentStatus(documentId, "failed");
      }

      const client = createEmbeddingClient(providerSettings);
      if (!client) {
        return updateInMemoryDocumentStatus(documentId, "indexed");
      }

      try {
        const embeddings = await indexChunkEmbeddings(client, chunks);
        for (const [chunkId, vector] of embeddings.entries()) {
          chunkEmbeddings.set(chunkId, vector);
        }
        return updateInMemoryDocumentStatus(documentId, "indexed");
      } catch (error) {
        console.warn("Document embedding indexing failed.", error);
        return updateInMemoryDocumentStatus(documentId, "failed");
      }

      function updateInMemoryDocumentStatus(id: string, status: DocumentSummary["status"]) {
        const current = documents.find((candidate) => candidate.id === id);
        if (!current) return undefined;
        const updated = { ...current, status };
        documents = upsertById(documents, updated);
        if (session) session = { ...session, documents: documents.map(cloneDocument) };
        return cloneDocument(updated);
      }
    },
    deleteDocument(id) {
      const existing = documents.find((candidate) => candidate.id === id);
      if (!existing) return undefined;

      documents = documents.filter((candidate) => candidate.id !== id);
      documentChunks = documentChunks.filter((chunk) => chunk.documentId !== id);
      chunkEmbeddings = new Map(
        [...chunkEmbeddings.entries()].filter(([chunkId]) => !chunkId.startsWith(`${id}:`)),
      );
      if (session) {
        session = {
          ...session,
          documents: session.documents.filter((document) => document.id !== id),
        };
      }
      return cloneDocument(existing);
    },
    async searchDocumentChunks(query, limit = 4) {
      return searchDocumentChunksWithEmbeddings(
        query,
        documentChunks,
        chunkEmbeddings,
        providerSettings,
        limit,
      );
    },
    listTranscriptEvents() {
      return transcriptEvents.map(cloneTranscriptEvent);
    },
    appendTranscriptEvent(event) {
      transcriptEvents = [...transcriptEvents, cloneTranscriptEvent(event)];
      return cloneTranscriptEvent(event);
    },
    listQuestions() {
      return questionCards.map(cloneQuestion);
    },
    getQuestion(id) {
      const question = questionCards.find((candidate) => candidate.id === id);
      return question ? cloneQuestion(question) : undefined;
    },
    getQuestionByRawText(rawText) {
      const question = questionCards.find((candidate) => candidate.rawText === rawText);
      return question ? cloneQuestion(question) : undefined;
    },
    saveQuestion(question) {
      const nextQuestion = cloneQuestion(question);
      questionCards = upsertById(questionCards, nextQuestion);
      return cloneQuestion(nextQuestion);
    },
    updateQuestionStatus(id, status) {
      const question = questionCards.find((candidate) => candidate.id === id);
      if (!question) return undefined;
      const updated = { ...question, status };
      questionCards = questionCards.map((candidate) => (candidate.id === id ? updated : candidate));
      return cloneQuestion(updated);
    },
    listAnswerDrafts() {
      return answerDrafts.map(cloneAnswer);
    },
    getAnswerDraft(questionId) {
      const answer = answerDrafts.find((candidate) => candidate.questionId === questionId);
      return answer ? cloneAnswer(answer) : undefined;
    },
    saveAnswerDraft(answer) {
      const nextAnswer = cloneAnswer(answer);
      const existingIndex = answerDrafts.findIndex((candidate) => candidate.id === answer.id);
      if (existingIndex >= 0) {
        answerDrafts = answerDrafts.map((candidate, index) =>
          index === existingIndex ? nextAnswer : candidate,
        );
      } else {
        answerDrafts = [
          ...answerDrafts.filter((candidate) => candidate.questionId !== answer.questionId),
          nextAnswer,
        ];
      }
      return cloneAnswer(nextAnswer);
    },
    updateAnswerDraftMetadata(id, metadata) {
      const answer = answerDrafts.find((candidate) => candidate.id === id);
      if (!answer) return undefined;
      const updated = {
        ...answer,
        pinned: metadata.pinned ?? answer.pinned,
        copiedAt: metadata.copiedAt ?? answer.copiedAt,
      };
      answerDrafts = answerDrafts.map((candidate) => (candidate.id === id ? updated : candidate));
      return cloneAnswer(updated);
    },
    listPrompts() {
      return prompts.map(clonePrompt);
    },
    getPrompt(id) {
      const prompt = prompts.find((candidate) => candidate.id === id);
      return prompt ? clonePrompt(prompt) : undefined;
    },
    savePrompt(prompt) {
      const nextPrompt = clonePrompt(prompt);
      prompts = upsertById(prompts, nextPrompt);
      return clonePrompt(nextPrompt);
    },
    getProviderSettings() {
      return loadProviderSettingsFromConfig();
    },
    saveProviderSettings(settings) {
      patchProviderSettings(normalizeProviderSettings(settings, loadProviderSettingsFromConfig()));
      return loadProviderSettingsFromConfig();
    },
    archiveCurrentSession(id, archivedAt = Date.now()) {
      const state = snapshotFromParts(session, documents, transcriptEvents, questionCards, answerDrafts, prompts);
      if (!state.session) return undefined;
      const summary = summarizeArchive(id, archivedAt, state);
      archives = [...archives.filter((archive) => archive.summary.id !== id), { summary, state }];
      return { ...summary };
    },
    listSessionArchives() {
      return archives.map((archive) => ({ ...archive.summary })).sort((a, b) => b.archivedAt - a.archivedAt);
    },
    getSessionArchive(id) {
      const archive = archives.find((candidate) => candidate.summary.id === id);
      return archive ? normalizeState(archive.state) : undefined;
    },
    clearLiveSessionData() {
      transcriptEvents = [];
      questionCards = [];
      answerDrafts = [];
    },
    getDocumentIndexStatus() {
      const embeddingCounts = new Map<string, number>();
      for (const chunk of documentChunks) {
        if (chunkEmbeddings.has(chunk.id)) {
          embeddingCounts.set(chunk.documentId, (embeddingCounts.get(chunk.documentId) || 0) + 1);
        }
      }
      return buildDocumentIndexStatus(documents, documentChunks, embeddingCounts);
    },
    reset(nextState = emptyState) {
      session = cloneSession(nextState.session ?? null);
      documents = (nextState.documents ?? []).map(cloneDocument);
      transcriptEvents = (nextState.transcriptEvents ?? []).map(cloneTranscriptEvent);
      questionCards = (nextState.questionCards ?? []).map(cloneQuestion);
      answerDrafts = (nextState.answerDrafts ?? []).map(cloneAnswer);
      prompts = clonePrompts(nextState.prompts);
      providerSettings = cloneProviderSettings(nextState.providerSettings);
      archives = [];
    },
    snapshot() {
      return snapshotFromParts(
        session,
        documents,
        transcriptEvents,
        questionCards,
        answerDrafts,
        prompts,
        providerSettings,
      );
    },
  };
}

export function createSqliteRepository(options: SqliteRepositoryOptions): InterviewCopilotRepository {
  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  const db = new Database(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  migrate(db);
  ensureDefaultPrompts(db);
  importLegacyJsonState(db, options.legacyStateFile);

  const replaceAll = db.transaction((state: RepositoryState) => {
    db.prepare("DELETE FROM answer_drafts").run();
    db.prepare("DELETE FROM question_cards").run();
    db.prepare("DELETE FROM transcript_events").run();
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM document_embeddings").run();
    db.prepare("DELETE FROM document_chunks").run();
    db.prepare("DELETE FROM document_contents").run();
    db.prepare("DELETE FROM documents").run();
    db.prepare("DELETE FROM prompts").run();

    for (const document of state.documents) insertDocument(db, document);
    if (state.session) insertSession(db, state.session);
    for (const event of state.transcriptEvents) insertTranscriptEvent(db, event);
    for (const question of state.questionCards) insertQuestion(db, question);
    for (const answer of state.answerDrafts) insertAnswerDraft(db, answer);
    for (const prompt of clonePrompts(state.prompts)) insertPrompt(db, prompt);
    setProviderSettings(db, state.providerSettings);
  });

  return {
    getSession() {
      return readSession(db);
    },
    saveSession(session) {
      const nextSession = cloneSession(session) as SessionSetup;
      db.transaction(() => {
        db.prepare("DELETE FROM sessions").run();
        insertSession(db, nextSession);
        replaceDocuments(db, nextSession.documents);
      })();
      return readSession(db) as SessionSetup;
    },
    listDocuments() {
      return readDocuments(db);
    },
    saveDocument(document, extractedText) {
      const settings = readProviderSettings(db);
      const usesExternalEmbeddings = Boolean(createEmbeddingClient(settings));
      const nextDocument = cloneDocument({
        ...document,
        status: typeof extractedText === "string"
          ? documentStatusForText(extractedText, usesExternalEmbeddings)
          : document.status,
      });
      db.transaction(() => {
        insertDocument(db, nextDocument);
        if (typeof extractedText === "string") {
          replaceDocumentText(db, nextDocument, extractedText);
          deleteDocumentEmbeddings(db, nextDocument.id);
        }
      })();
      return cloneDocument(nextDocument);
    },
    async indexDocumentEmbeddings(documentId) {
      return indexDocumentEmbeddingsInDb(db, documentId);
    },
    deleteDocument(id) {
      const existing = readDocumentById(db, id);
      if (!existing) return undefined;

      db.transaction(() => {
        deleteDocumentEmbeddings(db, id);
        db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
        db.prepare("DELETE FROM document_contents WHERE document_id = ?").run(id);
        db.prepare("DELETE FROM documents WHERE id = ?").run(id);
      })();

      const session = readSession(db);
      if (session?.documents.some((document) => document.id === id)) {
        const nextSession = {
          ...session,
          documents: session.documents.filter((document) => document.id !== id),
        };
        db.transaction(() => {
          db.prepare("DELETE FROM sessions").run();
          insertSession(db, nextSession);
          replaceDocuments(db, nextSession.documents);
        })();
      }

      return cloneDocument(existing);
    },
    async searchDocumentChunks(query, limit = 4) {
      ensureDocumentChunks(db);
      const chunks = readDocumentChunks(db);
      const embeddings = readChunkEmbeddings(db);
      return searchDocumentChunksWithEmbeddings(
        query,
        chunks,
        embeddings,
        readProviderSettings(db),
        limit,
      ).then((results) => results.map(cloneRetrievedChunk));
    },
    listTranscriptEvents() {
      return readTranscriptEvents(db);
    },
    appendTranscriptEvent(event) {
      const nextEvent = cloneTranscriptEvent(event);
      insertTranscriptEvent(db, nextEvent);
      return cloneTranscriptEvent(nextEvent);
    },
    listQuestions() {
      return readQuestions(db);
    },
    getQuestion(id) {
      return readQuestionById(db, id);
    },
    getQuestionByRawText(rawText) {
      return readQuestionByRawText(db, rawText);
    },
    saveQuestion(question) {
      const nextQuestion = cloneQuestion(question);
      insertQuestion(db, nextQuestion);
      return cloneQuestion(nextQuestion);
    },
    updateQuestionStatus(id, status) {
      db.prepare("UPDATE question_cards SET status = ? WHERE id = ?").run(status, id);
      return readQuestionById(db, id);
    },
    listAnswerDrafts() {
      return readAnswerDrafts(db);
    },
    getAnswerDraft(questionId) {
      return readAnswerDraftByQuestionId(db, questionId);
    },
    saveAnswerDraft(answer) {
      const nextAnswer = cloneAnswer(answer);
      db.prepare("DELETE FROM answer_drafts WHERE question_id = ? AND id <> ?").run(
        nextAnswer.questionId,
        nextAnswer.id,
      );
      insertAnswerDraft(db, nextAnswer);
      return cloneAnswer(nextAnswer);
    },
    updateAnswerDraftMetadata(id, metadata) {
      const existing = readAnswerDraftById(db, id);
      if (!existing) return undefined;
      db.prepare("UPDATE answer_drafts SET pinned = ?, copied_at = ? WHERE id = ?").run(
        (metadata.pinned ?? existing.pinned) ? 1 : 0,
        metadata.copiedAt ?? existing.copiedAt ?? null,
        id,
      );
      return readAnswerDraftById(db, id);
    },
    listPrompts() {
      return readPrompts(db);
    },
    getPrompt(id) {
      return readPromptById(db, id);
    },
    savePrompt(prompt) {
      const nextPrompt = clonePrompt(prompt);
      insertPrompt(db, nextPrompt);
      return clonePrompt(nextPrompt);
    },
    getProviderSettings() {
      return loadProviderSettingsFromConfig();
    },
    saveProviderSettings(settings) {
      patchProviderSettings(normalizeProviderSettings(settings, loadProviderSettingsFromConfig()));
      return loadProviderSettingsFromConfig();
    },
    archiveCurrentSession(id, archivedAt = Date.now()) {
      const state = this.snapshot();
      if (!state.session) return undefined;
      const summary = summarizeArchive(id, archivedAt, state);
      insertSessionArchive(db, summary, state);
      return { ...summary };
    },
    listSessionArchives() {
      return readSessionArchives(db);
    },
    getSessionArchive(id) {
      return readSessionArchiveState(db, id);
    },
    clearLiveSessionData() {
      db.transaction(() => {
        db.prepare("DELETE FROM answer_drafts").run();
        db.prepare("DELETE FROM question_cards").run();
        db.prepare("DELETE FROM transcript_events").run();
      })();
    },
    getDocumentIndexStatus() {
      return readDocumentIndexStatus(db);
    },
    reset(nextState = emptyState) {
      replaceAll(normalizeState(nextState));
    },
    snapshot() {
      return snapshotFromParts(
        readSession(db),
        readDocuments(db),
        readTranscriptEvents(db),
        readQuestions(db),
        readAnswerDrafts(db),
        readPrompts(db),
        readProviderSettings(db),
      );
    },
  };
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const currentVersion =
    (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null })
      .version ?? 0;

  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          word_count INTEGER NOT NULL,
          status TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          id TEXT NOT NULL,
          mode TEXT NOT NULL,
          title TEXT NOT NULL,
          role TEXT NOT NULL,
          company TEXT NOT NULL,
          round TEXT NOT NULL,
          seniority TEXT NOT NULL,
          meeting_topic TEXT NOT NULL DEFAULT '',
          meeting_audience TEXT NOT NULL DEFAULT '',
          meeting_goal TEXT NOT NULL DEFAULT '',
          meeting_notes TEXT NOT NULL DEFAULT '',
          response_style TEXT NOT NULL,
          language TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transcript_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          text TEXT NOT NULL,
          is_final INTEGER NOT NULL,
          timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS question_cards (
          id TEXT PRIMARY KEY,
          raw_text TEXT NOT NULL UNIQUE,
          framed_question TEXT NOT NULL,
          type TEXT NOT NULL,
          confidence REAL NOT NULL,
          evaluation_intent TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS answer_drafts (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL UNIQUE,
          format TEXT NOT NULL,
          bullets_json TEXT NOT NULL,
          structured TEXT NOT NULL,
          sources_json TEXT NOT NULL,
          risk TEXT NOT NULL,
          FOREIGN KEY (question_id) REFERENCES question_cards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS prompts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          variables_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transcript_events_timestamp
          ON transcript_events(timestamp, id);
        CREATE INDEX IF NOT EXISTS idx_question_cards_created_at
          ON question_cards(created_at, id);
      `);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        1,
        Date.now(),
      );
    })();
  }

  if (currentVersion < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_contents (
          document_id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          text TEXT NOT NULL,
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id
          ON document_chunks(document_id, chunk_index);
      `);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, Date.now());
    })();
  }

  if (currentVersion < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_archives (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          mode TEXT NOT NULL,
          role TEXT NOT NULL,
          company TEXT NOT NULL,
          round TEXT NOT NULL,
          archived_at INTEGER NOT NULL,
          question_count INTEGER NOT NULL,
          answer_count INTEGER NOT NULL,
          document_count INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_archives_archived_at
          ON session_archives(archived_at DESC, id);
      `);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, Date.now());
    })();
  }

  if (currentVersion < 4) {
    db.transaction(() => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(answer_drafts)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!columns.has("pinned")) {
        db.exec("ALTER TABLE answer_drafts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
      }
      if (!columns.has("copied_at")) {
        db.exec("ALTER TABLE answer_drafts ADD COLUMN copied_at INTEGER;");
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, Date.now());
    })();
  }

  if (currentVersion < 5) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_embeddings (
          chunk_id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          embedding_json TEXT NOT NULL,
          FOREIGN KEY (chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_document_embeddings_document_id
          ON document_embeddings(document_id);
      `);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(5, Date.now());
    })();
  }

  if (currentVersion < 6) {
    db.transaction(() => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!columns.has("voice_profile")) {
        db.exec("ALTER TABLE sessions ADD COLUMN voice_profile TEXT NOT NULL DEFAULT 'staff-engineer';");
      }
      if (!columns.has("custom_voice")) {
        db.exec("ALTER TABLE sessions ADD COLUMN custom_voice TEXT NOT NULL DEFAULT '';");
      }
      if (!columns.has("answer_format")) {
        db.exec("ALTER TABLE sessions ADD COLUMN answer_format TEXT NOT NULL DEFAULT 'technical';");
      }

      const existingPrompt = db.prepare("SELECT body FROM prompts WHERE id = 'answer-generator'").get() as
        | { body: string }
        | undefined;
      if (existingPrompt?.body === legacyAnswerGeneratorPromptV1) {
        const upgraded = defaultPrompts()[0];
        if (upgraded) {
          db.prepare("UPDATE prompts SET body = ?, variables_json = ?, updated_at = ? WHERE id = 'answer-generator'").run(
            upgraded.body,
            JSON.stringify(upgraded.variables),
            Date.now(),
          );
        }
      }

      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(6, Date.now());
    })();
  }

  if (currentVersion < 7) {
    db.transaction(() => {
      const existingPrompt = db.prepare("SELECT body FROM prompts WHERE id = 'answer-generator'").get() as
        | { body: string }
        | undefined;
      const shouldUpgrade = existingPrompt
        && (
          existingPrompt.body === legacyAnswerGeneratorPromptV1
          || existingPrompt.body === legacyAnswerGeneratorPromptV2
          || !existingPrompt.body.includes("Evidence tiers")
        );
      if (shouldUpgrade) {
        const upgraded = defaultPrompts()[0];
        if (upgraded) {
          db.prepare("UPDATE prompts SET body = ?, variables_json = ?, updated_at = ? WHERE id = 'answer-generator'").run(
            upgraded.body,
            JSON.stringify(upgraded.variables),
            Date.now(),
          );
        }
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(7, Date.now());
    })();
  }

  if (currentVersion < 8) {
    db.transaction(() => {
      const existingPrompt = db.prepare("SELECT body FROM prompts WHERE id = 'answer-generator'").get() as
        | { body: string }
        | undefined;
      if (existingPrompt && !existingPrompt.body.includes("Session continuity")) {
        const upgraded = defaultPrompts()[0];
        if (upgraded) {
          db.prepare("UPDATE prompts SET body = ?, variables_json = ?, updated_at = ? WHERE id = 'answer-generator'").run(
            upgraded.body,
            JSON.stringify(upgraded.variables),
            Date.now(),
          );
        }
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(8, Date.now());
    })();
  }

  if (currentVersion < 9) {
    db.transaction(() => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!columns.has("meeting_topic")) {
        db.exec("ALTER TABLE sessions ADD COLUMN meeting_topic TEXT NOT NULL DEFAULT '';");
      }
      if (!columns.has("meeting_audience")) {
        db.exec("ALTER TABLE sessions ADD COLUMN meeting_audience TEXT NOT NULL DEFAULT '';");
      }
      if (!columns.has("meeting_goal")) {
        db.exec("ALTER TABLE sessions ADD COLUMN meeting_goal TEXT NOT NULL DEFAULT '';");
      }
      if (!columns.has("meeting_notes")) {
        db.exec("ALTER TABLE sessions ADD COLUMN meeting_notes TEXT NOT NULL DEFAULT '';");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(9, Date.now());
    })();
  }
}

function ensureDefaultPrompts(db: Database.Database): void {
  const count = (db.prepare("SELECT COUNT(*) AS count FROM prompts").get() as { count: number }).count;
  if (count > 0) return;
  for (const prompt of defaultPrompts()) insertPrompt(db, prompt);
}

function importLegacyJsonState(db: Database.Database, legacyStateFile?: string): void {
  if (!legacyStateFile || !fs.existsSync(legacyStateFile)) return;
  if (getMeta(db, "legacy_json_imported") === "true") return;

  const hasState =
    (db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) +
        (SELECT COUNT(*) FROM documents) +
        (SELECT COUNT(*) FROM transcript_events) +
        (SELECT COUNT(*) FROM question_cards) +
        (SELECT COUNT(*) FROM answer_drafts) AS count
    `).get() as { count: number }).count > 0;

  if (!hasState) {
    const parsed = JSON.parse(fs.readFileSync(legacyStateFile, "utf8")) as Partial<RepositoryState>;
    createSqliteStateImporter(db)(normalizeState(parsed));
  }

  setMeta(db, "legacy_json_imported", "true");
}

function createSqliteStateImporter(db: Database.Database): (state: RepositoryState) => void {
  return db.transaction((state: RepositoryState) => {
    db.prepare("DELETE FROM answer_drafts").run();
    db.prepare("DELETE FROM question_cards").run();
    db.prepare("DELETE FROM transcript_events").run();
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM document_embeddings").run();
    db.prepare("DELETE FROM document_chunks").run();
    db.prepare("DELETE FROM document_contents").run();
    db.prepare("DELETE FROM documents").run();
    db.prepare("DELETE FROM prompts").run();

    for (const document of state.documents) insertDocument(db, document);
    if (state.session) insertSession(db, state.session);
    for (const event of state.transcriptEvents) insertTranscriptEvent(db, event);
    for (const question of state.questionCards) insertQuestion(db, question);
    for (const answer of state.answerDrafts) insertAnswerDraft(db, answer);
    for (const prompt of state.prompts) insertPrompt(db, prompt);
    setProviderSettings(db, state.providerSettings);
  });
}

function getMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function readProviderSettings(db: Database.Database): ProviderSettings {
  return normalizeProviderSettings(parseJson(getMeta(db, "provider_settings") || "", {}));
}

function setProviderSettings(db: Database.Database, settings: ProviderSettings): void {
  setMeta(db, "provider_settings", JSON.stringify(cloneProviderSettings(settings)));
}

function insertSession(db: Database.Database, session: SessionSetup): void {
  const normalized = normalizeSessionSetup(session);
  db.prepare(`
    INSERT INTO sessions (
      singleton_id, id, mode, title, role, company, round, seniority,
      meeting_topic, meeting_audience, meeting_goal, meeting_notes, response_style, language,
      voice_profile, custom_voice, answer_format
    )
    VALUES (
      1, @id, @mode, @title, @role, @company, @round, @seniority,
      @meetingTopic, @meetingAudience, @meetingGoal, @meetingNotes, @responseStyle, @language,
      @voiceProfile, @customVoice, @answerFormat
    )
    ON CONFLICT(singleton_id) DO UPDATE SET
      id = excluded.id,
      mode = excluded.mode,
      title = excluded.title,
      role = excluded.role,
      company = excluded.company,
      round = excluded.round,
      seniority = excluded.seniority,
      meeting_topic = excluded.meeting_topic,
      meeting_audience = excluded.meeting_audience,
      meeting_goal = excluded.meeting_goal,
      meeting_notes = excluded.meeting_notes,
      response_style = excluded.response_style,
      language = excluded.language,
      voice_profile = excluded.voice_profile,
      custom_voice = excluded.custom_voice,
      answer_format = excluded.answer_format
  `).run(normalized);
}

function insertDocument(db: Database.Database, document: DocumentSummary): void {
  db.prepare(`
    INSERT INTO documents (id, name, category, word_count, status)
    VALUES (@id, @name, @category, @wordCount, @status)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      word_count = excluded.word_count,
      status = excluded.status
  `).run(document);
}

function replaceDocumentText(db: Database.Database, document: DocumentSummary, text: string): void {
  db.prepare(`
    INSERT INTO document_contents (document_id, text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      text = excluded.text,
      updated_at = excluded.updated_at
  `).run(document.id, text, Date.now());

  db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(document.id);
  for (const chunk of chunkDocument(document, text)) {
    db.prepare(`
      INSERT INTO document_chunks (id, document_id, chunk_index, text)
      VALUES (@id, @documentId, @chunkIndex, @text)
    `).run({
      id: chunk.id,
      documentId: chunk.documentId,
      chunkIndex: Number(chunk.id.split(":").at(-1) || 0),
      text: chunk.text,
    });
  }
}

function replaceDocuments(db: Database.Database, documents: DocumentSummary[]): void {
  const nextIds = new Set(documents.map((document) => document.id));
  const existing = db.prepare("SELECT id FROM documents").all() as { id: string }[];

  for (const { id } of existing) {
    if (nextIds.has(id)) continue;
    deleteDocumentEmbeddings(db, id);
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM document_contents WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }

  for (const document of documents) {
    insertDocument(db, document);
  }
}

function documentStatusForText(text: string, usesExternalEmbeddings: boolean): DocumentSummary["status"] {
  if (!text.trim()) return "failed";
  return usesExternalEmbeddings ? "processing" : "indexed";
}

function readDocumentById(db: Database.Database, id: string): DocumentSummary | undefined {
  return readDocuments(db).find((document) => document.id === id);
}

function updateDocumentStatus(db: Database.Database, id: string, status: DocumentSummary["status"]): DocumentSummary | undefined {
  db.prepare("UPDATE documents SET status = ? WHERE id = ?").run(status, id);
  return readDocumentById(db, id);
}

function deleteDocumentEmbeddings(db: Database.Database, documentId: string): void {
  db.prepare("DELETE FROM document_embeddings WHERE document_id = ?").run(documentId);
}

function replaceChunkEmbeddings(
  db: Database.Database,
  documentId: string,
  embeddings: Map<string, number[]>,
): void {
  deleteDocumentEmbeddings(db, documentId);
  const insert = db.prepare(`
    INSERT INTO document_embeddings (chunk_id, document_id, embedding_json)
    VALUES (@chunkId, @documentId, @embeddingJson)
  `);
  for (const [chunkId, vector] of embeddings.entries()) {
    insert.run({
      chunkId,
      documentId,
      embeddingJson: JSON.stringify(vector),
    });
  }
}

function readChunkEmbeddings(db: Database.Database): Map<string, number[]> {
  const rows = db.prepare(`
    SELECT chunk_id, embedding_json
    FROM document_embeddings
  `).all() as Array<{ chunk_id: string; embedding_json: string }>;

  const embeddings = new Map<string, number[]>();
  for (const row of rows) {
    const vector = parseJson<number[]>(row.embedding_json, []);
    if (vector.length) embeddings.set(row.chunk_id, vector);
  }
  return embeddings;
}

async function indexDocumentEmbeddingsInDb(
  db: Database.Database,
  documentId: string,
): Promise<DocumentSummary | undefined> {
  const document = readDocumentById(db, documentId);
  if (!document) return undefined;

  ensureDocumentChunks(db);
  const chunks = readDocumentChunks(db).filter((chunk) => chunk.documentId === documentId);
  if (!chunks.length) {
    return updateDocumentStatus(db, documentId, "failed");
  }

  const settings = readProviderSettings(db);
  const client = createEmbeddingClient(settings);
  if (!client) {
    return updateDocumentStatus(db, documentId, "indexed");
  }

  try {
    const embeddings = await indexChunkEmbeddings(client, chunks);
    replaceChunkEmbeddings(db, documentId, embeddings);
    return updateDocumentStatus(db, documentId, "indexed");
  } catch (error) {
    console.warn("Document embedding indexing failed.", error);
    return updateDocumentStatus(db, documentId, "failed");
  }
}

function ensureDocumentChunks(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT
      documents.id,
      documents.name,
      documents.category,
      documents.word_count,
      documents.status,
      document_contents.text
    FROM documents
    INNER JOIN document_contents ON document_contents.document_id = documents.id
    LEFT JOIN document_chunks ON document_chunks.document_id = documents.id
    WHERE document_chunks.id IS NULL
  `).all() as Array<{
    id: string;
    name: string;
    category: string;
    word_count: number;
    status: string;
    text: string;
  }>;

  for (const row of rows) {
    replaceDocumentText(db, {
      id: row.id,
      name: row.name,
      category: row.category as DocumentSummary["category"],
      wordCount: row.word_count,
      status: row.status as DocumentSummary["status"],
    }, row.text);
  }
}

function insertTranscriptEvent(db: Database.Database, event: TranscriptEvent): void {
  db.prepare(`
    INSERT INTO transcript_events (id, source, text, is_final, timestamp)
    VALUES (@id, @source, @text, @isFinal, @timestamp)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      text = excluded.text,
      is_final = excluded.is_final,
      timestamp = excluded.timestamp
  `).run({ ...event, isFinal: event.isFinal ? 1 : 0 });
}

function insertQuestion(db: Database.Database, question: QuestionCard): void {
  db.prepare(`
    INSERT INTO question_cards (
      id, raw_text, framed_question, type, confidence, evaluation_intent, created_at, status
    )
    VALUES (@id, @rawText, @framedQuestion, @type, @confidence, @evaluationIntent, @createdAt, @status)
    ON CONFLICT(id) DO UPDATE SET
      raw_text = excluded.raw_text,
      framed_question = excluded.framed_question,
      type = excluded.type,
      confidence = excluded.confidence,
      evaluation_intent = excluded.evaluation_intent,
      created_at = excluded.created_at,
      status = excluded.status
  `).run(question);
}

function insertAnswerDraft(db: Database.Database, answer: AnswerDraft): void {
  db.prepare(`
    INSERT INTO answer_drafts (
      id, question_id, format, bullets_json, structured, sources_json, risk, pinned, copied_at
    )
    VALUES (@id, @questionId, @format, @bulletsJson, @structured, @sourcesJson, @risk, @pinned, @copiedAt)
    ON CONFLICT(id) DO UPDATE SET
      question_id = excluded.question_id,
      format = excluded.format,
      bullets_json = excluded.bullets_json,
      structured = excluded.structured,
      sources_json = excluded.sources_json,
      risk = excluded.risk,
      pinned = excluded.pinned,
      copied_at = excluded.copied_at
  `).run({
    id: answer.id,
    questionId: answer.questionId,
    format: answer.format,
    bulletsJson: JSON.stringify(answer.stages.bullets),
    structured: answer.stages.structured,
    sourcesJson: JSON.stringify(answer.stages.sources),
    risk: answer.stages.risk,
    pinned: answer.pinned ? 1 : 0,
    copiedAt: answer.copiedAt ?? null,
  });
}

function insertPrompt(db: Database.Database, prompt: PromptSetting): void {
  db.prepare(`
    INSERT INTO prompts (id, title, body, variables_json, updated_at)
    VALUES (@id, @title, @body, @variablesJson, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      variables_json = excluded.variables_json,
      updated_at = excluded.updated_at
  `).run({ ...prompt, variablesJson: JSON.stringify(prompt.variables) });
}

function insertSessionArchive(
  db: Database.Database,
  summary: SessionArchiveSummary,
  state: RepositoryState,
): void {
  db.prepare(`
    INSERT INTO session_archives (
      id, title, mode, role, company, round, archived_at, question_count, answer_count, document_count, snapshot_json
    )
    VALUES (
      @id, @title, @mode, @role, @company, @round, @archivedAt,
      @questionCount, @answerCount, @documentCount, @snapshotJson
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      mode = excluded.mode,
      role = excluded.role,
      company = excluded.company,
      round = excluded.round,
      archived_at = excluded.archived_at,
      question_count = excluded.question_count,
      answer_count = excluded.answer_count,
      document_count = excluded.document_count,
      snapshot_json = excluded.snapshot_json
  `).run({
    ...summary,
    snapshotJson: JSON.stringify(state),
  });
}

function readSession(db: Database.Database): SessionSetup | null {
  const row = db.prepare("SELECT * FROM sessions WHERE singleton_id = 1").get() as SessionRow | undefined;
  if (!row) return null;
  return normalizeSessionSetup({
    id: row.id,
    mode: row.mode as SessionSetup["mode"],
    title: row.title,
    role: row.role,
    company: row.company,
    round: row.round as SessionSetup["round"],
    seniority: row.seniority,
    meetingTopic: row.meeting_topic || "",
    meetingAudience: row.meeting_audience || "",
    meetingGoal: row.meeting_goal || "",
    meetingNotes: row.meeting_notes || "",
    responseStyle: row.response_style as SessionSetup["responseStyle"],
    language: row.language,
    voiceProfile: (row.voice_profile || "staff-engineer") as SessionSetup["voiceProfile"],
    customVoice: row.custom_voice || "",
    answerFormat: (row.answer_format || "technical") as SessionSetup["answerFormat"],
    documents: readDocuments(db),
  });
}

function normalizeSessionSetup(session: SessionSetup): SessionSetup {
  return {
    ...session,
    meetingTopic: session.meetingTopic || "",
    meetingAudience: session.meetingAudience || "",
    meetingGoal: session.meetingGoal || "",
    meetingNotes: session.meetingNotes || "",
    voiceProfile: session.voiceProfile || "staff-engineer",
    customVoice: session.customVoice || "",
    answerFormat: session.answerFormat || "technical",
  };
}

function readDocuments(db: Database.Database): DocumentSummary[] {
  return (db.prepare("SELECT * FROM documents ORDER BY rowid").all() as DocumentRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category as DocumentSummary["category"],
    wordCount: row.word_count,
    status: row.status as DocumentSummary["status"],
  }));
}

function readDocumentIndexStatus(db: Database.Database): DocumentIndexStatus {
  const documents = readDocuments(db);
  const chunkCounts = new Map<string, number>(
    (db.prepare(`
      SELECT document_id, COUNT(*) AS chunk_count
      FROM document_chunks
      GROUP BY document_id
    `).all() as Array<{ document_id: string; chunk_count: number }>).map((row) => [row.document_id, row.chunk_count]),
  );
  const embeddingCounts = new Map<string, number>(
    (db.prepare(`
      SELECT document_id, COUNT(*) AS embedding_count
      FROM document_embeddings
      GROUP BY document_id
    `).all() as Array<{ document_id: string; embedding_count: number }>).map((row) => [row.document_id, row.embedding_count]),
  );
  return buildDocumentIndexStatus(documents, chunkCounts, embeddingCounts);
}

function effectiveDocumentStatus(
  document: DocumentSummary,
  chunkCount: number,
): DocumentSummary["status"] {
  if (document.status === "processing") return "processing";
  if (chunkCount === 0) return "failed";
  return document.status === "failed" ? "failed" : "indexed";
}

function buildDocumentIndexStatus(
  documents: DocumentSummary[],
  chunkCounts: Map<string, number> | RetrievedDocumentChunk[],
  embeddingCounts: Map<string, number> = new Map(),
): DocumentIndexStatus {
  const countFor = (documentId: string): number => {
    if (chunkCounts instanceof Map) return chunkCounts.get(documentId) || 0;
    return chunkCounts.filter((chunk) => chunk.documentId === documentId).length;
  };

  const enriched = documents.map((document) => {
    const chunkCount = countFor(document.id);
    const embeddingCount = embeddingCounts.get(document.id) || 0;
    const status = effectiveDocumentStatus(document, chunkCount);
    return {
      ...document,
      status,
      chunkCount,
      embeddingCount,
      searchable: status === "indexed" && chunkCount > 0,
    };
  });

  return {
    totalDocuments: documents.length,
    searchableDocuments: enriched.filter((document) => document.searchable).length,
    totalChunks: enriched.reduce((sum, document) => sum + document.chunkCount, 0),
    totalEmbeddings: enriched.reduce((sum, document) => sum + document.embeddingCount, 0),
    documents: enriched,
  };
}

function readDocumentChunks(db: Database.Database): RetrievedDocumentChunk[] {
  return (db.prepare(`
    SELECT
      document_chunks.id,
      document_chunks.document_id,
      documents.name AS document_name,
      documents.category,
      document_chunks.text
    FROM document_chunks
    INNER JOIN documents ON documents.id = document_chunks.document_id
    ORDER BY document_chunks.rowid
  `).all() as DocumentChunkRow[]).map((row) => ({
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    category: row.category as DocumentSummary["category"],
    text: row.text,
    score: 0,
  }));
}

function readTranscriptEvents(db: Database.Database): TranscriptEvent[] {
  return (db.prepare("SELECT * FROM transcript_events ORDER BY timestamp, rowid").all() as TranscriptRow[]).map(
    (row) => ({
      id: row.id,
      source: row.source as TranscriptEvent["source"],
      text: row.text,
      isFinal: Boolean(row.is_final),
      timestamp: row.timestamp,
    }),
  );
}

function readQuestions(db: Database.Database): QuestionCard[] {
  return (db.prepare("SELECT * FROM question_cards ORDER BY created_at, rowid").all() as QuestionRow[]).map(
    questionFromRow,
  );
}

function readQuestionById(db: Database.Database, id: string): QuestionCard | undefined {
  const row = db.prepare("SELECT * FROM question_cards WHERE id = ?").get(id) as QuestionRow | undefined;
  return row ? questionFromRow(row) : undefined;
}

function readQuestionByRawText(db: Database.Database, rawText: string): QuestionCard | undefined {
  const row = db.prepare("SELECT * FROM question_cards WHERE raw_text = ?").get(rawText) as
    | QuestionRow
    | undefined;
  return row ? questionFromRow(row) : undefined;
}

function readAnswerDrafts(db: Database.Database): AnswerDraft[] {
  return (db.prepare("SELECT * FROM answer_drafts ORDER BY rowid").all() as AnswerRow[]).map(answerFromRow);
}

function readAnswerDraftById(db: Database.Database, id: string): AnswerDraft | undefined {
  const row = db.prepare("SELECT * FROM answer_drafts WHERE id = ?").get(id) as AnswerRow | undefined;
  return row ? answerFromRow(row) : undefined;
}

function readAnswerDraftByQuestionId(db: Database.Database, questionId: string): AnswerDraft | undefined {
  const row = db.prepare("SELECT * FROM answer_drafts WHERE question_id = ?").get(questionId) as
    | AnswerRow
    | undefined;
  return row ? answerFromRow(row) : undefined;
}

function readPrompts(db: Database.Database): PromptSetting[] {
  return (db.prepare("SELECT * FROM prompts ORDER BY rowid").all() as PromptRow[]).map(promptFromRow);
}

function readPromptById(db: Database.Database, id: string): PromptSetting | undefined {
  const row = db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as PromptRow | undefined;
  return row ? promptFromRow(row) : undefined;
}

function readSessionArchives(db: Database.Database): SessionArchiveSummary[] {
  return (db.prepare(`
    SELECT id, title, mode, role, company, round, archived_at, question_count, answer_count, document_count
    FROM session_archives
    ORDER BY archived_at DESC, rowid DESC
  `).all() as SessionArchiveRow[]).map(sessionArchiveFromRow);
}

function readSessionArchiveState(db: Database.Database, id: string): RepositoryState | undefined {
  const row = db.prepare("SELECT snapshot_json FROM session_archives WHERE id = ?").get(id) as
    | { snapshot_json: string }
    | undefined;
  if (!row) return undefined;
  return normalizeState(parseJson<Partial<RepositoryState>>(row.snapshot_json, {}));
}

function questionFromRow(row: QuestionRow): QuestionCard {
  return {
    id: row.id,
    rawText: row.raw_text,
    framedQuestion: row.framed_question,
    type: row.type as QuestionCard["type"],
    confidence: row.confidence,
    evaluationIntent: row.evaluation_intent,
    createdAt: row.created_at,
    status: row.status as QuestionCard["status"],
  };
}

function answerFromRow(row: AnswerRow): AnswerDraft {
  return {
    id: row.id,
    questionId: row.question_id,
    format: row.format as AnswerDraft["format"],
    pinned: Boolean(row.pinned),
    copiedAt: row.copied_at ?? undefined,
    stages: {
      bullets: parseJson<string[]>(row.bullets_json, []),
      structured: row.structured,
      sources: parseJson<string[]>(row.sources_json, []),
      risk: row.risk,
    },
  };
}

function promptFromRow(row: PromptRow): PromptSetting {
  return {
    id: row.id as PromptSetting["id"],
    title: row.title,
    body: row.body,
    variables: parseJson<string[]>(row.variables_json, []),
    updatedAt: row.updated_at,
  };
}

function sessionArchiveFromRow(row: SessionArchiveRow): SessionArchiveSummary {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as SessionArchiveSummary["mode"],
    role: row.role,
    company: row.company,
    round: row.round as SessionArchiveSummary["round"],
    archivedAt: row.archived_at,
    questionCount: row.question_count,
    answerCount: row.answer_count,
    documentCount: row.document_count,
  };
}

function summarizeArchive(id: string, archivedAt: number, state: RepositoryState): SessionArchiveSummary {
  const session = state.session;
  if (!session) {
    throw new Error("Cannot archive without an active session.");
  }
  return {
    id,
    title: session.title,
    mode: session.mode,
    role: session.role,
    company: session.company,
    round: session.round,
    archivedAt,
    questionCount: state.questionCards.length,
    answerCount: state.answerDrafts.length,
    documentCount: state.documents.length,
  };
}

function normalizeState(state: Partial<RepositoryState>): RepositoryState {
  return {
    session: cloneSession(state.session ?? null),
    documents: (state.documents ?? state.session?.documents ?? []).map(cloneDocument),
    transcriptEvents: (state.transcriptEvents ?? []).map(cloneTranscriptEvent),
    questionCards: (state.questionCards ?? []).map(cloneQuestion),
    answerDrafts: (state.answerDrafts ?? []).map(cloneAnswer),
    prompts: clonePrompts(state.prompts),
    providerSettings: cloneProviderSettings(state.providerSettings),
  };
}

function snapshotFromParts(
  session: SessionSetup | null,
  documents: DocumentSummary[],
  transcriptEvents: TranscriptEvent[],
  questionCards: QuestionCard[],
  answerDrafts: AnswerDraft[],
  prompts: PromptSetting[],
  providerSettings: ProviderSettings = defaultProviderSettings(),
): RepositoryState {
  const clonedDocuments = documents.map(cloneDocument);
  return {
    session: session ? { ...session, documents: clonedDocuments } : null,
    documents: clonedDocuments,
    transcriptEvents: transcriptEvents.map(cloneTranscriptEvent),
    questionCards: questionCards.map(cloneQuestion),
    answerDrafts: answerDrafts.map(cloneAnswer),
    prompts: clonePrompts(prompts),
    providerSettings: cloneProviderSettings(providerSettings),
  };
}

function cloneSession(session: SessionSetup | null): SessionSetup | null {
  if (!session) return null;
  return normalizeSessionSetup({
    ...session,
    documents: session.documents.map(cloneDocument),
  });
}

function cloneDocument(document: DocumentSummary): DocumentSummary {
  return { ...document };
}

function cloneTranscriptEvent(event: TranscriptEvent): TranscriptEvent {
  return { ...event };
}

function cloneQuestion(question: QuestionCard): QuestionCard {
  return { ...question };
}

function cloneAnswer(answer: AnswerDraft): AnswerDraft {
  return {
    ...answer,
    stages: {
      bullets: [...answer.stages.bullets],
      structured: answer.stages.structured,
      sources: [...answer.stages.sources],
      risk: answer.stages.risk,
    },
  };
}

function clonePrompt(prompt: PromptSetting): PromptSetting {
  return {
    ...prompt,
    variables: [...prompt.variables],
  };
}

function cloneRetrievedChunk(chunk: RetrievedDocumentChunk): RetrievedDocumentChunk {
  return { ...chunk };
}

function clonePrompts(prompts: PromptSetting[] | undefined): PromptSetting[] {
  return prompts?.length ? prompts.map(clonePrompt) : defaultPrompts();
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((candidate) => candidate.id === nextItem.id);
  if (existingIndex < 0) return [...items, nextItem];
  return items.map((candidate, index) => (index === existingIndex ? nextItem : candidate));
}

function chunkDocument(document: DocumentSummary, text: string): RetrievedDocumentChunk[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const words = normalized.split(" ");
  const chunkSize = 120;
  const overlap = 24;
  const chunks: RetrievedDocumentChunk[] = [];

  for (let start = 0, index = 0; start < words.length; start += chunkSize - overlap, index += 1) {
    const chunkText = words.slice(start, start + chunkSize).join(" ").trim();
    if (!chunkText) continue;
    chunks.push({
      id: `${document.id}:${index}`,
      documentId: document.id,
      documentName: document.name,
      category: document.category,
      text: chunkText,
      score: 0,
    });
  }

  return chunks;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface SessionRow {
  id: string;
  mode: string;
  title: string;
  role: string;
  company: string;
  round: string;
  seniority: string;
  meeting_topic?: string;
  meeting_audience?: string;
  meeting_goal?: string;
  meeting_notes?: string;
  response_style: string;
  language: string;
  voice_profile?: string;
  custom_voice?: string;
  answer_format?: string;
}

interface DocumentRow {
  id: string;
  name: string;
  category: string;
  word_count: number;
  status: string;
}

interface DocumentChunkRow {
  id: string;
  document_id: string;
  document_name: string;
  category: string;
  text: string;
}

interface TranscriptRow {
  id: string;
  source: string;
  text: string;
  is_final: number;
  timestamp: number;
}

interface QuestionRow {
  id: string;
  raw_text: string;
  framed_question: string;
  type: string;
  confidence: number;
  evaluation_intent: string;
  created_at: number;
  status: string;
}

interface AnswerRow {
  id: string;
  question_id: string;
  format: string;
  bullets_json: string;
  structured: string;
  sources_json: string;
  risk: string;
  pinned: number;
  copied_at: number | null;
}

interface PromptRow {
  id: string;
  title: string;
  body: string;
  variables_json: string;
  updated_at: number;
}

interface SessionArchiveRow {
  id: string;
  title: string;
  mode: string;
  role: string;
  company: string;
  round: string;
  archived_at: number;
  question_count: number;
  answer_count: number;
  document_count: number;
}
