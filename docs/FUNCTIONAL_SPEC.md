# Second Chair Functional Specification

## Product Intent

Second Chair is a separate personal desktop product for high-pressure conversations, with interviews as the primary workflow and everyday office meetings as the secondary workflow.

The product listens to live audio, detects questions, reframes them with context, and lets the user generate fast, grounded answer guidance from their resume, job description, uploaded notes, and session setup.

This product should feel like a serious professional tool: quiet, precise, premium, and fast. It should not feel like a generic chat app, a transcript viewer with AI bolted on, or a visual clone of Tacet.

## Positioning

Primary positioning:

- A private real-time interview assistant for preparing, recalling, structuring, and improving answers during live conversations.

Secondary positioning:

- A live meeting intelligence assistant for normal work calls where the user wants help answering questions, remembering context, summarizing decisions, and tracking follow-ups.

Boundary:

- The product can be discreet and privacy-preserving, but product documentation should not specify deception, screen-share evasion, anti-monitoring, or bypass mechanics.

## Target User

- Job candidates preparing for behavioral, technical, system design, case, and hiring-manager interviews.
- Professionals who need support in live meetings where questions are asked quickly and context recall matters.
- Users who want answers grounded in their own background and documents instead of generic AI responses.

## Core User Promise

When someone asks a question, the product should make the user feel three things immediately:

- I understand what they are really asking.
- I have a structured answer path.
- I can respond in my own voice using my real experience.

## Product Modes

### Interview Mode

The main mode. Optimized for live interviews.

Capabilities:

- Session setup before the call.
- Role, company, interviewer, round type, and target level capture.
- Resume, job description, company notes, portfolio notes, and prepared Q&A uploads.
- Real-time question detection.
- Question-type classification.
- One-click answer streaming.
- Answer format controls.
- Post-session interview report.

### Meeting Mode

Secondary mode. Optimized for everyday work meetings.

Capabilities:

- Project/context setup.
- Document-grounded answers.
- Live action item detection.
- Follow-up suggestions.
- Meeting summary and decision log.
- Searchable session history.

## Session Setup Flow

Every new session starts with a setup screen. The user can skip optional fields, but the product should encourage enough context to make answers specific.

Required:

- Session mode: Interview or Meeting.
- Session title.

Interview fields:

- Target role.
- Company.
- Interview round type: recruiter, hiring manager, behavioral, technical, coding, system design, case, panel, final round, other.
- Target seniority.
- Interview language.
- Response style: concise, balanced, detailed, executive, conversational.

Optional interview fields:

- Interviewer names and titles.
- Job posting URL or pasted job description.
- Resume upload.
- Company notes.
- Personal project notes.
- Prepared question bank.
- Constraints: avoid mentioning, emphasize, preferred examples.

Meeting fields:

- Meeting type.
- Organization/project.
- Attendees.
- Agenda.
- Supporting documents.
- Desired output: answers, summary, action items, follow-up email.

## Onboarding

The onboarding must teach the product by doing, not by explaining too much.

Onboarding sequence:

1. Product purpose: live question detection and grounded response help.
2. Privacy model: what stays local, what goes to AI providers, what is stored.
3. Audio setup: microphone, system audio, and test transcription.
4. AI setup: model provider, API key, default model, latency preference.
5. First interview profile: role, resume, job description, response style.
6. Practice simulation: show a sample detected question and answer stream.
7. Session history: explain that each session is saved and reviewable.

Tone:

- Calm and premium.
- Short labels.
- No hype copy.
- No walls of instructional text.

## Main App Experience

The first screen after onboarding should be the actual working cockpit, not a landing page.

Layout concept:

- Left: session context and compact controls.
- Center: live question queue and active answer stream.
- Right: context drawer with documents, prompts, answer settings, and session notes.

The transcript should be available, but not visually dominant. The primary object is the question card.

## Live Question Cards

Each detected question becomes a card with:

