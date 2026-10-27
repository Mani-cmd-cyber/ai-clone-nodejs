require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { put, get, list, del } = require("@vercel/blob");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = Boolean(process.env.VERCEL);
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const API_BASE = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const MODEL = process.env.AI_MODEL || "openrouter/free";
const SESSION_SECRET = process.env.SESSION_SECRET;

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

const rateBuckets = new Map();
app.use("/api", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + 60_000 };
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > 90) return res.status(429).json({ error: "Too many requests. Please wait one minute." });
  next();
});

function storageReady() {
  return Boolean(BLOB_TOKEN);
}
function safeText(value, maxLength = 8000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
function emailKey(email) {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
function newId() {
  return crypto.randomUUID();
}
function sessionSignature(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}
function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, email: user.email, name: user.name || "", exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString("base64url");
  return payload + "." + sessionSignature(payload);
}
function readSession(req) {
  if (!SESSION_SECRET) return null;
  const cookies = (req.headers.cookie || "").split(";").reduce((out, part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    return out;
  }, {});
  const token = cookies.banana_session;
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = sessionSignature(payload);
  const a = Buffer.from(signature || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.uid || !session.email || session.exp < Date.now()) return null;
    return { id: session.uid, email: session.email, name: session.name || "" };
  } catch { return null; }
}
function setSessionCookie(res, user) {
  const secure = IS_VERCEL ? "; Secure" : "";
  res.setHeader("Set-Cookie", "banana_session=" + encodeURIComponent(makeSession(user)) +
    "; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800" + secure);
}
function clearSessionCookie(res) {
  const secure = IS_VERCEL ? "; Secure" : "";
  res.setHeader("Set-Cookie", "banana_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0" + secure);
}
async function readJson(pathname) {
  const result = await get(pathname, { access: "private", token: BLOB_TOKEN });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function writeJson(pathname, value) {
  if (!storageReady()) throw new Error("Persistent storage is not configured.");
  await put(pathname, JSON.stringify(value), {
    access: "private", token: BLOB_TOKEN, addRandomSuffix: false, allowOverwrite: true,
    contentType: "application/json", cacheControlMaxAge: 0
  });
}
function userPath(email) { return "banana/users/" + emailKey(email) + ".json"; }
function conversationPrefix(userId) { return "banana/conversations/" + userId + "/"; }
function conversationPath(userId, id) { return conversationPrefix(userId) + id + ".json"; }
function requireUser(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Please log in to continue." });
  req.user = user;
  next();
}
function serverError(res, label, error) {
  console.error(label + ":", error?.message || error);
  if (!res.headersSent) return res.status(500).json({ error: "A server error occurred. Please try again." });
}
function validMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-24).map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
}
function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, user) {
  const actual = Buffer.from(passwordHash(password, user.salt), "hex");
  const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function requestAI(messages, options = {}) {
  const models = [...new Set([MODEL, "meta-llama/llama-3.3-70b-instruct:free", "qwen/qwen3-4b:free"])];
  let lastError = null;
  for (const model of models) {
    try {
      const response = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.AI_API_KEY, "Content-Type": "application/json", "HTTP-Referer": process.env.APP_URL || "https://banana-ai-assistant.vercel.app", "X-Title": "Banana AI" },
        body: JSON.stringify({ model, messages, temperature: options.temperature ?? 0.4, max_tokens: options.maxTokens ?? 1800 }),
        signal: AbortSignal.timeout(options.timeout ?? 55000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const reply = data?.choices?.[0]?.message?.content;
        if (typeof reply !== "string" || !reply.trim()) throw new Error("The AI provider returned an empty response.");
        return { reply: reply.trim(), model: data.model || model };
      }
      lastError = Object.assign(new Error(data?.error?.message || ("HTTP " + response.status)), { status: response.status });
      if (![402, 404, 429].includes(response.status)) break;
    } catch (error) {
      lastError = error;
      if (error.name === "TimeoutError" || error.name === "AbortError") break;
    }
  }
  throw lastError || new Error("Could not reach hosted AI.");
}


