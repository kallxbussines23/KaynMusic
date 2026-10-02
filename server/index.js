import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Optional private YouTube cookies supplied as base64 via Railway Variables.
// Never log or expose this file to the frontend.
const cookiesPath = "/tmp/kayn-youtube-cookies.txt";
function ytDlpArgs(args) {
  const encoded = process.env.YOUTUBE_COOKIES_BASE64;
  if (!encoded) return args;
  if (!fs.existsSync(cookiesPath)) {
    const decoded = Buffer.from(encoded, "base64");
    if (!decoded.length || decoded.length > 2_000_000) throw new Error("Invalid YOUTUBE_COOKIES_BASE64 size");
    fs.writeFileSync(cookiesPath, decoded, { mode: 0o600 });
  }
  return ["--cookies", cookiesPath, ...args];
}

function runYtDlp(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 5_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      resolve(stdout.trim());
    });
  });
}

app.get("/api/music/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 160);
  if (!query) return res.status(400).json({ error: "Masukkan kata kunci pencarian." });
  const failures = [];
  for (const base of PIPED_INSTANCES) {
    try {
      const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const entries = (Array.isArray(data) ? data : []).filter(item => item.type === "stream" && item.url)
        .slice(0, 12).map(item => {
          const id = String(item.url).split("v=").pop().split("&")[0];
          return { id, title: item.title || "Untitled", channel: item.uploaderName || "YouTube",
            duration: item.duration || null, thumbnail: item.thumbnail || null,
            url: `https://www.youtube.com/watch?v=${id}` };
        }).filter(item => /^[a-zA-Z0-9_-]{11}$/.test(item.id));
      if (entries.length) return res.json({ results: entries, provider: "Piped" });
      throw new Error("No video results");
    } catch (error) { failures.push(`${base}: ${error.message}`); }
  }
  // Last resort: yt-dlp search may still work on some deployments.
  try {
    const raw = await runYtDlp(["--dump-single-json", "--flat-playlist", "--no-warnings", "--playlist-end", "12", `ytsearch12:${query}`]);
    const data = JSON.parse(raw);
    const entries = (data.entries || []).filter(Boolean).map(item => ({
      id: item.id, title: item.title || "Untitled", channel: item.uploader || item.channel || "YouTube",
      duration: item.duration || null, thumbnail: item.thumbnail || item.thumbnails?.at(-1)?.url || null,
      url: item.url?.startsWith("http") ? item.url : `https://www.youtube.com/watch?v=${item.id}`
    }));
    return res.json({ results: entries, provider: "yt-dlp" });
  } catch (error) {
    console.error("Music search providers failed:", [...failures, error.message]);
    return res.status(502).json({ error: "Pencarian musik sedang tidak tersedia. Coba lagi nanti." });
  }
});

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(host) ? parsed : null;
  } catch { return null; }
}

app.post("/api/music/resolve", (req, res) => {
  // Compatibility endpoint: do not perform a separate metadata extraction.
  // Search results already contain title, duration and thumbnail.
  const videoUrl = String(req.body?.url || "");
  const parsed = isYouTubeUrl(videoUrl);
  if (!parsed) return res.status(400).json({ error: "URL YouTube tidak valid." });
  res.json({ url: `/api/music/stream?url=${encodeURIComponent(parsed.href)}` });
});

// Cookie-free streaming via public Piped/Invidious instances.
// These services are community-operated and can be unavailable or rate-limited.
const PIPED_INSTANCES = (process.env.PIPED_INSTANCES || "https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de")
  .split(",").map(value => value.trim().replace(/\/$/, "")).filter(Boolean);
const INVIDIOUS_INSTANCES = (process.env.INVIDIOUS_INSTANCES || "https://inv.nadeko.net,https://yewtu.be")
  .split(",").map(value => value.trim().replace(/\/$/, "")).filter(Boolean);

async function getRemoteAudio(videoId) {
  const failures = [];
  for (const base of PIPED_INSTANCES) {
    try {
      const response = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const stream = (data.audioStreams || []).filter(item => item.url && !item.videoOnly)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (stream) return { url: stream.url, type: stream.mimeType?.split(";")[0] || "audio/webm", provider: "Piped" };
      throw new Error("No audioStreams returned");
    } catch (error) { failures.push(`Piped ${base}: ${error.message}`); }
  }
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const response = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const stream = (data.adaptiveFormats || []).filter(item => item.url && item.type?.startsWith("audio/"))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
        || (data.formatStreams || []).find(item => item.url && item.type?.startsWith("audio/"));
      if (stream) return { url: stream.url, type: stream.type?.split(";")[0] || "audio/mp4", provider: "Invidious" };
      throw new Error("No audio format returned");
    } catch (error) { failures.push(`Invidious ${base}: ${error.message}`); }
  }
  const error = new Error("All cookie-free audio providers failed");
  error.details = failures;
  throw error;
}

