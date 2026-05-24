# Second Chair Technical Specification

## Architecture Goal

Build a separate desktop product with its own repository structure, visual identity, storage model, and product workflows.

The implementation may reuse proven ideas from Tacet:

- Local Electron shell.
- Local Node server.
- WebSocket audio/transcript streaming.
- Mic and system audio capture.
- Normalized transcript message protocol.
- File-backed local sessions.

It should not reuse Tacet branding, UI layout, copy, or information architecture.

## Proposed Stack

Desktop:

- Electron.
- Secure preload bridge.
- Native permissions and audio helpers.

Frontend:

- React or lightweight vanilla modules are both viable.
- Recommendation: React + TypeScript for this product because settings, session setup, prompt editing, document library, and live state will become complex.
- Vite for local development.

Backend:

- Local Node.js service.
- Express for REST APIs.
- WebSocket for audio/transcript/event streaming.
- Server-sent events or streaming fetch for answer generation.

Storage:

- Local app data directory.
- SQLite for sessions, documents, prompt versions, and answer records.
- Local file storage for uploaded originals.
- Vector index stored locally.

AI:

- STT provider abstraction.
- LLM provider abstraction.
- Embedding provider abstraction.
- Default cloud path for speed.
- Optional local path later for privacy/offline modes.

## High-Level Modules

### Desktop Shell

Responsibilities:

- Own native window lifecycle.
- Manage permissions.
- Expose safe audio/system APIs through preload.
- Provide app data paths to backend.
- Support global hotkeys.

### Audio Capture

Responsibilities:

- Capture microphone audio.
- Capture system audio.
- Keep channels separately identifiable where possible.
- Send PCM frames to transcription engine.

Important design choice:

- Prefer separate mic and system channels when available. Interview question detection should prioritize system/interviewer audio over the user microphone.

### Transcription Service

Responsibilities:

- Stream audio to STT provider.
- Emit interim and final transcript events.
- Track speaker/source if available.
- Normalize all providers into one event shape.

Normalized transcript event:

```json
{
  "type": "transcript",
  "sessionId": "session-id",
  "source": "system|mic|mixed",
  "text": "Tell me about yourself",
  "isFinal": true,
  "timestamp": 1778370000000,
  "sequence": 42
}
```

### Question Detection Service

Responsibilities:

- Consume recent transcript windows.
- Detect candidate questions.
- Merge fragmented question text.
- Classify question type.
- Produce a framed question with context.
- Avoid duplicate cards.

Inputs:

- Last 15-45 seconds of transcript.
- Current session setup.
- Recent detected questions.
- Optional active document snippets.

Output:

```json
{
  "id": "question-id",
  "sessionId": "session-id",
  "rawText": "So can you walk me through a time...",
  "framedQuestion": "Tell me about a time you handled a difficult stakeholder.",
  "type": "behavioral",
  "confidence": 0.86,
  "evaluationIntent": "Communication, ownership, conflict resolution",
  "createdAt": 1778370000000,
  "status": "new"
}
```

Detection strategy:

- Phase 1: heuristic + fast LLM classifier on finalized transcript blocks.
- Phase 2: lower-latency streaming classifier on partial transcript.
- Phase 3: audio-source-aware classifier that prioritizes interviewer channel.

### Answer Generation Service

Responsibilities:

- Accept a question card and answer format.
- Retrieve relevant document context.
- Build prompt from system settings and session fields.
- Stream response chunks to UI.
- Persist answer and sources.

Answer event shape:

```json
{
  "type": "answer_delta",
  "answerId": "answer-id",
  "questionId": "question-id",
  "stage": "bullets|structured|sources|risk",
  "delta": "Start with the project where..."
}
```

Generation strategy:

- First stream quick bullets.
- Then stream structured answer.
- Then append source chips and caveats.

### Document Ingestion

Responsibilities:

- Accept uploads and pasted text.
- Extract text.
- Store original and extracted text.
- Chunk text.
- Embed chunks.
- Tag chunks by document category.

Document schema:

- `documents`
- `document_chunks`
- `document_embeddings`
- `session_documents`

Extraction:

- PDF: `pdf-parse` or equivalent.
- DOCX: `mammoth` or equivalent.
- TXT/MD: native text.

