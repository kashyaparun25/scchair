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

export const answerFormatOptions = [
  { label: "Bullets", value: "quick-bullets" },
  { label: "STAR", value: "star" },
  { label: "Full", value: "full" },
  { label: "Technical", value: "technical" },
  { label: "System design", value: "system-design" },
  { label: "Coding", value: "coding" },
  { label: "Executive", value: "executive" },
  { label: "Follow-up", value: "follow-up" },
] as const satisfies ReadonlyArray<{ label: string; value: AnswerFormat }>;

export const answerFormats = answerFormatOptions.map((option) => option.value);

export type ResponsePersona =
  | "product-lead"
  | "staff-engineer"
  | "executive"
  | "consultant"
  | "support"
  | "sales-engineer"
  | "data-analyst"
  | "designer"
  | "engineering-manager"
  | "recruiter-hiring-manager"
  | "technical-support"
  | "custom";

export type VoiceProfile = ResponsePersona;

export const responsePersonaOptions = [
  { label: "Product lead", value: "product-lead", note: "Outcomes, sequencing, launch judgment" },
  { label: "Staff engineer", value: "staff-engineer", note: "Architecture, influence, risk" },
  { label: "Executive", value: "executive", note: "Crisp, strategic, business impact first" },
  { label: "Consultant", value: "consultant", note: "Structured, hypothesis-driven, client-safe" },
  { label: "Support", value: "support", note: "Empathetic, practical, customer-aware" },
  { label: "Sales engineer", value: "sales-engineer", note: "Discovery, solution fit, technical value" },
  { label: "Data analyst", value: "data-analyst", note: "Metrics, assumptions, decision clarity" },
  { label: "Designer", value: "designer", note: "User needs, craft, product judgment" },
  { label: "Engineering manager", value: "engineering-manager", note: "Team health, execution, ownership" },
  { label: "Recruiter / hiring manager", value: "recruiter-hiring-manager", note: "Fit, motivation, hiring signal" },
  { label: "Technical support", value: "technical-support", note: "Troubleshooting, clarity, customer resolution" },
  { label: "Custom", value: "custom", note: "Describe your own response persona below" },
] as const satisfies ReadonlyArray<{ label: string; value: ResponsePersona; note: string }>;

export const responsePersonas = responsePersonaOptions.map((option) => option.value);

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

export interface LocalProfile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
}

export interface AuditEvent {
  id: string;
  profileId: string | null;
  eventType: string;
  entityType: string;
  entityId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

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
