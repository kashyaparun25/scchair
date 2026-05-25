# Second Chair

**Second Chair** is your private, local-first interview and meeting copilot. It listens to live conversation, spots questions, and drafts grounded answers from your resume, notes, and job materials — all on your machine.

Works on **macOS** and **Windows**.

**No npm account. No GitHub account. No signup.**

---

## Install (one command — everything automated)

The installer automatically sets up:

- **Node.js 20+** (via Homebrew on macOS, winget on Windows)
- **Python 3** (via Homebrew / winget)
- **NVIDIA Riva Python client** (`pip install nvidia-riva-client`)
- **App dependencies** (`npm install`)
- **`scchair` command** on your PATH

You need **Homebrew** on macOS (`brew`) or **winget** on Windows. Otherwise install Node.js manually first from [nodejs.org](https://nodejs.org).

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/kashyaparun25/scchair/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/kashyaparun25/scchair/main/scripts/install.ps1 | iex
```

---

## Run (one command)

```bash
scchair
```

That's it. Opens the desktop app every time.

### Other commands

```bash
scchair web       # Browser-only mode (no Electron)
scchair doctor    # Check Node, Python, and dependencies
scchair help
```

### Update to latest version

Re-run the install command — it updates in place:

```bash
curl -fsSL https://raw.githubusercontent.com/kashyaparun25/scchair/main/scripts/install.sh | bash
```

---

## Prerequisites (manual fallback)

The installer tries to install everything automatically. If auto-install fails, install manually:

| Requirement | macOS | Windows |
|-------------|-------|---------|
| Node.js 20+ | `brew install node` | [nodejs.org](https://nodejs.org) or `winget install OpenJS.NodeJS.LTS` |
| Python 3 | `brew install python` | [python.org](https://www.python.org/downloads/) |
| NVIDIA Riva client | `pip install -U nvidia-riva-client` | same |

Verify with:

```bash
node --version    # v20+
python3 --version
scchair doctor
```

---

## First-time setup

1. Run `scchair`
2. Open **Settings** in the app (NVIDIA is the default AI provider)
3. Paste your **NVIDIA API key** — an in-app guide shows where to get it
4. Optionally switch to OpenAI, Gemini, or Claude (each includes its own key guide)
5. Complete **Setup** with your role, company, and uploaded documents

API keys are stored locally in `.local-data/app-config.json`, not in the cloud.

Run `scchair doctor` anytime to verify Node, Python, and NVIDIA Riva are ready.

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
```

| Command | Description |
|---------|-------------|
| `npm start` | Same as `scchair` |
| `npm run dev:desktop` | Local API + Vite UI + Electron |
| `npm run dev` | Browser-only (API + UI) |
| `npm run doctor` | Environment check |

Default ports: UI `5174`, API `5180`.

---

## Install locations

| Platform | App files | Command |
|----------|-----------|---------|
| macOS / Linux | `~/.scchair/app` | `~/.local/bin/scchair` |
| Windows | `%LOCALAPPDATA%\scchair\app` | `%LOCALAPPDATA%\scchair\bin\scchair.cmd` |

Override with `SCCHAIR_HOME` or `SCCHAIR_BIN_DIR` environment variables.

---

## Privacy

- Audio and documents stay on your machine
- API calls go only to providers you configure (NVIDIA, OpenAI, etc.)
- No account or cloud backend required

---

## License

MIT — see [LICENSE](LICENSE).