### Prompt Studio

Responsibilities:

- Store editable prompt templates.
- Support prompt variables.
- Keep version history.
- Provide reset-to-default.
- Test prompt against sample question.

Prompt template types:

- global.
- interview.
- meeting.
- behavioral.
- technical.
- system_design.
- coding.
- follow_up.
- uncertainty.

### Sessions

Responsibilities:

- Create setup record before audio starts.
- Persist transcript events.
- Persist detected questions.
- Persist generated answers.
- Persist uploaded document links.
- Generate post-session report.

Core tables:

- `sessions`
- `session_setup`
- `transcript_events`
- `questions`
- `answers`
- `answer_sources`
- `documents`
- `prompts`
- `prompt_versions`
- `reports`

## API Surface

Implemented local MVP REST:

- `GET /api/bootstrap`
- `POST /api/sessions`
- `GET /api/sessions/history`
- `POST /api/sessions/archive`
- `GET /api/sessions/:id/export`
- `POST /api/documents`
- `POST /api/documents/upload`
- `GET /api/settings/providers`
- `PATCH /api/settings/providers`
- `POST /api/transcript`
- `POST /api/questions`
- `PATCH /api/questions/:id/status`
- `PATCH /api/answers/:id`
- `POST /api/questions/:id/answer`
- `POST /api/questions/:id/answer/stream`
- `POST /api/reports`
- `DELETE /api/state`

Target production REST:

- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `POST /api/documents`
- `GET /api/documents`
- `DELETE /api/documents/:id`
- `GET /api/prompts`
- `PATCH /api/prompts/:id`
- `POST /api/prompts/:id/test`
- `POST /api/questions`
- `POST /api/questions/:id/answer`
- `POST /api/sessions/:id/report`

WebSocket:

- `/ws/audio`
- Client sends audio frames and control messages.
- Server emits transcript events, question events, status events.

Streaming:

- `POST /api/questions/:id/answer/stream`
- Streams answer deltas.

## Live Event Pipeline

1. User creates session.
2. User starts audio capture.
3. Audio frames stream to local backend.
4. STT emits transcript events.
5. Transcript events persist to SQLite.
6. Question detector consumes rolling window.
7. UI receives question cards.
8. User clicks answer.
9. Retrieval service fetches relevant context.
10. LLM streams answer.
11. Answer and source links persist.

## Latency Targets

- Transcript interim display: under 500 ms after STT result.
- Question card after finalized question: under 1.5 seconds.
- First answer bullets after click: under 1.0 second.
- Full answer: under 5 seconds for common behavioral questions.

## Privacy And Retention

Defaults:

- Store sessions locally.
- Store uploaded docs locally.
- Let user delete all session data.
- Show whether AI calls leave the device.
- Do not retain raw audio by default.

Settings:

- Retention period.
- Store transcript only.
- Store questions and answers.
- Disable post-session report.
- Provider selection.

## UI Engineering Notes

The UI should be designed around live pressure.

Critical interaction rules:

- The current question and current answer must be visually dominant.
- Transcript is secondary.
- Every control should be reachable without searching.
- Hotkeys should cover the live workflow.
- Text must not resize layout while streaming.
- Answer cards need stable dimensions and scroll behavior.
- Settings should be a full workspace, not a cramped modal.

## Borrowed From Tacet

Reusable concepts:

- Audio capture graph.
- Online/offline transcription abstraction.
- WebSocket event dispatcher.
- Session auto-save discipline.
- Local desktop-first mindset.

Do not copy:

- Tacet name, brand, visual design.
- Existing transcript-first layout.
- Onboarding copy.
- Feature naming.

## Technical Risks

- System audio capture reliability across macOS and Windows.
- Latency when chaining STT, question detection, retrieval, and answer generation.
- Question duplication from partial transcripts.
- Hallucinated answers when document context is weak.
- Prompt customization causing poor answer quality.
- Sensitive document handling.

## Early Technical Decisions

- Build as desktop-first.
- Use SQLite instead of JSON files.
- Separate system and mic audio as soon as practical.
- Make prompts configurable from day one.
- Make answer generation explicit by click in MVP.
- Keep automatic answer generation as a later setting.