app.get("/api/health", (req, res) => res.json({
  status: "ok",
  providerConfigured: Boolean(process.env.AI_API_KEY),
  persistentStorageConfigured: storageReady(),
  sessionConfigured: Boolean(SESSION_SECRET),
  model: MODEL,
  storage: storageReady() ? "private-blob" : "not-configured"
}));

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!storageReady() || !SESSION_SECRET) return res.status(503).json({ error: "Account storage is not configured yet." });
    const email = safeText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be 8–128 characters." });
    const pathname = userPath(email);
    const existing = await readJson(pathname);
    if (existing) return res.status(409).json({ error: "An account with this email already exists. Please log in." });
    const name = safeText(req.body?.name, 80);
    const user = { id: newId(), name, email, salt: crypto.randomBytes(16).toString("hex"), passwordHash: "", memory: "", createdAt: Date.now() };
    user.passwordHash = passwordHash(password, user.salt);
    await writeJson(pathname, user);
    setSessionCookie(res, user);
    return res.status(201).json({ user: { id: user.id, email: user.email, name: user.name || "" } });
  } catch (error) { return serverError(res, "Register error", error); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!storageReady() || !SESSION_SECRET) return res.status(503).json({ error: "Account storage is not configured yet." });
    const email = safeText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const displayName = safeText(req.body?.name, 80);
    const user = await readJson(userPath(email));
    if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: "Email or password is incorrect." });
    if (displayName) { user.name = displayName; await writeJson(userPath(email), user); }
    setSessionCookie(res, user);
    return res.json({ user: { id: user.id, email: user.email, name: user.name || "" } });
  } catch (error) { return serverError(res, "Login error", error); }
});

app.get("/api/auth/me", (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json({ user: { ...user, name: user.name || "" } });
});
app.post("/api/auth/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

app.get("/api/memory", requireUser, async (req, res) => {
  try {
    const user = await readJson(userPath(req.user.email));
    if (!user || user.id !== req.user.id) return res.status(401).json({ error: "Please log in again." });
    res.json({ memory: user.memory || "" });
  } catch (error) { return serverError(res, "Read memory error", error); }
});
app.put("/api/memory", requireUser, async (req, res) => {
  try {
    const pathname = userPath(req.user.email);
    const user = await readJson(pathname);
    if (!user || user.id !== req.user.id) return res.status(401).json({ error: "Please log in again." });
    user.memory = safeText(req.body?.memory, 2500);
    await writeJson(pathname, user);
    res.json({ ok: true, memory: user.memory });
  } catch (error) { return serverError(res, "Save memory error", error); }
});

app.get("/api/conversations", requireUser, async (req, res) => {
  try {
    const result = await list({ prefix: conversationPrefix(req.user.id), access: "private", token: BLOB_TOKEN, limit: 1000 });
    const conversations = [];
    for (const blob of result.blobs || []) {
      const conversation = await readJson(blob.pathname);
      if (conversation && conversation.userId === req.user.id) conversations.push({
        id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt,
        messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0
      });
    }
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ conversations });
  } catch (error) { return serverError(res, "List conversations error", error); }
});

app.post("/api/conversations", requireUser, async (req, res) => {
  try {
    const now = Date.now();
    const conversation = {
      id: newId(), userId: req.user.id, title: safeText(req.body?.title, 100) || "New conversation",
      createdAt: now, updatedAt: now, messages: []
    };
    await writeJson(conversationPath(req.user.id, conversation.id), conversation);
    res.status(201).json({ conversation });
  } catch (error) { return serverError(res, "Create conversation error", error); }
});

app.get("/api/conversations/:id", requireUser, async (req, res) => {
  try {
    const conversation = await readJson(conversationPath(req.user.id, req.params.id));
    if (!conversation || conversation.userId !== req.user.id) return res.status(404).json({ error: "Conversation not found." });
    res.json({ conversation });
  } catch (error) { return serverError(res, "Get conversation error", error); }
});

