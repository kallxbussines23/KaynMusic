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
    const raw = await runYtDlp(["--dump-single-json", "--flat-playlist", "--no-warnings", "--playlist-end", "12", `ytsearch12:${query}`]);
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

app.post("/api/music/resolve", async (req, res) => {
  const videoUrl = String(req.body?.url || "");
  let parsed;
  try { parsed = new URL(videoUrl); } catch { return res.status(400).json({ error: "URL tidak valid." }); }
  const host = parsed.hostname.toLowerCase().replace(/^www\\./, "");
  if (!["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(host)) {
    return res.status(400).json({ error: "Saat ini hanya URL YouTube yang didukung." });
  }
  try {
    const raw = await runYtDlp(["--dump-single-json", "--no-warnings", "--no-playlist", "-f", "bestaudio/best", videoUrl]);
    const info = JSON.parse(raw);
    const audioUrl = info.url;
    if (!audioUrl) throw new Error("No audio stream returned");
    res.json({ url: audioUrl, title: info.title || "YouTube track", duration: info.duration || null, thumbnail: info.thumbnail || null });
  } catch (error) {
    console.error("YouTube audio resolve failed:", error.message);
    res.status(502).json({ error: "Audio tidak dapat diambil. Video mungkin dibatasi atau sumber berubah." });
  }
});


const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || "*" } });
const PORT = Number(process.env.PORT || 3000);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
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
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return;
      io.to(roomId).emit("music:load", { url: parsed.href, title: String(title || "Shared track").slice(0, 120) });
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