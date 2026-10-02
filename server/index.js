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
  try {
    const raw = await runYtDlp(ytDlpArgs(["--dump-single-json", "--flat-playlist", "--no-warnings", "--playlist-end", "12", `ytsearch12:${query}`]));
    const data = JSON.parse(raw);
    const entries = (data.entries || []).filter(Boolean).map(item => ({
      id: item.id, title: item.title || "Untitled", channel: item.uploader || item.channel || "YouTube",
      duration: item.duration || null, thumbnail: item.thumbnail || item.thumbnails?.at(-1)?.url || null,
      url: item.url?.startsWith("http") ? item.url : `https://www.youtube.com/watch?v=${item.id}`
    }));
    res.json({ results: entries });
  } catch (error) {
    console.error("YouTube search failed:", error.message);
    res.status(502).json({ error: "Pencarian YouTube gagal. Coba lagi nanti." });
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

// Same-origin streaming proxy: yt-dlp stdout -> FFmpeg MP3 stdout -> browser.
// No complete audio file is written to disk.
app.get("/api/music/stream", (req, res) => {
  const videoUrl = String(req.query.url || req.query.video || "");
  if (!isYouTubeUrl(videoUrl)) return res.status(400).json({ error: "URL YouTube tidak valid." });
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const extractor = spawn("yt-dlp", ytDlpArgs(["--no-warnings", "--no-playlist", "-f", "bestaudio/best", "-o", "-", videoUrl]), { stdio: ["ignore", "pipe", "pipe"] });
  const transcoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", "-f", "mp3", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  const abort = () => { extractor.kill("SIGKILL"); transcoder.kill("SIGKILL"); };
  res.on("close", () => { if (!res.writableEnded) abort(); });
  transcoder.stdin.on("error", () => {});
  extractor.stdout.pipe(transcoder.stdin);
  transcoder.stdout.pipe(res);
  extractor.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  transcoder.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const fail = (name, code) => {
    if (res.headersSent) { if (!res.writableEnded) res.end(); }
    else res.status(502).json({ error: "Streaming gagal diproses." });
    console.error(name + " stream error:", code, stderr);
    abort();
  };
  extractor.on("error", error => fail("yt-dlp", error.message));
  transcoder.on("error", error => fail("ffmpeg", error.message));
  extractor.on("close", code => { if (code && !res.writableEnded) fail("yt-dlp", code); });
  transcoder.on("close", code => { if (code && !res.writableEnded) fail("ffmpeg", code); });
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