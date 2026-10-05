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
import scrapr from "@coflyn/scrapr";
import YTdownload from "@hoangquyet/ytdown";

const { youtube } = scrapr;

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

// Try multiple unauthenticated clients and IPv4. YouTube may still block cloud IPs.
async function runYtDlpWithFallback(args, timeoutMs = 25000) {
  const attempts = ["tv_downgraded", "android_vr", "web_embedded", null];
  const failures = [];
  for (const client of attempts) {
    const attempt = ["--force-ipv4", "--ignore-config", ...args];
    if (client) attempt.push("--extractor-args", `youtube:player_client=${client}`);
    try {
      return await runYtDlp(ytDlpArgs(attempt), timeoutMs);
    } catch (error) {
      failures.push(`${client || "default"}: ${error.message}`);
    }
  }
  const error = new Error("All yt-dlp extraction attempts failed");
  error.details = failures;
  throw error;
}

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.r4fo.com"
];

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
  try {
    const raw = await runYtDlp(["--force-ipv4", "--ignore-config", "--dump-single-json", "--flat-playlist", "--no-warnings", "--playlist-end", "12", `ytsearch12:${query}`]);
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

const SCRAPR_CACHE_TTL = 5 * 60 * 1000;
const scraprAudioCache = new Map();

function pickAudioDownload(result) {
  const downloads = Array.isArray(result?.downloads) ? result.downloads : [];
  return downloads.find(item => item?.type === "audio" && /^https?:\/\//i.test(item.url))
    || downloads.find(item => /^https?:\/\//i.test(item?.url));
}

async function resolveYtdownAudio(videoUrl) {
  const info = await YTdownload.json(videoUrl);
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const candidates = formats
    .filter(item => item?.kind === "audio" && item?.url && item?.reach !== "none")
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

  const audio = candidates.find(item => item.reach === "whole") || candidates[0];
  if (!audio?.url) {
    const recommended = info?.recommended?.muxed;
    if (recommended?.url) {
      return {
        directUrl: recommended.url,
        title: info?.title || "YouTube track",
        thumbnail: info?.thumbnail || null,
        quality: recommended.qualityLabel || "muxed",
        provider: "ytdown"
      };
    }
    throw new Error("ytdown tidak menemukan URL media yang bisa diputar.");
  }

  return {
    directUrl: audio.url,
    title: info?.title || "YouTube track",
    thumbnail: info?.thumbnail || null,
    quality: audio.qualityLabel || audio.bitrate ? String(audio.bitrate || "audio") : "audio",
    provider: "ytdown"
  };
}

async function resolveScraprAudio(videoUrl) {
  const parsed = isYouTubeUrl(videoUrl);
  if (!parsed) throw new Error("URL YouTube tidak valid.");

  const key = parsed.href;
  const cached = scraprAudioCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  scraprAudioCache.delete(key);

  const attempts = [
    async () => youtube.ytmp3(key, "mp3"),
    async () => youtube.ytmp3gg(key, { format: "mp3" })
  ];
  const failures = [];

  for (const attempt of attempts) {
    try {
      const response = await attempt();
      if (!response?.status) throw new Error(response?.message || "Scrapr resolver returned no result");
      const download = pickAudioDownload(response.result);
      if (!download) throw new Error("Scrapr returned no playable audio URL");

      const value = {
        directUrl: download.url,
        title: response.result?.title || "YouTube track",
        thumbnail: response.result?.thumbnail || null,
        quality: download.quality || null,
        provider: "scrapr"
      };
      scraprAudioCache.set(key, { value, expiresAt: Date.now() + SCRAPR_CACHE_TTL });
      return value;
    } catch (error) {
      failures.push(error.message || String(error));
    }
  }

  try {
    const fallback = await resolveYtdownAudio(key);
    scraprAudioCache.set(key, { value: fallback, expiresAt: Date.now() + SCRAPR_CACHE_TTL });
    return fallback;
  } catch (error) {
    failures.push(`ytdown: ${error.message || String(error)}`);
  }

  const error = new Error("Semua resolver YouTube gagal.");
  error.details = failures;
  throw error;
}

app.post("/api/music/resolve", async (req, res) => {
  const videoUrl = String(req.body?.url || "");
  if (!isYouTubeUrl(videoUrl)) return res.status(400).json({ error: "URL YouTube tidak valid." });

  try {
    const audio = await resolveScraprAudio(videoUrl);
    res.json({
      url: `/api/music/stream?url=${encodeURIComponent(videoUrl)}`,
      title: audio.title,
      thumbnail: audio.thumbnail,
      quality: audio.quality,
      provider: audio.provider
    });
  } catch (error) {
    const errorId = crypto.randomUUID();
    const details = (error.details || [error.message]).join("\\n").slice(0, 5000);
    console.error("[music:resolve] scrapr failed", JSON.stringify({ errorId, url: videoUrl, details }));
    res.status(502).json({
      error: "Scrapr gagal menyiapkan audio.",
      errorId,
      stage: "scrapr YouTube resolver",
      details
    });
  }
});

app.get("/api/music/stream", async (req, res) => {
  const videoUrl = String(req.query.url || req.query.video || "");
  if (!isYouTubeUrl(videoUrl)) return res.status(400).json({ error: "URL YouTube tidak valid." });

  try {
    const audio = await resolveScraprAudio(videoUrl);
    const headers = {
      "User-Agent": req.get("user-agent") || "Mozilla/5.0",
      "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.5"
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(audio.directUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60000)
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error(`Audio upstream HTTP ${upstream.status}`);
    }

    res.status(upstream.status);
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-KaynMusic-Provider", "scrapr");

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (error) {
    const errorId = crypto.randomUUID();
    const details = (error.details || [error.message]).join("\\n").slice(0, 5000);
    console.error("[music:stream] scrapr failed", JSON.stringify({ errorId, url: videoUrl, details }));
    if (!res.headersSent) {
      res.status(502).json({
        error: "Streaming audio lewat scrapr gagal.",
        errorId,
        stage: "scrapr stream proxy",
        details
      });
    } else {
      res.destroy(error);
    }
  }
});

/**
 * Lightweight KaynAPI gateway. The secret stays on the KaynMusic server;
 * yt-dlp/FFmpeg work is performed by KaynAPI, not this service.
 */
const KAYN_API_BASE = (process.env.KAYN_API_BASE_URL || "https://kaynapi.up.railway.app/api/v1").replace(/\/+$/, "");
function kaynApiHeaders() {
  if (!process.env.KAYN_API_KEY) throw new Error("KAYN_API_KEY belum diatur di Railway Variables.");
  return { Authorization: `Bearer ${process.env.KAYN_API_KEY}` };
}
app.get("/api/kayn/music/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 160);
  if (query.length < 2) return res.status(400).json({ error: "Masukkan kata kunci minimal 2 karakter." });
  try {
    const upstream = await fetch(`${KAYN_API_BASE}/media/api/search`, {
      method: "POST", headers: { ...kaynApiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 12 }), signal: AbortSignal.timeout(50000)
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || data.message || "KaynAPI search gagal." });
    res.json({ results: data.results || [], provider: "KaynAPI" });
  } catch (error) {
    console.error("[kaynapi:search]", error.message);
    res.status(502).json({ error: error.message || "KaynAPI tidak dapat dijangkau." });
  }
});
app.get("/api/kayn/music/stream", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "URL media tidak valid." });
  try {
    const upstream = await fetch(`${KAYN_API_BASE}/media/api/Spotify/watch?url=${encodeURIComponent(url)}`, {
      headers: kaynApiHeaders(), signal: AbortSignal.timeout(60000)
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return res.status(upstream.status || 502).json({ error: detail.slice(0, 1000) || "KaynAPI gagal menyiapkan stream." });
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
      }
      res.end();
    } catch (error) {
      if (!res.destroyed) res.destroy(error);
    }
  } catch (error) {
    console.error("[kaynapi:stream]", error.message);
    if (!res.headersSent) res.status(502).json({ error: error.message || "KaynAPI stream tidak dapat dijangkau." });
    else res.destroy(error);
  }
});

const server = createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || "*" } });
const PORT = Number(process.env.PORT || 3000);
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "KaynMusic", timestamp: Date.now() }));

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