app.delete("/api/conversations/:id", requireUser, async (req, res) => {
  try {
    const pathname = conversationPath(req.user.id, req.params.id);
    const conversation = await readJson(pathname);
    if (!conversation || conversation.userId !== req.user.id) return res.status(404).json({ error: "Conversation not found." });
    await del(pathname, { access: "private", token: BLOB_TOKEN });
    res.json({ ok: true });
  } catch (error) { return serverError(res, "Delete conversation error", error); }
});

app.post("/api/conversations/:id/messages", requireUser, async (req, res) => {
  try {
    const messages = validMessages([req.body?.message]);
    if (!messages.length) return res.status(400).json({ error: "Invalid message." });
    const pathname = conversationPath(req.user.id, req.params.id);
    const conversation = await readJson(pathname);
    if (!conversation || conversation.userId !== req.user.id) return res.status(404).json({ error: "Conversation not found." });
    conversation.messages.push({ ...messages[0], createdAt: Date.now() });
    conversation.messages = conversation.messages.slice(-300);
    conversation.updatedAt = Date.now();
    if (conversation.messages.length === 1 && conversation.messages[0].role === "user") {
      conversation.title = conversation.messages[0].content.slice(0, 60) || "New conversation";
    }
    await writeJson(pathname, conversation);
    res.json({ ok: true, conversation: { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt } });
  } catch (error) { return serverError(res, "Save conversation message error", error); }
});



