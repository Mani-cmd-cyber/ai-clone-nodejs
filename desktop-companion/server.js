"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch {}

const HOST = "127.0.0.1";
const PORT = Number(process.env.BANANA_COMPANION_PORT || 4317);
const TOKEN_FILE = path.join(__dirname, ".token");
const ALLOWED_ORIGINS = new Set([
  "https://banana-ai-assistant.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
let token = process.env.BANANA_COMPANION_TOKEN || "";
if (!token) {
  try { token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
  if (!token) {
    token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600, flag: "wx" });
  }
}

const APPS = Object.freeze({
  notepad: { label: "Notepad", command: "notepad.exe", args: [] },
  calculator: { label: "Calculator", command: "calc.exe", args: [] },
  paint: { label: "Paint", command: "mspaint.exe", args: [] },
  explorer: { label: "File Explorer", command: "explorer.exe", args: [] }
});

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Banana-Token");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}
function startDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.on("error", () => {});
  child.unref();
}
const server = http.createServer((req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, companion: "Banana AI Windows Companion", apps: Object.keys(APPS) });
  }
  if (req.method !== "POST" || url.pathname !== "/action") return send(res, 404, { error: "Not found." });
  if (req.headers["x-banana-token"] !== token) return send(res, 401, { error: "Companion pairing token is missing or incorrect." });
  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 12_000) { req.destroy(); }
  });
  req.on("end", () => {
    let data;
    try { data = JSON.parse(body || "{}"); } catch { return send(res, 400, { error: "Invalid JSON." }); }
    if (data.action === "open_app") {
      const app = APPS[data.app];
      if (!app) return send(res, 400, { error: "That application is not in the safe allowlist." });
      try { startDetached(app.command, app.args); return send(res, 200, { ok: true, message: app.label + " launch requested." }); }
      catch { return send(res, 500, { error: "Could not launch the application." }); }
    }
    if (data.action === "open_url") {
      let target;
      try { target = new URL(String(data.url || "")); } catch { return send(res, 400, { error: "Enter a valid website URL." }); }
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.href.length > 2000) {
        return send(res, 400, { error: "Only ordinary HTTP and HTTPS website links are allowed." });
      }
      try { startDetached("rundll32.exe", ["url.dll,FileProtocolHandler", target.href]); return send(res, 200, { ok: true, message: "Website opening requested." }); }
      catch { return send(res, 500, { error: "Could not open that website." }); }
    }
    return send(res, 400, { error: "Unsupported action." });
  });
});
server.listen(PORT, HOST, () => {
  console.log("\nBanana AI Windows Companion is listening on http://" + HOST + ":" + PORT);
  console.log("Pairing token (paste into Banana AI Computer panel):\n" + token + "\n");
  console.log("Safe actions only: Notepad, Calculator, Paint, File Explorer, and HTTP/HTTPS URLs.");
  console.log("Keep this token private. Press Ctrl+C to stop the companion.\n");
});
