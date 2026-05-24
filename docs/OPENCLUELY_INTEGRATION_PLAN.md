# OpenCluely Integration Plan

## Objective

Transform Second Chair into a stable desktop interview-assistant prototype that demonstrates the OpenCluely-style floating assistant experience while preserving Second Chair's stronger product architecture: session setup, uploaded knowledge sources, question detection, grounded answer generation, provider settings, and session review.

The product must be a general interview assistant, not a coding-only helper. It should support verbal interviews across technical and non-technical domains: software engineering, DevOps, cloud, support, customer success, sales engineering, operations, product, leadership, system design, behavioral rounds, scenario-based rounds, and hiring-manager conversations. Coding help is one specialized workflow inside the broader interview system.

This plan uses OpenCluely as an implementation reference for compact desktop controls, screenshot capture, hotkeys, draggable floating windows, and quick answer display. It does not use OpenCluely as the main application base because Second Chair already has the better long-term structure for interviews and meetings.

## Current Understanding

### OpenCluely

OpenCluely is overlay-first. Its useful pieces are:

- Compact floating command bar.
- Screenshot capture button and global shortcut.
- Language selector for code responses when a coding workflow is active.
- Skill prompt selector pattern, though the implementation is currently too narrow and effectively focused on DSA.
- Detached answer window with markdown and code rendering.
- Chat window with session memory.
- Electron global shortcuts.
- Draggable always-on-top windows.
- Click-through window mode using Electron mouse-event forwarding.
- Optional Azure/local speech service scaffolding.

OpenCluely's weaker or unstable pieces are:

- The product logic is thin and mostly prompt/session-memory based.
- Only the DSA skill is meaningfully wired.
- Settings persistence is incomplete.
- Local Whisper setup is fragile and should not be part of the first integration.
- Screen-sharing detection code appears incomplete because it fetches capture sources but does not actually update screen-sharing state.
- Build config references missing or misspelled asset paths.
- Certificate override behavior should not be copied.

### Second Chair

Second Chair is workflow-first. Its useful pieces are:

- React + TypeScript UI.
- Local Express API.
- SQLite-backed repository.
- Session setup for interview and meeting modes.
- Document upload and ingestion.
- Resume, job description, notes, and prompt context.
- Transcript ingestion.
- Question detection and reframing.
- Answer streaming.
- Prompt settings.
- Provider settings for OpenAI, Anthropic, Gemini, and local fallback.
- Session review and export.

Second Chair's current gaps are:

- Desktop shell is too minimal.
- Electron mode does not reliably start the local API by itself.
- Permission handling denies needed media permissions.
- Audio capture is not yet as strong as the root Tacet app.
- Live UI is a full cockpit, not a compact floating assistant.
- Screenshot capture is not integrated into the answer pipeline.

### Root Tacet App

Tacet is capture/transcription-first. Its useful pieces are:

- Electron shell that starts the local server process.
- Existing browser audio capture and mixing patterns.
- System-audio bridge concepts.
- Real-time transcription-oriented session flow.

## Product Direction

The final prototype should have two surfaces:

1. A full desktop app for setup, knowledge, prompts, settings, and review.
2. A compact floating overlay for live use.

The overlay should feel close to OpenCluely: small, quick, draggable, keyboard-driven, and able to show a detached answer panel. The intelligence and persistence should come from Second Chair.

The default product posture should be general live interview help. Coding, system design, cloud troubleshooting, support scenarios, behavioral examples, and role-specific verbal answers should all be handled through the same question-card and answer-generation pipeline.

## Target Experience

### Setup Flow

Before a session, the user can:

- Choose Interview or Meeting mode.
- Set role, company, seniority, round type, domain, and answer style.
- Choose an interview domain: general, behavioral, technical verbal, coding, system design, DevOps, cloud, support, customer success, sales engineering, product, leadership, operations, or custom.
- Upload or paste resume.
- Upload or paste job description.
- Upload or paste company notes, project notes, and prepared Q&A.
- Select provider: OpenAI first, Gemini optional.
- Select transcription model.
- Select answer model.
- Select answer formats: quick bullets, STAR, technical explanation, troubleshooting path, customer-facing response, system design outline, coding approach, executive concise, follow-up question, or conversational answer.

### Live Overlay

The live overlay should include:

- Mic/system-audio status.
- Start/stop listening.
- Screenshot capture.
- Latest detected question indicator.
- Generate answer button.
- Answer format selector.
- Domain selector or compact role profile selector.
- Code language selector only when coding mode is active.
- Show/hide answer panel.
- Open full cockpit/settings.
- Click-through toggle for easier screen placement.

