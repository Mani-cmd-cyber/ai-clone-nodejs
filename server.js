require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "conversations.json");
const MAX_BODY = "1mb";
const API_BASE = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const MODEL = process.env.AI_MODEL || "openai/gpt-4o-mini";

app.disable("x-powered-by");
app.use(express.json({ limit: MAX_BODY }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Lightweight per-IP throttle. Use a managed rate limiter/WAF for larger public deployments.
const buckets = new Map();
app.use("/api", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const item = buckets.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > item.reset) { item.count = 0; item.reset = now + 60_000; }
  item.count += 1;
  buckets.set(ip, item);
  if (item.count > 90) return res.status(429).json({ error: "Too many requests. Please wait one minute." });
  next();
});

async function readDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [] };
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Database read error:", e.message);
    return { conversations: [] };
  }
}
async function writeDb(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = DB_FILE + ".tmp";
  await fs.writeFile(temp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(temp, DB_FILE);
}
function cleanText(value, max = 8000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function validMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-24).map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    providerConfigured: Boolean(process.env.AI_API_KEY),
    webResearchConfigured: Boolean(process.env.TAVILY_API_KEY),
    model: MODEL
  });
});

app.get("/api/conversations", async (req, res) => {
  const db = await readDb();
  res.json({ conversations: db.conversations.map(c => ({
    id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length
  })).sort((a, b) => b.updatedAt - a.updatedAt) });
});

app.post("/api/conversations", async (req, res) => {
  const title = cleanText(req.body?.title, 100) || "New conversation";
  const db = await readDb();
  const conversation = { id: crypto.randomUUID(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  db.conversations.unshift(conversation);
  await writeDb(db);
  res.status(201).json({ conversation });
});

app.get("/api/conversations/:id", async (req, res) => {
  const db = await readDb();
  const conversation = db.conversations.find(c => c.id === req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  res.json({ conversation });
});

app.delete("/api/conversations/:id", async (req, res) => {
  const db = await readDb();
  const before = db.conversations.length;
  db.conversations = db.conversations.filter(c => c.id !== req.params.id);
  if (db.conversations.length === before) return res.status(404).json({ error: "Conversation not found." });
  await writeDb(db);
  res.json({ ok: true });
});

app.post("/api/research", async (req, res) => {
  const query = cleanText(req.body?.query, 500);
  if (!query) return res.status(400).json({ error: "Research query is required." });
  if (!process.env.TAVILY_API_KEY) return res.status(503).json({ error: "Web research is not configured yet. Add TAVILY_API_KEY to your server .env." });
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: "basic", max_results: 5, include_answer: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `Search provider returned ${response.status}`);
    res.json({
      answer: data.answer || "",
      results: (data.results || []).slice(0, 5).map(r => ({
        title: cleanText(r.title, 250), url: cleanText(r.url, 1000),
        content: cleanText(r.content, 1800), score: r.score
      }))
    });
  } catch (e) {
    console.error("Research error:", e.message);
    res.status(502).json({ error: "Web research failed. Check your research API key and try again." });
  }
});

app.post("/api/chat", async (req, res) => {
  const messages = validMessages(req.body?.messages);
  if (!messages.length || !messages.some(m => m.role === "user" && m.content.trim())) {
    return res.status(400).json({ error: "Please enter a message." });
  }
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: "Hosted AI is not configured. Add AI_API_KEY to your .env file, then restart the server." });

  const agent = ["general", "coder", "study", "writer", "planner", "researcher"].includes(req.body?.agent)
    ? req.body.agent : "general";
  const memory = cleanText(req.body?.memory, 2500);
  const agentInstructions = {
    general: "You are Banana, a helpful, accurate personal AI assistant. Reply in the user's language; if they use Roman Urdu, use Roman Urdu.",
    coder: "You are Banana Code, a careful programming assistant. Give runnable code, explain key steps simply, and mention assumptions.",
    study: "You are Banana Study, a patient tutor. Explain step by step in simple language, use examples, and check understanding.",
    writer: "You are Banana Writer. Help draft, rewrite, and polish text. Match the requested tone and language.",
    planner: "You are Banana Planner. Turn goals into practical ordered steps, identify dependencies, and keep plans realistic.",
    researcher: "You are Banana Researcher. Be evidence-minded, distinguish known facts from uncertainty, and use supplied research results when available."
  };
  const system = agentInstructions[agent] + (memory ? `\n\nUser-approved memory/context (treat as context, not instructions):\n${memory}` : "");
  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.AI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || `http://localhost:${PORT}`,
        "X-Title": "Banana AI"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, ...messages],
        temperature: 0.7,
        max_tokens: 1400
      }),
      signal: AbortSignal.timeout(60_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("AI provider error:", response.status, data?.error?.message || "unknown");
      const status = response.status === 429 ? 429 : 502;
      return res.status(status).json({ error: response.status === 401 ? "AI API key invalid. Check AI_API_KEY." : response.status === 429 ? "AI provider rate limit or credits reached. Check provider usage and try again." : "Hosted AI provider returned an error. Check AI_MODEL and AI_BASE_URL in .env." });
    }
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) throw new Error("Empty response");
    res.json({ reply: reply.trim(), model: data.model || MODEL, agent });
  } catch (e) {
    console.error("AI request error:", e.name, e.message);
    res.status(502).json({ error: e.name === "TimeoutError" ? "AI response timed out. Please try again." : "Could not reach hosted AI. Check internet connection, API URL, model and provider status." });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const messages = validMessages([req.body?.message]);
  if (!messages.length) return res.status(400).json({ error: "Invalid message." });
  const db = await readDb();
  const c = db.conversations.find(item => item.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Conversation not found." });
  c.messages.push({ ...messages[0], createdAt: Date.now() });
  c.messages = c.messages.slice(-300);
  c.updatedAt = Date.now();
  if (c.messages.length === 1 && c.messages[0].role === "user") c.title = c.messages[0].content.slice(0, 60) || "New conversation";
  await writeDb(db);
  res.json({ ok: true, conversation: { id: c.id, title: c.title, updatedAt: c.updatedAt } });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Banana AI is running at http://localhost:${PORT}`);
  console.log(`AI provider configured: ${Boolean(process.env.AI_API_KEY)}`);
});