app.get("/api/music/stream", async (req, res) => {
  const videoUrl = String(req.query.url || req.query.video || "");
  const parsed = isYouTubeUrl(videoUrl);
  if (!parsed) return res.status(400).json({ error: "URL YouTube tidak valid." });
  const videoId = parsed.hostname.includes("youtu.be")
    ? parsed.pathname.slice(1).split("/")[0]
    : parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: "ID video YouTube tidak valid." });

  try {
    const audio = await getRemoteAudio(videoId);
    const upstream = await fetch(audio.url, { headers: { "User-Agent": "Mozilla/5.0 KaynMusic/1.0" }, signal: AbortSignal.timeout(20000) });
    if (!upstream.ok || !upstream.body) throw new Error(`${audio.provider} audio fetch failed: HTTP ${upstream.status}`);
    res.status(200);
    res.setHeader("Content-Type", audio.type);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (upstream.headers.get("content-length")) res.setHeader("Content-Length", upstream.headers.get("content-length"));
    console.log(`[music:stream] provider=${audio.provider} video=${videoId}`);
    const { Readable } = await import("node:stream");
    Readable.fromWeb(upstream.body).on("error", error => {
      console.error("[music:stream] upstream pipe error:", error.message);
      if (!res.writableEnded) res.destroy(error);
    }).pipe(res);
  } catch (error) {
    console.error("[music:stream] all providers failed:", error.message, error.details || "");
    if (!res.headersSent) res.status(502).json({
      error: "Sumber audio sedang tidak tersedia. Coba lagi nanti.",
      code: "AUDIO_PROVIDERS_UNAVAILABLE"
    });
    else if (!res.writableEnded) res.end();
  }
});

const server = createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || "*" } });
const PORT = Number(process.env.PORT || 3000);
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "KaynMusic", timestamp: Date.now() }));

// Temporary in-memory presence/chat. Add auth, persistence, limits and moderation before production.
const rooms = new Map();
io.on("connection", socket => {
  socket.on("room:join", ({ roomId, username } = {}) => {
    if (typeof roomId !== "string" || !/^[A-Z0-9-]{4,24}$/.test(roomId)) {
      socket.emit("room:error", "Room ID tidak valid.");
      return;
    }
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      socket.leave(socket.data.roomId);
      const previous = rooms.get(socket.data.roomId);
      previous?.delete(socket.id);
      if (previous?.size) io.to(socket.data.roomId).emit("room:members", [...previous.values()]);
    }
    socket.join(roomId);
    const members = rooms.get(roomId) || new Map();
    members.set(socket.id, String(username || "Guest").slice(0, 32));
    rooms.set(roomId, members);
    io.to(roomId).emit("room:members", [...members.values()]);
    socket.data.roomId = roomId;
  });
  socket.on("room:chat", ({ text } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof text !== "string" || !text.trim()) return;
    io.to(roomId).emit("room:message", { id: crypto.randomUUID(), username: rooms.get(roomId)?.get(socket.id) || "Guest", text: text.trim().slice(0, 500), at: Date.now() });
  });
  socket.on("music:load", ({ url, title } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof url !== "string" || url.length > 2048) return;
    try {
      const parsed = url.startsWith("/api/music/stream?") ? null : new URL(url);
      if (parsed && !["http:", "https:"].includes(parsed.protocol)) return;
      io.to(roomId).emit("music:load", { url: parsed ? parsed.href : url, title: String(title || "Shared track").slice(0, 120) });
    } catch { /* Ignore malformed URLs. */ }
  });
  for (const event of ["music:play", "music:pause"]) {
    socket.on(event, ({ currentTime } = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const time = Number(currentTime);
      if (!Number.isFinite(time) || time < 0) return;
      socket.to(roomId).emit(event, { currentTime: time });
    });
  }
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const members = rooms.get(roomId);
    members?.delete(socket.id);
    if (members?.size) io.to(roomId).emit("room:members", [...members.values()]);
    else rooms.delete(roomId);
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
if (fs.existsSync(root)) {
  app.use(express.static(root));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(root, "index.html")));
}
server.listen(PORT, "0.0.0.0", () => console.log(`KaynMusic listening on ${PORT}`));