# Second Chair

**Second Chair** is your private, local-first interview and meeting copilot. It listens to live conversation, spots questions, and drafts grounded answers from your resume, notes, and job materials — all on your machine.

Works on **macOS** and **Windows**.

---

## Prerequisites: install Node.js

`npx` ships with Node.js, so you need **Node.js 20 or newer** before running Second Chair.

### Check if you already have it

```bash
node --version
```

You should see `v20.x.x` or higher. If the command is not found, install Node.js using one of the options below.

### macOS

**Option A — Homebrew (recommended)**

```bash
brew install node
```

**Option B — Official installer**

Download the **LTS** build from [nodejs.org](https://nodejs.org) and run the installer.

### Windows

**Option A — Official installer (recommended)**

1. Go to [nodejs.org](https://nodejs.org)
2. Download the **LTS** Windows installer (`.msi`)
3. Run the installer and keep the default options (this adds `node` and `npx` to your PATH)

**Option B — winget**

```powershell
winget install OpenJS.NodeJS.LTS
```

### Verify after install

Open a **new** terminal window, then run:

```bash
node --version
npm --version
npx --version
```

All three commands should print version numbers. Once they do, you're ready.

---

## Quick start

**No npm account. No GitHub account. No signup.** Anyone with Node.js can run:

```bash
npx scchair
```

That's the only command users need. `npx` downloads and runs the app anonymously — no login required.

On first run it will:

1. Download the app
2. Install dependencies automatically
3. Create a local `.env` if needed
4. Open the **desktop app** (Electron + local API + UI)

Every run after that is just `npx scchair` again.

### Other commands

```bash
npx scchair web       # Browser-only mode (no Electron)
npx scchair doctor    # Check Node, Python, and dependencies
npx scchair help
```

---

## First-time setup

1. Run `npx scchair`
2. Open **Settings** in the app (NVIDIA is the default AI provider)
3. Paste your **NVIDIA API key** — an in-app guide shows where to get it
4. Optionally switch to OpenAI, Gemini, or Claude (each includes its own key guide)
5. Complete **Setup** with your role, company, and uploaded documents

API keys are stored locally in `.local-data/app-config.json`, not in the cloud.

### Optional: Python 3 (NVIDIA live captions)

For NVIDIA Riva streaming speech-to-text, install Python 3:

| Platform | Install |
|----------|---------|
| macOS | `brew install python3` |
| Windows | [python.org/downloads](https://www.python.org/downloads/) |

OpenAI / Gemini / Claude stacks work without Python. Run `npx scchair doctor` to verify your environment.

---

## What it does

- **Listens** to your interview or meeting in real time
- **Detects** when the interviewer asks a question
- **Drafts answers** grounded in your resume, job description, and notes
- **Floats an overlay** so you can glance at suggestions without leaving the call

Everything runs locally. Your audio and documents never leave your machine except for API calls to providers you configure.

---

## Clone and develop

```bash
git clone https://github.com/kashyaparun25/scchair.git
cd scchair
npm install
cp .env.example .env   # optional bootstrap keys
npm run dev:desktop    # Electron desktop
# or
npm run dev            # browser-only
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Same as `npx scchair` when run from a clone |
| `npm run dev:desktop` | Local API + Vite UI + Electron |
| `npm run dev` | Browser-only (API + UI) |
| `npm run doctor` | Environment check |
| `npm run check` | Typecheck and syntax validation |
| `npm run build` | Production UI build |

Default ports: UI `5174`, API `5180`. Override with `UI_PORT` and `API_PORT`.

---

## Architecture

```
scchair/
├── bin/scchair.mjs          # npx entry point
├── electron/                # Desktop shell (main, overlay, answer windows)
├── scripts/                 # Dev orchestration + bootstrap
├── src/
│   ├── server/              # Express API, SQLite, AI providers
│   ├── ui/                  # React cockpit + overlay
│   └── shared/              # Types, presets, API key guides
└── .local-data/             # Local state (gitignored)
```

- **Local API** — Express on `127.0.0.1`, SQLite persistence
- **Provider routing** — NVIDIA (default), OpenAI, Gemini, Anthropic; configurable in Settings
- **Desktop shell** — Electron with context isolation; no Node in the renderer
- **Overlay** — Floating listen/answer panel during calls

---

## Environment variables

All optional. Prefer **Settings** in the app for API keys and models.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SECOND_CHAIR_DATA_DIR` | `.local-data` | Local data directory |
| `API_PORT` | `5180` | API port |
| `UI_PORT` | `5174` | Vite dev port |
| `OPENAI_API_KEY` | — | Bootstrap OpenAI key (optional) |
| `NVIDIA_API_KEY` | — | Bootstrap NVIDIA key (optional) |

Legacy `INTERVIEW_COPILOT_*` variables are still supported.

---

## Publish to npm (maintainers — one-time setup)

End users never need an npm account. **You** (the maintainer) publish once so `npx scchair` works globally.

### Option A — publish from your machine (fastest)

1. Enable 2FA on your npm account: [npmjs.com/settings → Two-Factor Authentication](https://www.npmjs.com/settings)
2. Run:

```bash
cd scchair
npm publish --access public --otp=YOUR_6_DIGIT_CODE
```

Replace `YOUR_6_DIGIT_CODE` with your authenticator app code.

### Option B — publish via GitHub Actions (automated)

1. Create an **Automation** or **Granular** token at [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) with **Publish** permission
2. Add it as a repo secret: GitHub repo → **Settings → Secrets → Actions → New secret** → name: `NPM_TOKEN`
3. Create a GitHub Release (or run the **Publish to npm** workflow manually)

After publish, anyone worldwide runs:

```bash
npx scchair
```

No accounts, no clone, no install step.

---

## Privacy

- Audio and documents stay on your machine
- API calls go only to providers you configure (NVIDIA, OpenAI, etc.)
- No account or cloud backend required

---

## License

MIT — see [LICENSE](LICENSE).
