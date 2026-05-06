# GitAgent Designer

A git-native, multimodal frontend builder for brand consultancies. Chat (or speak, or show a photo) to a senior brand designer; it writes the HTML/CSS/JS for a full page; you watch it render live in an iframe.

> **You're looking for the React app at `http://localhost:5173`** — not the stock gitclaw voice UI at `http://localhost:3333`. This repo runs its own Fastify backend (port 8882) and Vite/React frontend (port 5173). If you've separately installed the `gitclaw` CLI globally and run `gitclaw --voice`, that launches gitclaw's own bundled UI on 3333 and is **not** this app. Stop that process and use `npm run dev` from this repo instead.

Built on:
- **[gitclaw SDK](https://github.com/open-gitagent/gitagent)** — agents-as-git-repos runtime
- **[`frontend-design` skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)** — Anthropic's official design skill, baked into every project's agent
- **Claude Opus 4.7** for design, **OpenAI Realtime (gpt-4o-realtime)** for voice, **Claude Vision** for image/video understanding
- React + Vite + Fastify

## What you get

- Left pane: streaming chat with the design agent
- Right pane: live `<iframe>` of the page being built — auto-reloads each time the agent writes a file
- Top bar: voice (mic in, voice out — push-to-stop, function-call bridge to the design agent), live video (periodic frame description piped in as ambient design context), and 📷 capture (one-shot reference photo: vision read → use in the page)
- Each project lives in `projects/<id>/` as a plain folder with the agent template (`agent.yaml`, `SOUL.md`, `RULES.md`, `skills/frontend-design/SKILL.md`) plus a `site/` directory containing `index.html`, `styles.css`, `script.js`, and `assets/`

## Setup

```bash
git clone https://github.com/open-gitagent/webpage-designer
cd webpage-designer
cp .env.example .env
```

Edit `.env` and fill in your keys:

```
# REQUIRED — design agent
ANTHROPIC_API_KEY=sk-ant-...

# OPTIONAL — voice (OpenAI Realtime)
OPENAI_API_KEY=sk-...

# OPTIONAL — image search (Pexels free tier)
PEXELS_API_KEY=...

# OPTIONAL — image generation, background removal, studio relight (fal.ai)
FAL_KEY=...

# OPTIONAL — change the auth credentials. Defaults are lyzr / lyzr2b28.
# Override these in production. The defaults are public in this repo's source.
AUTH_USER=lyzr
AUTH_PASS=lyzr2b28

PORT=8882
```

Install and run:

```bash
npm install
npm run dev
```

`npm run dev` starts BOTH services concurrently via the workspace setup:
- **Fastify API + agent server** on `http://localhost:8882`
- **Vite React dev server** on `http://localhost:5173` (with proxy to the API)

**Open `http://localhost:5173`** in your browser. You'll see the login screen. Sign in with `lyzr` / `lyzr2b28` (or whatever you set `AUTH_USER` / `AUTH_PASS` to in `.env`). Once authed, click `+ new project`, name it, and describe what you want to build.

### Common confusion

If you see a different UI at `http://localhost:3333`, that's **gitclaw's stock voice UI** from a separately-installed `gitclaw` CLI process — not this app. Kill that process (`pkill -f 'gitclaw --voice'`) and use `npm run dev` from this repo. The 3333 port is gitclaw's CLI default; this app uses 5173 (frontend) + 8882 (backend) and never 3333.

## How a turn works

1. You type an instruction → the browser opens a WS to `/ws/agent/<id>` and sends a `prompt` event.
2. Server calls gitclaw's `query()` with `dir = projects/<id>/`. gitclaw loads `agent.yaml`, the SOUL, the RULES, and the `frontend-design` skill, and assembles the system prompt.
3. The agent has 5 tools wired by the server: `write_file`, `read_file`, `list_files`, `list_assets`, `fetch_url_image`. All scoped to `site/` with path-traversal protection.
4. As the agent streams text and calls tools, every `GCMessage` event is forwarded to the browser. The chat pane shows deltas, tool calls, and final messages.
5. Every `write_file` triggers a `file_changed` event; the browser debounces 250ms, then bumps the iframe `?_=N` cachebuster so the preview reloads.

## How voice works

Browser → WS `/voice/<id>` → server → OpenAI Realtime WSS.

- Browser captures mic via AudioWorklet at 24kHz PCM16, sends `input_audio_buffer.append` events upstream.
- OpenAI Realtime is configured to call a **single function**: `send_to_designer(instruction)`. The voice model's only job is to listen, briefly acknowledge out loud, and forward the instruction.
- Server intercepts that function call, runs the design agent, then sends `function_call_output` back upstream so the voice model speaks a short summary.
- Audio replies stream back as `response.audio.delta` events; the browser decodes PCM16 and plays via Web Audio scheduling.

## How vision works

- 📷 capture: `getUserMedia` → JPEG → POST `/api/projects/<id>/upload` (saves to `site/assets/`) → POST `/api/vision` (Claude Opus 4.7 with the design-eyes prompt) → an automatic follow-up message is sent to the agent: *"I just uploaded `assets/photo-…jpg`. Vision read: …. Use it in the page."*
- 📹 video: `getUserMedia` video, frame snapped every 8s and POSTed to `/api/vision` with a terser prompt; description appears in chat as ambient context the agent can pick up on the next turn.

## Project layout

```
designer/
├── server/
│   ├── agent-template/              # cloned into every new project
│   │   ├── agent.yaml               # model: claude-opus-4-7
│   │   ├── SOUL.md                  # designer identity
│   │   ├── RULES.md                 # output format + aesthetic rules
│   │   └── skills/frontend-design/SKILL.md
│   └── src/
│       ├── index.ts                 # Fastify, routes, static preview, WS chat
│       ├── agent.ts                 # gitclaw query() wrapper
│       ├── tools.ts                 # write_file, read_file, list_files, list_assets, fetch_url_image
│       ├── voice.ts                 # OpenAI Realtime relay + designer bridge
│       ├── vision.ts                # Claude vision endpoint
│       ├── projects.ts              # create/list, copy template, scaffold site/
│       └── paths.ts                 # safe path joining
├── web/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── components/{Chat,Preview,Camera,Voice}.tsx
│       └── lib/{agentWs,audio,types}.ts
├── projects/                        # generated; gitignored
└── package.json                     # workspaces: server + web
```

## Smoke test

After `npm run dev`:

1. Visit `http://localhost:5173`, click `+ new`, name "Crude Espresso".
2. Send: *"build a brutalist landing page for Crude, a single-origin espresso brand. monumental serif type, exposed concrete tones, asymmetric layout. no stock photo grid."*
3. Watch the chat stream. Within a minute the iframe should render a styled page.
4. Click 📷 capture, snap something on your desk → the agent should incorporate it.
5. Click 🎙️ voice, say *"make the type larger and add a horizontal scroll of menu items at the bottom"* → it should acknowledge out loud, do the work, then summarize.

## Notes / known limitations

- Voice currently uses `gpt-4o-realtime-preview-2024-12-17`. If OpenAI rotates the model id, update `REALTIME_URL` in `server/src/voice.ts`.
- Live video frames cost vision-model calls every 8s. The interval is in `web/src/components/Voice.tsx` (`startVideo`) — bump it up to throttle.
- "Plain folders, no git" was chosen at scaffold time. To switch to gitclaw's per-session branching, swap `runAgent` to also pass `repo:` in `QueryOptions` and keep `LocalSession.commitChanges()` after each `write_file`.
- The agent writes plain HTML/CSS/JS only (no React, no build step) — that's enforced by `RULES.md`.
