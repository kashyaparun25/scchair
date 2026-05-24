# Second Chair Phase Tracker

## Current Status

Status: Functional MVP in progress

The product is separate from Tacet. Tacet is only a reference for useful implementation patterns around local audio capture, streaming transcription, and session persistence.

## Phase 0: Product Definition

Status: Mostly complete for MVP

Goal: lock the product shape before implementation.

- [x] Define product as a separate application.
- [x] Define primary interview workflow and secondary meeting workflow.
- [x] Define session setup requirements.
- [x] Define settings and prompt studio requirements.
- [x] Define live question and answer workflow.
- [x] Define high-level technical architecture.
- [x] Choose working product name: Second Chair.
- [x] Choose final stack: React/TypeScript for frontend, local Node/Express API for backend.
- [x] Choose initial AI provider adapter targets. (Local fallback first; OpenAI/Anthropic adapters are configurable when env keys exist.)
- [ ] Decide first target platform: macOS first or cross-platform from day one.

## Phase 1: Foundation App

Status: In progress

Goal: create the standalone desktop app shell and local backend.

- [x] Create new app root outside Tacet or under a clearly separate workspace folder.
- [x] Add Electron shell.
- [x] Add frontend app scaffold.
- [x] Add local Node backend.
- [x] Add SQLite database.
- [x] Add migrations.
- [x] Add app settings store. (Current: SQLite-backed local state with legacy JSON import.)
- [x] Add secure preload bridge.
- [x] Add base navigation: Session Setup, Live Assist, Knowledge, Prompt Studio, Review.
- [x] Add initial visual system: typography, colors, spacing, icons, layout rules.

Acceptance:

- App launches as its own product.
- User can navigate the core sections.
- Database initializes locally.

## Phase 2: Session Setup And Document Library

Status: In progress

Goal: make every session context-rich before audio starts.

- [x] Build new session setup flow.
- [x] Add Interview Mode setup fields.
- [ ] Add Meeting Mode setup fields.
- [x] Add document upload. (Current: pasted text prompt stored through local API.)
- [x] Add pasted text document creation.
- [x] Extract text from TXT and Markdown.
- [x] Extract text from PDF.
- [x] Extract text from DOCX.
- [x] Store documents locally.
- [x] Link documents to sessions.
- [ ] Add document category tagging.

Acceptance:

- User can create a session with role, company, round type, resume, and JD.
- Session context persists and is visible in the live cockpit.

## Phase 3: Audio And Transcription

Status: In progress

Goal: capture live audio and produce normalized transcript events.

- [x] Add browser microphone transcription. (Current: Web Speech API where available; backend STT fallback available when configured.)
- [x] Add system audio capture path. (Current: browser display capture with audio where platform support exists.)
- [x] Stream PCM/audio to backend.
- [x] Add STT provider adapter scaffolding.
- [x] Normalize transcript event shape.
- [x] Persist transcript events.
- [x] Render compact transcript drawer.
- [x] Add audio status and failure states. (Current: UI toggles only; native capture pending.)

Acceptance:

- User can start a session and see live transcript from at least one audio source.
- Transcript events are persisted against the active session.

## Phase 4: Live Question Detection

Status: In progress

Goal: convert transcript into useful question cards.

- [x] Build rolling transcript window.
- [x] Add heuristic question detector.
- [x] Add LLM question reframer/classifier.
- [x] Add duplicate suppression.
- [x] Add question confidence scoring.
- [x] Render live question queue.
- [x] Add dismiss/save actions.
- [x] Persist questions.
- [x] Create a question directly from selected transcript text.

Acceptance:

- Interviewer questions appear as framed question cards.
- Cards include type, confidence, and evaluation intent.

## Phase 5: Answer Streaming

Status: In progress

Goal: generate fast, structured answers from question cards.

- [x] Add answer generation endpoint. (Current: OpenAI provider when configured, deterministic local fallback otherwise.)
- [x] Add streaming response transport.
- [x] Add answer format selector.
- [x] Add quick bullets stage.
- [x] Add structured answer stage.
- [x] Add uncertainty/risk stage.
- [x] Persist answers.
- [x] Add transcript copy action.
- [x] Add answer copy and pin actions.

Acceptance:

- User clicks a question and sees useful answer bullets quickly.
- Full answer streams into a stable answer panel.

## Phase 6: Retrieval And Grounding

Status: In progress

Goal: make answers specific to uploaded documents and session setup.

- [x] Chunk extracted documents.
- [x] Add embeddings provider scaffolding.
- [x] Build local retrieval. (Current: deterministic keyword scorer; embeddings provider pending.)
- [x] Retrieve context per question.
- [x] Add source chips to answers.
- [x] Add weak-context warnings.
- [ ] Add controls for document priority.

Acceptance:

- Answers reference the user resume/JD/company notes when relevant.
- UI clearly shows when an answer is grounded or weakly grounded.

## Phase 7: Prompt Studio And Settings

Status: In progress

Goal: give advanced users deep control without making the live UI complex.

- [ ] Build full settings workspace.
- [x] Add provider/model settings.
- [x] Add system prompt editor.
- [x] Add prompt variables.
- [ ] Add prompt version history.
- [ ] Add reset defaults.
- [ ] Add prompt test runner.
- [ ] Add hotkey settings.
- [ ] Add privacy/retention settings.

Acceptance:

- User can edit interview, meeting, and answer-type prompts.
- User can test a prompt before using it live.

## Phase 8: Session History And Reports

Status: Not started

Goal: make the product useful after the live call ends.

- [x] Build session history.
- [ ] Add search across sessions.
- [ ] Add filters by company, role, round type, date, mode.
- [x] Add question timeline.
- [x] Generate interview report. (Current: local deterministic report from stored session questions.)
- [ ] Generate meeting report.
- [ ] Add follow-up email drafts.
- [x] Add practice queue from missed topics.
- [x] Add export.

Acceptance:

- User can reopen a session and review questions, answers, transcript, documents, and report.

## Phase 9: Polish, Reliability, Packaging

Status: Not started

Goal: make it feel like a premium product rather than a prototype.

- [x] Add empty states and loading states.
- [x] Add error recovery for audio, STT, LLM, and document parsing.
- [x] Add keyboard-first live workflow.
- [ ] Add responsive desktop window sizing.
- [x] Add accessibility pass.
- [ ] Add performance profiling.
- [ ] Add packaged macOS build.
- [ ] Add packaged Windows build.
- [ ] Add auto-update plan.

Acceptance:

- App can be used for a full interview-length session without manual recovery.
- Packaged build installs and runs outside the dev environment.

## Immediate Next Decisions

- Initial platform target.
- AI providers.
- Whether to scaffold in `interview-copilot/` inside this workspace or as a sibling directory outside Tacet.
- Whether MVP should use Tacet's vanilla style for speed or start with React/TypeScript for long-term maintainability.