- Framed question.
- Raw transcript excerpt.
- Question type.
- Confidence.
- Speaker/time.
- Context note: what the interviewer is likely evaluating.
- Actions: answer, bullets, STAR, clarify, save, dismiss.

Question types:

- Behavioral.
- Technical concept.
- Coding/problem solving.
- System design.
- Situational.
- Culture fit.
- Resume/project deep dive.
- Follow-up.
- Compensation/logistics.
- Meeting operational question.

## Answer Streaming

Answers should stream in layers:

1. Immediate glanceable bullets.
2. Structured response.
3. Evidence from user documents.
4. Optional follow-up sentence.
5. Risk note if the model is uncertain.

Answer formats:

- Quick bullets.
- STAR.
- Full conversational answer.
- Technical explanation.
- System design outline.
- Coding approach.
- Executive concise.
- Follow-up question.

The first useful content should appear as fast as possible, even if the full answer continues streaming.

## Document Context

Supported uploads:

- PDF.
- DOCX.
- TXT.
- Markdown.
- JSON.
- Pasted text.

Document categories:

- Resume.
- Job description.
- Company research.
- Project notes.
- Prepared Q&A.
- Portfolio.
- Meeting brief.

Document behavior:

- Extract text.
- Chunk and index locally.
- Tag chunks by document type.
- Retrieve relevant context for each detected question.
- Show source chips in generated answers.
- Warn when an answer is not grounded in available context.

## Settings

Settings should be first-class, not hidden behind a basic modal.

Sections:

- AI provider and models.
- System prompts.
- Answer style.
- Question detection.
- Document storage.
- Audio devices.
- Privacy and retention.
- Hotkeys.
- Session defaults.
- Export.

System prompt settings:

- Global assistant prompt.
- Interview-mode prompt.
- Meeting-mode prompt.
- Behavioral answer prompt.
- Technical answer prompt.
- System design prompt.
- Coding prompt.
- Follow-up prompt.
- Refusal/uncertainty behavior.

Prompt UX:

- Version history.
- Reset to default.
- Test prompt with sample question.
- Variables preview, such as `{{role}}`, `{{company}}`, `{{resume_context}}`, and `{{question}}`.

## Sessions

Every live run is a session.

Session records include:

- Setup fields.
- Uploaded document references.
- Transcript.
- Detected questions.
- Generated answers.
- User edits.
- Saved highlights.
- Action items.
- Post-session analysis.

Session actions:

- Rename.
- Duplicate setup.
- Pin.
- Search.
- Export.
- Delete.
- Continue as practice session.

## Post-Session Report

Interview report:

- Question timeline.
- Question type breakdown.
- Strong answer opportunities.
- Weak answer risks.
- Missing resume/JD alignment.
- Suggested stories to prepare.
- Follow-up email draft.
- Practice queue generated from missed areas.

Meeting report:

- Summary.
- Decisions.
- Action items.
- Open questions.
- Follow-up email or Slack recap.
- Relevant document references.

## UI Direction

The UI should feel like a focused operator console built by a premium productivity company.

Design traits:

- Quiet, high-contrast, refined typography.
- Dense but calm information layout.
- Minimal decoration.
- Strong alignment and spacing discipline.
- Cards only for repeated entities like question cards and sessions.
- No generic gradient hero, oversized marketing panels, or decorative blobs.

Visual metaphor:

- A live briefing desk.
- The app should make the next useful action obvious without shouting.

Key screens:

- Onboarding.
- New session setup.
- Live cockpit.
- Prompt/settings studio.
- Document library.
- Session history.
- Post-session report.

## MVP Acceptance Criteria

- User can create an interview session with role, company, round type, JD, resume, and response style.
- User can capture live system/mic audio and see transcript.
- App detects candidate questions from recent transcript.
- User can click a detected question and stream an answer.
- Answer uses uploaded resume/JD context when relevant.
- User can edit system prompts.
- Session saves transcript, questions, and answers.
- User can reopen a past session.
