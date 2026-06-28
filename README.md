# Second Chair — private real-time copilot for interviews & meetings

**Second Chair** listens to your live conversation, spots questions as they're asked, and drafts grounded answers from your resume, notes, and job materials. Everything runs on your machine.

You can run it as a **standalone desktop app** with a dark translucent glass cockpit, or as a minimal **floating overlay** that sits on top of your video call. Both modes stay invisible to screen share.

Works on **macOS**, **Windows**, and **Linux**.

> No account. No signup. No cloud.

---

## What it does

- **Real-time transcript** — captures mic and system audio during calls
- **Question detection** — spots what the interviewer is asking, reframes it for context
- **Answer drafting** — generates a speakable script grounded in your resume, job description, and uploaded notes
- **Knowledge grounding** — uploaded docs are semantically indexed so every answer pulls from your materials
- **Floating overlay** — a compact transparent window you can keep on top of Zoom / Meet / Teams
- **Detached answer window** — a second floating window dedicated to answer preview
- **Review and report** — session timeline with question history, practice queue, and export

---

## Stealth & undetectability

Second Chair can disguise itself so it doesn't draw attention:

| Feature | What it does |
|---|---|
| **Process disguise** | The app appears as "Terminal", "Activity Monitor", or "System Settings" in the Dock, menu bar, and Activity Monitor |
| **Content protection** | All windows are invisible to screen-sharing apps (Zoom, Meet, Teams, OBS) on macOS 12.3+ |
| **Panic toggle** (`⌘⇧V`) | Instantly hides every window with one key — press again to bring them back |
| **Click-through overlay** | The floating overlay can pass mouse clicks through to the app underneath (`⌘⇧I` to flip) |
| **Auto-hide** | Optional: overlay disappears the moment you click away |
| **Dark translucent glass UI** | Every panel has a frosted-glass look with `backdrop-filter` blur |

Open **Settings → Low-profile overlay** in the app to configure these. Stealth is on by default.

---

## Quick start

### Option A — Desktop app (recommended)

Download the latest build for your platform from [Releases](https://github.com/kashyaparun25/scchair/releases):

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | `Second Chair-*-mac-arm64.dmg` |
| macOS (Intel) | `Second Chair-*-mac-x64.dmg` |
| Windows (x64) | `Second Chair-*-win-x64.exe` |
| Windows (ARM) | `Second Chair-*-win-arm64.exe` |
| Linux (x64) | `Second Chair-*-linux-x86_64.AppImage` |
| Linux (ARM) | `Second Chair-*-linux-arm64.AppImage` |

Open, drag to Applications (macOS) or run the installer (Windows), then launch. The first-run wizard walks you through setup.

### Option B — One-command install (`npx`)

```bash
npx scchair
```

Installs everything and launches the desktop app. Works on macOS, Windows, and Linux.

If you prefer to install manually, see [Install from source](#install-from-source).

---

## First-time setup

1. Launch the app
2. Open **Settings** → pick your AI provider (NVIDIA is the default)
3. Paste your API key — each provider's key guide is shown inline
4. Open **Setup** → fill in your role, company, and round type
5. Upload a resume, job description, or notes in the Knowledge section
6. Go to **Live** → turn on Interviewer audio to start capturing

That's it. API keys are stored locally in your machine's app data folder.

---

## How to use

1. **Set the context** in Setup — role, documents, answer style
2. **Start Live Assist** — enable Interviewer (system) audio and optionally your mic
3. **Watch the transcript** populate on the right rail
4. **Questions appear** automatically with a speakable answer below
5. **Open the floating overlay** (top‑bar button or `⌘⇧O`) to keep answers visible during a call
6. **Use the panic toggle** (`⌘⇧V`) if you need to hide everything instantly

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘⇧V` | Panic — hide/restore all windows |
| `⌘⇧I` | Toggle click‑through on the overlay |
| `⌘⇧O` | Show/hide floating overlay |
| `⌘⇧A` | Show/hide detached answer window |
| `⌘⇧H` | Hide overlay windows only |
| `⌘⇧S` | Capture screenshot for context |

---

## Install from source

```bash
git clone https://github.com/kashyaparun25/scchair.git
cd scchair
npm install
```

### Run in development

```bash
npm run dev:desktop     # Electron desktop (API + UI + Electron)
npm run dev             # Browser only (API + UI at localhost:5174)
```

### Build distributable packages

```bash
npm run build           # Compile TypeScript and bundle UI
npm run dist:mac        # → release/Second Chair-*-mac-arm64.dmg
npm run dist:win        # → release/Second Chair-*-win-arm64.exe
npm run dist:linux      # → release/Second Chair-*-linux-arm64.AppImage
npm run dist:all        # All three platforms (mac, win, linux)
```

Default dev ports: UI `5174`, API `5180`.

---

## Requirements

| Requirement | Why |
|---|---|
| Node.js 20+ | Runtime |
| Python 3 (optional) | NVIDIA Riva client for some STT configurations |
| Homebrew / winget / apt (optional) | Auto-installer prerequisites |

macOS: Xcode Command Line Tools. Windows: Visual Studio Build Tools for native modules. Linux: `build-essential`.

---

## Contributing

Pull requests are welcome. Before submitting:

1. Run `npm run check` to verify TypeScript and syntax
2. Run `npm run build` to confirm the bundle compiles
3. Test both `npm run dev` (browser) and `npm run dev:desktop` (Electron)

Report issues or suggest features at [github.com/kashyaparun25/scchair/issues](https://github.com/kashyaparun25/scchair/issues).

---

## Privacy

- Audio, transcript, and documents stay on your machine
- API calls go only to providers you configure (NVIDIA, OpenAI, etc.)
- No telemetry, no accounts, no cloud backend
- API keys are stored in your local app data directory, never transmitted elsewhere

---

## License

MIT — see [LICENSE](LICENSE).
