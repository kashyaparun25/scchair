export type SessionMode = "interview" | "meeting";

export type InterviewRound =
  | "recruiter"
  | "hiring-manager"
  | "behavioral"
  | "technical"
  | "coding"
  | "system-design"
  | "case"
  | "panel"
  | "final"
  | "other";

export type QuestionType =
  | "behavioral"
  | "technical"
  | "coding"
  | "system-design"
  | "situational"
  | "culture"
  | "resume"
  | "follow-up"
  | "logistics"
  | "meeting";

export type AnswerFormat =
  | "quick-bullets"
  | "star"
  | "full"
  | "technical"
  | "system-design"
  | "coding"
  | "executive"
  | "follow-up";

export type VoiceProfile = "product-lead" | "staff-engineer" | "executive" | "consultant" | "custom";

export interface SessionSetup {
  id: string;
  mode: SessionMode;
  title: string;
  role: string;
  company: string;
  round: InterviewRound;
  seniority: string;
  meetingTopic: string;
  meetingAudience: string;
  meetingGoal: string;
  meetingNotes: string;
  responseStyle: "concise" | "balanced" | "detailed" | "executive" | "conversational";
  language: string;
  voiceProfile: VoiceProfile;
  customVoice: string;
  answerFormat: AnswerFormat;
  documents: DocumentSummary[];
}

export interface DocumentSummary {
  id: string;
  name: string;
  category: "resume" | "job-description" | "company-notes" | "project-notes" | "qa-bank" | "meeting-brief";
  wordCount: number;
  status: "indexed" | "processing" | "failed";
}

export interface TranscriptEvent {
  id: string;
  source: "system" | "mic" | "mixed";
  text: string;
  isFinal: boolean;
  timestamp: number;
}

export interface QuestionCard {
  id: string;
  rawText: string;
  framedQuestion: string;
  type: QuestionType;
  confidence: number;
  evaluationIntent: string;
  createdAt: number;
  status: "new" | "answering" | "answered" | "saved" | "dismissed";
}

export interface AnswerDraft {
  id: string;
  questionId: string;
  format: AnswerFormat;
  pinned?: boolean;
  copiedAt?: number;
  stages: {
    bullets: string[];
    structured: string;
    sources: string[];
    risk: string;
  };
}

export interface PromptSetting {
  id: "answer-generator" | "question-framer" | "meeting-summarizer";
  title: string;
  body: string;
  variables: string[];
  updatedAt: number;
}

export type ProviderCapability = "stt" | "llm" | "embeddings";

/** Endpoint id from settings, or "local" for offline fallback. */
export type ProviderId = string;

export interface ProviderModelSetting {
  capability: ProviderCapability;
  provider: ProviderId;
  model: string;
  adapter: "local-fallback" | "external";
  enabled: boolean;
  adapterType?: string;
  baseUrl?: string;
  updatedAt: number;
}

export type ProviderSettings = Record<ProviderCapability, ProviderModelSetting>;

export interface SessionArchiveSummary {
  id: string;
  title: string;
  mode: SessionMode;
  role: string;
  company: string;
  round: InterviewRound;
  archivedAt: number;
  questionCount: number;
  answerCount: number;
  documentCount: number;
}
