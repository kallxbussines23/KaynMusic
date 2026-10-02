/**
 * KaynMusic WhatsApp Bot — single-file entrypoint
 * Requirements: Node.js 20+, ffmpeg, yt-dlp
 * Install: npm install @whiskeysockets/baileys pino
 * Run: node index.js
 *
 * Commands:
 *   .play <judul>  - cari musik dan kirim audio
 *   .help          - bantuan
 *   .ping          - cek bot
 *
 * Note: audio is fetched on demand and buffered in memory before WhatsApp send.
 * Respect the source platform's terms and copyright rules.
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import pino from "pino";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PREFIX = ".";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // keep memory use bounded
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.r4fo.com"
];
const logger = pino({ level: "silent" });
const handled = new Set();

async function searchMusic(query) {
  const failures = [];
  for (const base of PIPED_INSTANCES) {
    try {
      const response = await fetch(
        `${base}/search?q=${encodeURIComponent(query)}&filter=videos`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const results = (Array.isArray(data) ? data : [])
        .filter(item => item.type === "stream" && item.url)
        .slice(0, 10)
        .map(item => {
          const id = String(item.url).split("v=").pop().split("&")[0];
          return {
            id,
            title: item.title || "Tanpa judul",
            channel: item.uploaderName || "YouTube",
            duration: Number(item.duration) || 0,
            url: `https://www.youtube.com/watch?v=${id}`
          };
        })
        .filter(item => /^[a-zA-Z0-9_-]{11}$/.test(item.id));
      if (results.length) return results;
      throw new Error("Tidak ada hasil");
    } catch (error) {
      failures.push(`${base}: ${error.message}`);
    }
  }
  throw new Error("Semua penyedia pencarian gagal. " + failures.join(" | "));
}

function formatDuration(seconds) {
  if (!seconds) return "Durasi tidak diketahui";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function downloadAudio(videoUrl) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn("yt-dlp", [
      "--no-warnings", "--no-playlist", "--force-ipv4",
      "-f", "bestaudio/best", "-o", "-", videoUrl
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vn", "-ac", "2", "-ar", "44100", "-b:a", "128k",
      "-f", "mp3", "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      ytdlp.kill("SIGKILL");
      ffmpeg.kill("SIGKILL");
      finish(new Error("Proses audio melewati batas waktu 3 menit."));
    }, 180000);

    function finish(error, buffer) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(buffer);
    }

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        ytdlp.kill("SIGKILL");
        ffmpeg.kill("SIGKILL");
        finish(new Error("Ukuran audio terlalu besar (maksimal 24 MB)."));
        return;
      }
      chunks.push(chunk);
    });
    ytdlp.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-3500);
    });
    ffmpeg.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-3500);
    });
    ytdlp.on("error", error => finish(new Error("yt-dlp tidak dapat dijalankan: " + error.message)));
    ffmpeg.on("error", error => finish(new Error("FFmpeg tidak dapat dijalankan: " + error.message)));
    ytdlp.on("close", code => {
      if (code !== 0 && !settled) {
        ffmpeg.kill("SIGKILL");
        finish(new Error("Pengambilan audio gagal. " + stderr));
      }
    });
    ffmpeg.on("close", code => {
      if (code !== 0 && !settled) finish(new Error("Konversi audio gagal. " + stderr));
      else if (code === 0 && !settled) finish(null, Buffer.concat(chunks));
    });
  });
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./kayn-wa-auth");
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: true,
    browser: ["KaynMusic Bot", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") console.log("KaynMusic Bot terhubung.");
    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log("Koneksi terputus:", status || "unknown");
      if (status !== DisconnectReason.loggedOut) {
        await delay(2000);
        start().catch(error => console.error("Reconnect error:", error));
      } else {
        console.log("Sesi logout. Hapus folder kayn-wa-auth lalu scan ulang QR.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast" || handled.has(msg.key.id)) continue;
      handled.add(msg.key.id);
      if (handled.size > 1000) handled.clear();

      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption || "";
      const text = body.trim();
      if (!text.startsWith(PREFIX)) continue;

      const [command, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
      const query = args.join(" ").trim();
      try {
        if (command.toLowerCase() === "help") {
          await sock.sendMessage(jid, {
            text: "*KaynMusic Bot* 🎵\n\n.play <judul lagu> — cari dan kirim audio\n.ping — cek status bot\n.help — bantuan"
          }, { quoted: msg });
        } else if (command.toLowerCase() === "ping") {
          await sock.sendMessage(jid, { text: "Pong! Bot aktif. 🎶" }, { quoted: msg });
        } else if (command.toLowerCase() === "play") {
          if (!query) {
            await sock.sendMessage(jid, { text: "Contoh: .play Hindia Evaluasi" }, { quoted: msg });
            continue;
          }
          await sock.sendMessage(jid, { text: `🔎 Mencari: *${query}*\nTunggu sebentar ya...` }, { quoted: msg });
          const results = await searchMusic(query);
          const track = results[0];
          await sock.sendMessage(jid, {
            text: `🎵 *${track.title}*\n👤 ${track.channel}\n⏱️ ${formatDuration(track.duration)}\n\nSedang menyiapkan audio...`
          }, { quoted: msg });

          const audio = await downloadAudio(track.url);
          await sock.sendMessage(jid, {
            audio,
            mimetype: "audio/mpeg",
            fileName: `${track.title.replace(/[\\\\/:*?"<>|]/g, "").slice(0, 80) || "kayn-music"}.mp3`,
            ptt: false
          }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { text: "Perintah tidak dikenal. Ketik .help" }, { quoted: msg });
        }
      } catch (error) {
        console.error("Command error:", error);
        await sock.sendMessage(jid, {
          text: `❌ ${String(error.message || error).slice(0, 900)}`
        }, { quoted: msg }).catch(() => {});
      }
    }
  });
}

start().catch(error => {
  console.error("Gagal menjalankan bot:", error);
  process.exitCode = 1;
});
