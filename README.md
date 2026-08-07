# Jarvis — multi-API AI assistant

Your personal "Jarvis": a browser-based PWA that talks to **OpenRouter**, **Groq**, and
**Ollama**, routes between them, uses tools (web search / calculator / clock), and supports
**voice in and out**. All code runs in your browser — no server, no build step. Install it
to your phone's home screen like a native app.

## Features

- **Multi-provider** — OpenRouter, Groq, and local Ollama behind one OpenAI-compatible interface
- **Smart routing** — `Auto` / `Fast` / `Smart` modes with automatic failover (if a provider errors or times out, it silently tries the next one)
- **Function calling** — the model can actually use tools:
  - `web_search` — live web lookup
  - `calc` — exact math evaluation (with `sin`, `cos`, `^`, etc.)
  - `current_time` — current date/time/timezone
- **Voice** — tap the mic to talk, Jarvis speaks back (uses your device's built-in speech APIs, free)
- **Installable PWA** — add to home screen, runs full-screen with an icon
- **Private** — API keys stay in your browser's `localStorage`, never leave your device

## Quick start (desktop)

1. Install [Node.js](https://nodejs.org) (only to run a local server — no other deps).
2. Start a static server from this folder:

   ```
   npm start
   ```

3. Open `http://localhost:8080`.

> You don't strictly need a server — but if you open `index.html` directly via `file://`,
> the fetch calls are blocked by CORS. Always serve it.

## Getting free API keys

- **Groq** (fast): https://console.groq.com/keys — grab a `gsk_...` key (speed mode uses Groq).
- **OpenRouter** (many free models): https://openrouter.ai/keys → `sk-or-...`.
- **Ollama** (100% local): skip the keys, install [Ollama](https://ollama.com), pull a model:
  ```
  ollama pull llama3.2
  ```
  Then let the browser reach it by setting (on Windows):
  ```
  set OLLAMA_ORIGINS=*  
  ollama serve
  ```

You can use just one provider, or all three — Jarvis routes around whichever is missing.

## Install on your phone's home screen

For a phone to install it, the app must be served over **HTTPS** (or from `localhost`).
Easiest free options:

- **Cloudflare Pages / Netlify / Vercel** — drag-and-drop this folder, you get a free HTTPS URL. Open it on your phone → **Add to Home Screen**.
- **GitHub Pages** — push to a repo and enable Pages.

Voice input needs a secure context (HTTPS), so use a deployed URL if you want to talk to Jarvis from the phone.

## Getting keys settings right

Settings gear → enter keys / Ollama URL + model → close. The model list in the composer
rebuilds to show only what you've configured. Pick **Auto** and it falls back across
whichever providers are available; pick a specific model manually any time.

## Reset

Settings → **Reset Jarvis** re-shows the first-run wizard and clears stored keys.

## Good to know

- Keys are stored only in your own browser.
- `web_search` uses DuckDuckGo (no key needed); if blocked by network it falls back to DDG Instant Answer.
- Everything is client-side JS — feel free to hack it. Model list, prompts, and tools live at the top of `app.js`.