The overlay should not be the only way to use the app. It is the fast control surface for live sessions.

### Answer Panel

The detached answer panel should show:

- Detected/framed question.
- Question type and interview domain.
- Immediate bullets first.
- Structured answer as it streams.
- Source chips from uploaded documents.
- Risk/grounding note when document context is weak.
- Copy action.
- Pin/save action.
- Dismiss action.

### Screenshot Flow

The screenshot flow should work like this:

1. User presses the screenshot button or hotkey.
2. Electron captures the selected screen or primary display.
3. The image is sent to the configured vision-capable provider.
4. The server creates a question card, scenario card, system-design card, troubleshooting card, or coding prompt card depending on the content.
5. The answer stream appears in the answer panel.

For coding prompts, the selected programming language should be passed into the answer-generation prompt. For non-coding prompts, the active domain and role profile should drive the structure instead.

### Interview Coverage

The app should classify and answer across these categories:

- Behavioral: ownership, conflict, leadership, ambiguity, failure, collaboration.
- Resume/project deep dive: explain past work, impact, tradeoffs, metrics, lessons.
- Technical verbal: concepts, architecture, APIs, databases, networking, security, scalability.
- System design: requirements, constraints, architecture, data model, tradeoffs, failure modes.
- DevOps/cloud: incidents, CI/CD, observability, AWS/Azure/GCP, Kubernetes, Terraform, reliability.
- Support/customer success: troubleshooting, escalation, empathy, RCA, customer communication.
- Sales engineering: discovery, objection handling, demos, solution fit, technical validation.
- Product/operations: prioritization, process design, metrics, stakeholder management.
- Coding/problem solving: algorithm, debugging, complexity, implementation.
- Culture and logistics: motivation, compensation, availability, work style.
- Follow-up questions: clarifying, narrowing, or responding to interviewer pushback.

Each category should have an answer strategy:

- Behavioral should default to STAR or concise narrative.
- Technical verbal should default to structured concept explanation with examples.
- System design should default to requirements, architecture, tradeoffs, and risks.
- DevOps/cloud should default to diagnosis, mitigation, prevention, and tooling.
- Support should default to customer-safe language, troubleshooting steps, and escalation.
- Sales engineering should default to discovery, mapping pain to solution, and validation.
- Coding should default to approach, complexity, edge cases, and code only when useful.

### Audio and Transcription Flow

For the first stable version, do not add local Whisper.

Preferred path:

- Use OpenAI realtime transcription for live audio.
- Use OpenAI transcription file endpoint as fallback for chunked recording.
- Keep Gemini as an optional LLM/vision provider, not the first speech provider.

OpenAI provider targets:

- Live transcription: Realtime transcription sessions using `gpt-4o-transcribe` or `gpt-4o-mini-transcribe`.
- Chunk fallback: `/v1/audio/transcriptions`.
- Answer generation: streaming answer API through the existing provider abstraction.

The transcript pipeline should continue to produce Second Chair's normalized transcript event shape:

```json
{
  "type": "transcript",
  "sessionId": "session-id",
  "source": "system|mic|mixed",
  "text": "Tell me about a time you handled conflict.",
  "isFinal": true,
  "timestamp": 1778370000000,
  "sequence": 42
}
```

## Borrowed OpenCluely Capabilities

### Keep and Adapt

- Floating command bar.
- Detached answer panel.
- Global shortcut registration.
- Screenshot capture via Electron `desktopCapturer`.
- Draggable windows.
- Click-through toggle via `setIgnoreMouseEvents`.
- Always-on-top user-controlled overlay behavior.
- Markdown/code rendering in answer panel.
- Domain-aware answer controls.
- Language selector for coding answers only.
- Settings entry point from overlay.

### Rebuild Instead of Copying Directly

- Window manager should be rewritten in TypeScript-compatible style for Second Chair.
- Preload bridge should expose a small, typed API instead of OpenCluely's broad IPC surface.
- Settings should persist through Second Chair's repository/settings layer.
- Speech should use provider abstraction rather than OpenCluely's Azure/Whisper singleton.
- Screenshot results should become question cards, not one-off session-memory messages.

### Exclude From Integration

- Gemini TLS certificate override.
- Broken automatic screen-sharing detection.
- Process name/icon disguise as a core feature.
- OpenCluely's build config.
- Local Whisper bootstrap for phase one.
- Broad IPC channel exposure.

## Architecture Plan

### Electron Shell

Files likely touched:

