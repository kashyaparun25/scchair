# Electron shell

Second Chair ships a desktop shell built on Electron.

## Surfaces

| Window | Role |
|--------|------|
| Main | Full cockpit — setup, live assist, settings |
| Overlay | Floating listen/answer panel during calls |
| Answer | Detached answer window |

## Dev

From the project root:

```bash
npm run dev:desktop
```

Environment variables use the `SECOND_CHAIR_*` prefix (legacy `INTERVIEW_COPILOT_*` still works).

## Security

- Context isolation enabled
- Node integration disabled in renderers
- Preload exposes `window.secondChair` (alias: `window.interviewCopilot`)
