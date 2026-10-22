# Banana AI Assistant (v2)

A lightweight Node.js + Express hosted AI assistant based on your existing project. Designed to be developed on Windows 11 with 4 GB RAM: the model runs on a hosted provider, not locally.

## Included
- Futuristic responsive chat UI
- OpenAI-compatible hosted API support (OpenRouter default)
- Server-side API key only (`.env`)
- Persistent conversation history using a JSON file
- User-controlled browser-local memory
- Browser voice input (Chrome/Edge where supported) and speech output
- Assistant modes: general, coding, study, writing, planner, researcher
- Optional web research via Tavily
- Health endpoint, request-size limit, basic per-IP rate limit
- Render deployment blueprint

## Requirements
Node.js 20 LTS or newer (18.17+ is supported), npm, and a hosted AI API key.

## Run on Windows 11
1. Extract the ZIP to a folder, for example `C:\Users\YourName\Desktop\banana-ai-v2`.
2. Open that folder in File Explorer.
3. Click the address bar, type `cmd`, and press Enter.
4. Run:
   ```bash
   npm install
   ```
5. Copy `.env.example` to `.env`. In File Explorer, enable View > Show > File name extensions if needed.
6. Edit `.env` and set:
   ```env
   AI_API_KEY=your_real_key
   AI_BASE_URL=https://openrouter.ai/api/v1
   AI_MODEL=openai/gpt-4o-mini
   PORT=3000
   ```
   Never share or commit `.env`. Check the provider dashboard for currently available models/prices; change `AI_MODEL` to an available model if necessary.
7. Start:
   ```bash
   npm start
   ```
8. Open http://localhost:3000 and check http://localhost:3000/api/health.

## Optional web research
Create a Tavily key, then add `TAVILY_API_KEY=your_key` to `.env` and restart the server. The Web research checkbox uses Tavily search results and asks the selected hosted model to summarize them. Without this key, normal AI chat still works.

## Important storage/deployment notes
- Conversation history is stored in `data/conversations.json`. It is suitable for local testing and single-instance demos, not a multi-user production database.
- Many free hosting plans use ephemeral filesystems; history may be lost on redeploy/restart. For public multi-user use, add managed PostgreSQL and user authentication before treating chats as private.
- Browser-local memory is stored in localStorage and is not synced across devices or accounts. Do not store secrets or sensitive personal data there.
- Public deployment requires setting secrets in the hosting dashboard, never in source code.
- A single global conversation store is not appropriate for a public multi-user service. Do not deploy this version for private multi-user conversations until authentication and per-user database isolation are added.
- The included request limiter is intentionally simple. A public production app should use a managed rate limiter, auth, abuse monitoring, and provider spending limits.

## Features not yet included
- Windows desktop app and computer control are intentionally not bundled into this web app. Desktop automation needs a separately installed local companion, a strict action allowlist, visible confirmations, and should never execute arbitrary shell commands from model output.
- Multiple agent modes are prompt-based profiles, not independent autonomous agents.
- No authentication or account system yet.