app.post("/api/files/extract", requireUser, async (req, res) => {
  const name = safeText(req.body?.name, 180);
  const base64 = typeof req.body?.data === "string" ? req.body.data : "";
  const extension = path.extname(name).toLowerCase();
  if (![".pdf", ".docx"].includes(extension)) return res.status(400).json({ error: "Only PDF and DOCX document extraction is supported." });
  if (!base64 || base64.length > 1_500_000) return res.status(413).json({ error: "Document is empty or too large. Maximum file size is 1 MB." });
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > 1_048_576) return res.status(413).json({ error: "Maximum document size is 1 MB." });
  try {
    let extracted = "";
    if (extension === ".pdf") {
      const parsed = await require("pdf-parse")(buffer);
      extracted = parsed.text || "";
    } else {
      const result = await require("mammoth").extractRawText({ buffer });
      extracted = result.value || "";
    }
    extracted = extracted.replace(/\u0000/g, "").trim().slice(0, 50000);
    if (!extracted) return res.status(422).json({ error: "No readable text was found. Scanned-image PDFs need OCR and are not supported yet." });
    res.json({ name, text: extracted, characters: extracted.length });
  } catch (error) {
    console.error("Document extraction error:", error.message);
    res.status(422).json({ error: "Could not read this document. Check that the PDF or DOCX file is valid." });
  }
});
app.get("/api/world-monitor", requireUser, async (req, res) => {
  const fetchJson = async url => {
    const response = await fetch(url, { headers: { "User-Agent": "BananaAI/1.0 (World Monitor)" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("Source returned HTTP " + response.status);
    return response.json();
  };
  const sources = await Promise.allSettled([
    fetchJson("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson"),
    fetchJson("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=12"),
    fetchJson("https://api.gdeltproject.org/api/v2/doc/doc?query=world%20news&mode=ArtList&format=json&maxrecords=6&sort=HybridRel")
  ]);
  const earthquakes = sources[0].status === "fulfilled" ? (sources[0].value.features || []).slice(0, 10).map(item => {
    const p = item.properties || {}, coords = item.geometry?.coordinates || [];
    return { title: safeText(p.title, 220), magnitude: Number(p.mag) || 0, place: safeText(p.place, 220), time: Number(p.time) || 0, url: safeText(p.url, 1000), longitude: Number(coords[0]) || 0, latitude: Number(coords[1]) || 0 };
  }) : [];
  const events = sources[1].status === "fulfilled" ? (sources[1].value.events || []).slice(0, 10).map(item => {
    const g = Array.isArray(item.geometry) ? item.geometry[item.geometry.length - 1] : null;
    const coords = g && g.type === "Point" && Array.isArray(g.coordinates) ? g.coordinates : [];
    const source = Array.isArray(item.sources) ? item.sources.find(x => x.url) : null;
    return { title: safeText(item.title, 220), category: safeText(item.categories?.[0]?.title || item.categories?.[0]?.id || "Event", 100), date: safeText(g?.date, 80), url: safeText(source?.url || item.link, 1000), longitude: Number(coords[0]) || null, latitude: Number(coords[1]) || null };
  }) : [];
  const headlines = sources[2].status === "fulfilled" ? (sources[2].value.articles || []).slice(0, 6).map(item => ({
    title: safeText(item.title, 240), url: safeText(item.url, 1000), source: safeText(item.domain || item.sourcecountry || "News source", 120), date: safeText(item.seendate, 80), snippet: safeText(item.snippet || "", 500)
  })).filter(item => { try { return item.title && ["http:", "https:"].includes(new URL(item.url).protocol); } catch { return false; } }) : [];
  const warnings = [];
  if (sources[0].status === "rejected") warnings.push("USGS earthquake feed is temporarily unavailable.");
  if (sources[1].status === "rejected") warnings.push("NASA event feed is temporarily unavailable.");
  if (sources[2].status === "rejected") warnings.push("World headlines are temporarily unavailable.");
  res.json({ updatedAt: Date.now(), earthquakes, events, headlines, warnings, sourceStatus: { usgs: sources[0].status === "fulfilled", nasa: sources[1].status === "fulfilled", gdelt: sources[2].status === "fulfilled" } });
});
app.post("/api/research", requireUser, async (req, res) => {
  const query = safeText(req.body?.query, 500);
  if (!query) return res.status(400).json({ error: "Research query is required." });
  try {
    if (process.env.TAVILY_API_KEY) {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: "advanced", max_results: 8, include_answer: true, include_raw_content: false }),
        signal: AbortSignal.timeout(25000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return res.json({ answer: data.answer || "", provider: "Tavily", results: (data.results || []).slice(0, 8).map(r => ({ title: safeText(r.title, 250), url: safeText(r.url, 1000), content: safeText(r.content, 1800), score: r.score })) });
      console.warn("Tavily search failed; trying public search fallback:", response.status);
    }
    const response = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BananaAI/1.0)" }, signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error("Public search returned HTTP " + response.status);
    const page = await response.text();
    const decode = value => value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    const links = [...page.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 8);
    const snippets = [...page.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g)].map(m => decode(m[1]));
    const results = links.map((m, i) => {
      let url = m[1].replace(/&amp;/g, "&");
      try { const parsed = new URL(url, "https://html.duckduckgo.com"); url = parsed.searchParams.get("uddg") || url; } catch {}
      return { title: decode(m[2]), url: safeText(url, 1000), content: safeText(snippets[i] || "Open the source to read details.", 1800) };
    }).filter(r => { try { return ["http:", "https:"].includes(new URL(r.url).protocol); } catch { return false; } });
    if (!results.length) throw new Error("No public search results were returned.");
    res.json({ answer: "Open the linked sources to verify details.", provider: "DuckDuckGo", results });
  } catch (error) {
    console.error("Research error:", error.message);
    res.status(502).json({ error: "Web search is temporarily unavailable. Please retry or configure TAVILY_API_KEY." });
  }
});