- `interview-copilot/electron/main.js`
- `interview-copilot/electron/preload.cjs`
- New `interview-copilot/electron/windowManager.*`
- New `interview-copilot/electron/serverProcess.*`

Responsibilities:

- Start the local API during desktop launch.
- Load Vite dev URL in development.
- Load built UI in production.
- Manage main app window.
- Manage floating overlay window.
- Manage detached answer window.
- Register global shortcuts.
- Provide screenshot capture IPC.
- Provide safe media permission handling.
- Cleanly shut down child server process.

### Server/API

Files likely touched:

- `interview-copilot/src/server/http.ts`
- `interview-copilot/src/server/speechToText.ts`
- `interview-copilot/src/server/aiAnswerGeneration.ts`
- `interview-copilot/src/server/providerSettings.ts`
- New `interview-copilot/src/server/screenshotAnalysis.ts`
- New `interview-copilot/src/server/realtimeTranscription.ts`

Responsibilities:

- Add OpenAI realtime transcription provider.
- Add screenshot-analysis endpoint.
- Convert screenshot analysis into a question card.
- Stream answer from question card.
- Preserve document retrieval and source chips.
- Persist transcript, question, answer, and screenshot-derived prompt metadata.

### Frontend

Files likely touched:

- `interview-copilot/src/ui/App.tsx`
- `interview-copilot/src/styles/app.css`
- New `interview-copilot/src/ui/OverlayApp.tsx`
- New `interview-copilot/src/ui/AnswerWindow.tsx`
- New route or entry points in `interview-copilot/src/main.tsx`

Responsibilities:

- Keep full cockpit.
- Add overlay-specific entry point.
- Add answer-panel-specific entry point.
- Share state through API polling, SSE, WebSocket, or Electron IPC events.
- Add provider settings for OpenAI realtime transcription.
- Add screenshot status and latest question state.

### Storage

Existing SQLite repository should remain primary.

Needed additions:

- Persist hotkey settings.
- Persist overlay position and size.
- Persist selected interview domain.
- Persist selected code language when coding mode is active.
- Persist selected live answer format.
- Persist provider/model choices.
- Store screenshot-derived question metadata.

## UX Model

### Main Window

Tabs remain:

- Session Setup
- Live Assist
- Knowledge
- Prompt Studio
- Review

New settings should include:

- API providers.
- Transcription model.
- Answer model.
- Screenshot model.
- Hotkeys.
- Overlay behavior.
- Privacy/data retention.

### Overlay Window

Suggested compact layout:

```text
[drag] [listen] [source] [capture] [answer] [domain] [format] [panel] [settings]
```

When the active domain is coding, the overlay can expand or swap `domain` for a language selector:

```text
[drag] [listen] [source] [capture] [answer] [language] [format] [panel] [settings]
```

States:

- Idle.
- Listening.
- Transcribing.
- Question detected.
- Answer streaming.
- Error.

### Answer Window

Suggested layout:

```text
Question
Immediate bullets
Structured answer
Sources
Grounding note
Actions
```

The answer window should be useful even when the full cockpit is hidden.

## Hotkeys

Initial defaults:

- `CommandOrControl+Shift+V`: show/hide overlay.
- `CommandOrControl+Shift+S`: screenshot capture.
- `CommandOrControl+Shift+A`: answer latest question.
- `CommandOrControl+Shift+L`: start/stop listening.
- `CommandOrControl+Shift+I`: toggle click-through.
- `CommandOrControl+,`: open settings.

Hotkeys should be configurable later, but defaults are enough for the first pass.

## Provider Plan

### OpenAI

Use for:

- Realtime transcription.
- Chunked transcription fallback.
- Answer generation.
- Embeddings later, if needed.

Models:

- `gpt-4o-transcribe` for highest transcription quality.
- `gpt-4o-mini-transcribe` for lower cost/latency.
- Existing answer model config for generated answers.

### Gemini

Use for:

- Optional vision/screenshot analysis.
- Optional answer generation.

Gemini should remain behind the same provider abstraction, not hardwired as OpenCluely does.

## Implementation Phases

### Phase 1: Desktop Foundation

Goal: make Second Chair launch as a proper desktop app.

Tasks:

- Add server process management to Electron.
- Fix media permission handling.
- Add typed preload bridge.
- Add global shortcut registration.
- Add desktop lifecycle cleanup.
- Verify `npm run dev:desktop` starts app and API together.

Acceptance criteria:

- Desktop app launches with one command.
- API is available without manually starting a second terminal.
- App exits cleanly.
- Existing `npm run check` passes.

### Phase 2: Overlay and Answer Window

