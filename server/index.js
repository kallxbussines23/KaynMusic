import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || "*" } });
const PORT = Number(process.env.PORT || 3000);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "KaynMusic", timestamp: Date.now() }));

// In-memory room chat is a development foundation only. Production rooms need
// authenticated membership checks, persistence, rate limits, and moderation.
const rooms = new Map();
io.on("connection", socket => {
  socket.on("room:join", ({ roomId, username } = {}) => {
    if (typeof roomId !== "string" || !/^[A-Z0-9-]{4,24}$/.test(roomId)) {
      socket.emit("room:error", "Room ID tidak valid.");
      return;
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
    io.to(roomId).emit("room:message", {
      id: crypto.randomUUID(),
      username: rooms.get(roomId)?.get(socket.id) || "Guest",
      text: text.trim().slice(0, 500),
      at: Date.now()
    });
  });
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
  // Express 5 / path-to-regexp requires a named wildcard parameter.
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(root, "index.html")));
}
server.listen(PORT, "0.0.0.0", () => console.log(`KaynMusic listening on ${PORT}`));