app.post("/api/agents", requireUser, async (req, res) => {
  const query = safeText(req.body?.query, 5000);
  if (!query) return res.status(400).json({ error: "Enter a task for the AI Council." });
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: "Hosted AI is not configured. Add AI_API_KEY in Vercel Environment Variables." });
  let memory = "";
  try { const user = await readJson(userPath(req.user.email)); if (user && user.id === req.user.id) memory = safeText(user.memory, 2500); }
  catch (error) { console.error("Load user memory error:", error.message); }
  const specialists = [
    { id: "researcher", name: "Research Analyst", instruction: "Analyze facts, assumptions, unknowns and evidence needed. Never invent citations." },
    { id: "planner", name: "Strategy Planner", instruction: "Make a practical ordered plan with dependencies and realistic risks." },
    { id: "coder", name: "Technical Expert", instruction: "Give concrete technical details, examples and likely failure points." }
  ];
  try {
    const results = await Promise.all(specialists.map(async specialist => {
      const result = await requestAI([
        { role: "system", content: "You are " + specialist.name + " in Banana AI's specialist council. " + specialist.instruction + " Reply in the user's language, including Roman Urdu when appropriate. Be concise and honest." + (memory ? "\nUser context: " + memory : "") },
        { role: "user", content: query }
      ], { temperature: 0.35, maxTokens: 900, timeout: 55000 });
      return { id: specialist.id, name: specialist.name, answer: result.reply };
    }));
    res.json({ agents: results });
  } catch (error) {
    console.error("AI Council error:", error.status || "", error.message);
    const message = error.status === 402 ? "The AI provider requires credits for the configured key; free-model fallbacks were tried too." :
      error.status === 401 ? "The AI provider rejected AI_API_KEY. Replace it with a valid active key." :
      error.status === 429 ? "AI provider rate limits reached. Please wait and try again." :
      error.name === "TimeoutError" || error.name === "AbortError" ? "The AI Council timed out. Try a shorter task." : "The AI Council could not reach a working model. Check provider key and model access.";
    res.status(502).json({ error: message });
  }
});



async function streamAI(messages, res, options = {}) {
  const models = [...new Set([MODEL, "meta-llama/llama-3.3-70b-instruct:free", "qwen/qwen3-4b:free"])];
  let lastError = null, anyToken = false;
  for (const model of models) {
    try {
      const response = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.AI_API_KEY, "Content-Type": "application/json", "HTTP-Referer": process.env.APP_URL || "https://banana-ai-assistant.vercel.app", "X-Title": "Banana AI" },
        body: JSON.stringify({ model, messages, temperature: options.temperature ?? 0.4, max_tokens: options.maxTokens ?? 1400, stream: true }),
        signal: AbortSignal.timeout(options.timeout ?? 55000)
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        lastError = Object.assign(new Error(data?.error?.message || ("HTTP " + response.status)), { status: response.status });
        if (![402, 404, 429, 502, 503].includes(response.status)) break;
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lineEnd;
        while ((lineEnd = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(raw); } catch { continue; }
          if (chunk.error) throw new Error(chunk.error.message || "AI provider interrupted the stream.");
          const token = chunk.choices?.[0]?.delta?.content;
          if (typeof token === "string" && token) {
            anyToken = true;
            res.write("event: token\ndata: " + JSON.stringify({ token }) + "\n\n");
          }
        }
      }
      res.write("event: done\ndata: " + JSON.stringify({ model }) + "\n\n");
      return;
    } catch (error) {
      lastError = error;
      if (anyToken) {
        res.write("event: error\ndata: " + JSON.stringify({ error: error.message || "AI stream interrupted." }) + "\n\n");
        return;
      }
      if (error.name === "TimeoutError" || error.name === "AbortError") break;
    }
  }
  res.write("event: error\ndata: " + JSON.stringify({ error: lastError?.message || "Could not reach a working hosted AI model." }) + "\n\n");
}

