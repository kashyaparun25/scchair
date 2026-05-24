# Design Research And UX Principles

## Installed Skills

Installed with the Skills CLI:

- `ux-design` from `mindrally/skills`
- `frontend-accessibility-best-practices` from `sergiodxa/agent-skills`
- `design-and-user-experience-guidelines` from `oimiragieo/agent-studio`

Note: Codex normally needs a restart to auto-discover newly installed skills. For this session, the skill files were read directly and applied as references.

## External Sources Reviewed

- Nielsen Norman Group usability heuristics and heuristic evaluation summaries.
- Apple Human Interface Guidelines for macOS and accessibility.
- Microsoft Human-AI Interaction Guidelines.
- Google/PAIR human-centered AI design principles.
- Material Design accessibility guidance.
- Claude Artifacts product docs and UX pattern: chat plus dedicated workspace.
- AI transparency and AI product UX guidance around sources, confidence, limits, and user control.

## Core Design Thesis

This product should not be a dashboard.

It is a live pressure tool. During a call, the user has limited attention and cannot parse dense panels. The design must prioritize:

1. What is happening right now.
2. What question was just asked.
3. What answer can I give next.

Everything else belongs in a separate page, drawer, or post-session review.

## Design Principles

### 1. One Job Per Page

Each top-level page should have one primary user job:

- Live Assist: capture conversation, detect questions, answer now.
- Session Setup: define role, round, company, style, and constraints.
- Knowledge: upload and manage resume, JD, notes, and Q&A banks.
- Prompt Studio: edit system prompts, answer styles, and variables.
- Review: analyze session, generate reports, build practice queue.

This follows progressive disclosure and reduces cognitive load.

### 2. Conversation Is The Main Object

The live screen should be built around the transcript/chat stream. The question queue should sit beside it, not compete with it.

Rationale:

- The user is in a live conversation.
- Transcript gives confidence that the app is listening.
- Detected questions are derived from the transcript.
- The answer workspace should activate only when a question is selected.

### 3. Use A Workspace Pattern For Generated Output

Claude Artifacts is a useful pattern: keep conversational input and substantial generated output in separate but connected spaces.

Applied here:

- Conversation stream remains the source of truth.
- Possible questions become structured objects.
- Answers render in a dedicated answer workspace.
- Generated content is not buried inside chat bubbles.

### 4. AI Must Show Confidence, Context, And Control

Human-AI guidance consistently points to:

- Make clear what the AI can do.
- Make clear how reliable it is.
- Show contextually relevant information.
- Support efficient invocation and dismissal.
- Recover gracefully when wrong.

Applied here:

- Each question card needs confidence.
- Each answer needs source chips.
- Weak grounding should be visible.
- The user should click `Answer now` in MVP.
- Auto-answer can come later as a user-controlled setting.

### 5. Time The UI To The User's Attention

During a live interview, the user should not need to read settings, documents, or prompt controls. Those belong before or after the call.

During live use:

- Show only live capture status, transcript, possible questions, answer action, answer output, and minimal source confidence.
- Hide document management.
- Hide prompt editing.
- Hide analytics.

### 6. Design For Trust Under Stress

Trust comes from visible system status and predictable behavior:

- Listening/paused states.
- Audio source health.
- Question confidence.
- Answer generation state.
- Source chips.
- Copy and dismiss controls.
- Undo or recover where possible.

### 7. Accessibility Is Product Quality

Accessibility rules from the installed skill should be treated as product quality requirements:

- Semantic landmarks: header, nav, main, section, aside.
- Real buttons for actions, not clickable divs.
- Visible focus states.
- 44px touch targets.
- Keyboard navigability.
- `aria-live` for new question detection and streamed answer updates.
- Respect reduced motion.
- Maintain WCAG AA contrast.

## Information Architecture

Recommended navigation:

1. Live Assist
2. Session Setup
3. Knowledge
4. Prompt Studio
5. Review

Avoid:

- A persistent left rail plus persistent right rail plus dense center content.
- Showing transcript, questions, answer, documents, prompts, metrics, and settings on one screen.
- Making the first screen a marketing page.
- Making the transcript a small afterthought.

## Live Assist Layout

Recommended desktop layout:

- Top: session identity and capture status.
- Tabs: product pages.
- Main area:
  - Left large panel: transcript/chat.
  - Right panel: possible questions found from transcript.
- Below:
  - Answer workspace for the selected question.

Recommended mobile layout:

- Session identity.
- Tabs as stacked large buttons or horizontal scroll.
- Transcript.
- Possible questions.
- Answer workspace.

## Visual Direction

The product should feel like a premium desktop command surface, not a generic SaaS dashboard.

Use:

- Spacious sections.
- Strong typography hierarchy.
- Restrained color.
- Clear active states.
- Few but meaningful icons.
- Generous line height.
- Stable panel dimensions.
- Quiet source and confidence indicators.

Avoid:

- Crowded three-column dashboards.
- Repeated cards inside cards.
- Gradient blobs.
- Overly decorative metrics.
- Tiny controls.
- Ambiguous icon-only navigation.

## Concrete Next Design Tasks

- Add visible focus states across all interactive controls.
- Add `aria-live` region for newly detected questions.
- Add an answer streaming state with staged reveal: bullets first, full response second.
- Add a compact top session bar for live mode.
- Convert tabs to route-like page state and persist active page.
- Make `Answer now` move focus to the answer workspace.
- Add empty states for no transcript, no questions, no documents, and no active answer.
- Add settings pages only after live workflow is clean.