Goal: add OpenCluely-style control surface.

Tasks:

- Create overlay BrowserWindow.
- Create detached answer BrowserWindow.
- Build React overlay entry point.
- Build React answer-window entry point.
- Add show/hide and click-through controls.
- Add persistent overlay position.
- Route latest question and answer state into overlay.

Acceptance criteria:

- Overlay can be shown/hidden.
- Overlay stays above normal windows.
- Click-through can be toggled.
- Answer window can show latest streamed answer.
- Full cockpit remains available.

### Phase 3: Screenshot Capture

Goal: support visual prompts through the Second Chair pipeline. This includes coding prompts, architecture diagrams, cloud consoles, support tickets, logs, error messages, dashboards, or case-study material.

Tasks:

- Add Electron screenshot capture IPC.
- Add API endpoint for screenshot prompt creation.
- Add image provider adapter.
- Create the correct card type from screenshot content.
- Pass selected domain, role profile, answer format, and code language when relevant.
- Stream answer into answer window.

Acceptance criteria:

- User can press screenshot hotkey.
- App captures screen with explicit user action.
- A domain-aware question/prompt card is created.
- Answer streams using selected domain and format.
- Result is saved in session history.

### Phase 4: OpenAI Realtime Transcription

Goal: replace weak live transcription path with API-backed transcription.

Tasks:

- Add OpenAI realtime transcription session creation.
- Add WebSocket bridge between renderer/Electron/server and OpenAI.
- Normalize completed transcription events.
- Feed final transcript into question detection.
- Add chunked file transcription fallback.
- Add provider settings UI.

Acceptance criteria:

- User can start listening.
- Final transcripts appear in Live Assist.
- Questions are detected automatically.
- Latest question is visible in overlay.
- Answer latest question works from hotkey.

### Phase 5: Knowledge-Grounded Answering

Goal: preserve and strengthen Second Chair's core value.

Tasks:

- Keep document upload and chunk search.
- Add document categories to setup UI.
- Improve source chips in answer panel.
- Add stronger grounding warning when context is weak.
- Add domain and answer style controls to overlay.

Acceptance criteria:

- Resume/JD/notes influence generated answers.
- Answer panel shows source chips.
- Weakly grounded answers are clearly marked.
- Generated answer can be copied or pinned.

### Phase 6: Stabilization and Demo Polish

Goal: make it reliable enough to show.

Tasks:

- Add error states for missing API keys.
- Add permission diagnostics.
- Add model/provider health checks.
- Add keyboard shortcut conflict handling.
- Add startup checks.
- Add focused test coverage for provider adapters and screenshot endpoint.
- Run desktop smoke test.

Acceptance criteria:

- Missing API key produces actionable UI.
- Permission failures are explained.
- App does not silently fail when providers are unavailable.
- Demo flow works from cold start.

## Demo Script

1. Launch desktop app.
2. Create interview session.
3. Upload resume and job description.
4. Start listening.
5. Simulate interviewer question.
6. Question card appears.
7. Press answer hotkey from overlay.
8. Answer streams in detached panel with source chips.
9. Capture screenshot of a coding prompt, support ticket, cloud error, architecture diagram, or case prompt.
10. Domain-aware answer streams using selected format.
11. Open review tab and show saved transcript/questions/answers.

## Risks and Mitigations

### Audio Capture Reliability

Risk: system audio capture varies by platform.

Mitigation:

- Start with microphone and explicit display/audio capture.
- Reuse Tacet's proven local capture patterns where possible.
- Keep manual transcript input as fallback.

### Realtime API Complexity

Risk: realtime transcription introduces streaming state complexity.

Mitigation:

- Implement chunked transcription fallback first or in parallel.
- Keep normalized transcript event shape unchanged.
- Hide provider details behind `speechToText.ts`.

### Overlay State Sync

Risk: overlay, answer window, and main app can drift.

Mitigation:

- Treat the server repository as source of truth.
- Use explicit events for latest question and answer status.
- Avoid duplicating business state in Electron main.

### Build Complexity

Risk: multiple windows and entry points complicate Vite/Electron build.

Mitigation:

- Add separate HTML entry points only when needed.
- Keep shared React components in one UI folder.
- Verify dev first, then package later.

## First Implementation Recommendation

Start with Phase 1 and Phase 2 together:

- Make Second Chair launch cleanly as one desktop app.
- Add the floating overlay and answer panel.

This creates the visible OpenCluely-like experience quickly while still using the stable Second Chair backend. Screenshot capture and realtime transcription should follow after the windowing foundation is stable.
