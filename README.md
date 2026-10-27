# Banana AI Assistant (v2)

A lightweight Node.js + Express hosted AI assistant based on your existing project. Designed to be developed on Windows 11 with 4 GB RAM: the model runs on a hosted provider, not locally.

## Included
- Futuristic responsive 3D AI chat interface
- OpenAI-compatible hosted API support (OpenRouter by default)
- Server-side provider API key
- Private account registration/login with hashed passwords and signed sessions
- Per-account conversation history and private Vercel Blob storage
- Per-account saved memory used as assistant context
- Browser voice input (Urdu, English and Hindi where supported) and spoken replies
- General, coding, study, writing, planner and researcher modes
- Three-specialist AI Council
- Web research using Tavily when configured, with a public DuckDuckGo fallback
- Text/code attachments plus PDF and DOCX text extraction (1 MB maximum)
- Health endpoint, request-size limits and basic per-IP rate limit

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
- Public deployment requires `AI_API_KEY`, `SESSION_SECRET`, and `BLOB_READ_WRITE_TOKEN` in Vercel Environment Variables. For OpenRouter, use `AI_BASE_URL=https://openrouter.ai/api/v1` and `AI_MODEL=openrouter/free`. A free-model router still requires an API key; it is not anonymous access.
- Web research uses Tavily when `TAVILY_API_KEY` is set and tries a public DuckDuckGo fallback otherwise. Public search can be rate-limited.
- Account data, memory and conversations are stored in private Vercel Blob storage. Keep tokens private and use provider spending limits.
- Voice depends on browser support and microphone permission. Speech output uses the voices installed in the visitor's browser.
- PDF/DOCX support extracts embedded text only; scanned-image PDFs need OCR and are not supported by this endpoint.
- AI Council runs three specialist prompts concurrently through the configured hosted provider; provider availability and rate limits apply.
- The website cannot directly control a visitor's Windows desktop. That requires a separately installed local companion, an explicit action allowlist and visible confirmation. The web app does not execute arbitrary shell commands.
- Do not store passwords, API keys, or highly sensitive personal data in memory.