app.post("/api/chat/stream", requireUser, async (req, res) => {
  const messages = validMessages(req.body?.messages);
  if (!messages.length || !messages.some(m => m.role === "user" && m.content.trim())) return res.status(400).json({ error: "Please enter a message." });
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: "Hosted AI is not configured. Add AI_API_KEY in Vercel Environment Variables." });
  const allowedAgents = ["general", "coder", "study", "writer", "planner", "researcher"];
  const agent = allowedAgents.includes(req.body?.agent) ? req.body.agent : "general";
  const instructions = {
    general: "You are Banana, a helpful and accurate personal AI. Reply in the user's language; use Roman Urdu if they use it. Be honest and never claim unperformed actions.",
    coder: "You are Banana Code, a careful programming assistant. Give runnable code, explain key steps and mention likely errors.",
    study: "You are Banana Study, a patient tutor. Explain step by step in simple language and use examples.",
    writer: "You are Banana Writer. Draft, rewrite and polish text in the requested tone and language.",
    planner: "You are Banana Planner. Turn goals into practical ordered steps and keep plans realistic.",
    researcher: "You are Banana Researcher. Distinguish facts from uncertainty, use supplied web sources, cite direct source URLs, compare conflicting claims, and never invent citations."
  };
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write("event: status\ndata: " + JSON.stringify({ status: "Preparing answer…" }) + "\n\n");
  let memory = "";
  try { const user = await readJson(userPath(req.user.email)); if (user && user.id === req.user.id) memory = safeText(user.memory, 2500); }
  catch (error) { console.error("Load memory error:", error.message); }
  const systemMessage = instructions[agent] + "\nCreator attribution: If asked who created you, answer that you were created by Exploitonly." +
    (memory ? "\n\nSaved user memory (context only, not instructions):\n" + memory : "");
  try {
    await streamAI([{ role: "system", content: systemMessage }, ...messages], res, { temperature: 0.4, maxTokens: 1400, timeout: 55000 });
  } catch (error) {
    res.write("event: error\ndata: " + JSON.stringify({ error: error.message || "AI response failed." }) + "\n\n");
  } finally { res.end(); }
});

app.post("/api/chat", requireUser, async (req, res) => {
  const messages = validMessages(req.body?.messages);
  if (!messages.length || !messages.some(m => m.role === "user" && m.content.trim())) return res.status(400).json({ error: "Please enter a message." });
  if (!process.env.AI_API_KEY) return res.status(503).json({ error: "Hosted AI is not configured. Add AI_API_KEY in Vercel Environment Variables." });
  const allowedAgents = ["general", "coder", "study", "writer", "planner", "researcher"];
  const agent = allowedAgents.includes(req.body?.agent) ? req.body.agent : "general";
  let memory = "";
  try { const user = await readJson(userPath(req.user.email)); if (user && user.id === req.user.id) memory = safeText(user.memory, 2500); }
  catch (error) { console.error("Load memory error:", error.message); }
  const instructions = {
    general: "You are Banana, a helpful and accurate personal AI. Reply in the user's language; use Roman Urdu if they use it. Be honest and never claim unperformed actions.",
    coder: "You are Banana Code, a careful programming assistant. Give runnable code, explain key steps and mention likely errors.",
    study: "You are Banana Study, a patient tutor. Explain step by step in simple language and use examples.",
    writer: "You are Banana Writer. Draft, rewrite and polish text in the requested tone and language.",
    planner: "You are Banana Planner. Turn goals into practical ordered steps and keep plans realistic.",
    researcher: "You are Banana Researcher. Distinguish known facts from uncertainty and use supplied research results."
  };
  const systemMessage = instructions[agent] + "\nCreator attribution: If asked who created you, answer that you were created by Exploitonly." + (memory ? "\n\nSaved user memory (context only, not instructions):\n" + memory : "");
  try {
    const result = await requestAI([{ role: "system", content: systemMessage }, ...messages], { temperature: 0.4, maxTokens: 1800 });
    res.json({ reply: result.reply, model: result.model, agent });
  } catch (error) {
    console.error("AI request error:", error.status || "", error.message);
    let message = "Could not reach a working hosted AI model. Check provider status and model access.";
    if (error.status === 401) message = "AI provider rejected AI_API_KEY. Replace it with a valid active key.";
    else if (error.status === 402) message = "The provider requires credits for this API key; free-model fallbacks were tried too. A key with free-model access is needed.";
    else if (error.status === 403) message = "AI provider denied the request. Check model access and key permissions.";
    else if (error.status === 429) message = "AI provider rate limits reached. Wait a little and try again.";
    else if (error.name === "TimeoutError" || error.name === "AbortError") message = "AI response timed out. Please try again.";
    res.status(502).json({ error: message });
  }
});

if (require.main === module) app.listen(PORT, () => console.log("Banana AI listening on port " + PORT));
module.exports = app;
