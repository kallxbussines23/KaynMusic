/**
 * KaynMusic WhatsApp — single-file bot
 * Node.js 20+, yt-dlp, FFmpeg
 * npm i @yudzxml/baileys pino
 * Optional: set PAIRING_NUMBER=628xxxxxxxxxx for pairing-code login.
 *
 * Commands: .play <judul>, .search <judul>, .ping, .help
 * Use only with audio you are authorized to access and share.
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@yudzxml/baileys";
import pino from "pino";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const PREFIX = ".";
const AUTH_DIR = "./kayn-wa-auth";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const PROCESS_TIMEOUT = 180_000;
const PIPED_INSTANCES = [
  "https://pipedapi.adminforge.de",
  "https://pipedapi.r4fo.com",
  "https://pipedapi.kavin.rocks"
];
const logger = pino({ level: "silent" });
const handled = new Set();
let starting = false;

const clean = value => String(value || "").replace(/[\\/:*?"<>|\n\r]/g, "").slice(0, 90).trim();

function formatDuration(seconds) {
  if (!seconds) return "Durasi tidak diketahui";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function searchMusic(query) {
  const errors = [];
  for (const base of PIPED_INSTANCES) {
    try {
      const response = await fetch(
        `${base}/search?q=${encodeURIComponent(query)}&filter=videos`,
        { signal: AbortSignal.timeout(12_000) }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const results = (Array.isArray(data) ? data : [])
        .filter(item => item.type === "stream" && item.url)
        .slice(0, 8)
        .map(item => {
          const id = String(item.url).split("v=").pop().split("&")[0];
          return {
            id,
            title: item.title || "Tanpa judul",
            channel: item.uploaderName || "YouTube",
            duration: Number(item.duration) || 0,
            thumbnail: item.thumbnail || null,
            url: `https://www.youtube.com/watch?v=${id}`
          };
        })
        .filter(item => /^[\w-]{11}$/.test(item.id));
      if (results.length) return results;
      throw new Error("Hasil kosong");
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }
  throw new Error("Pencarian musik sedang tidak tersedia. " + errors.join(" | "));
}

function downloadAudio(videoUrl) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn("yt-dlp", [
      "--no-warnings", "--no-playlist", "--force-ipv4",
      "--no-part", "-f", "bestaudio/best", "-o", "-", videoUrl
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
    const timer = setTimeout(() => {
      ytdlp.kill("SIGKILL");
      ffmpeg.kill("SIGKILL");
      finish(new Error("Proses audio melewati batas waktu 3 menit."));
    }, PROCESS_TIMEOUT);

    function finish(error, buffer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(buffer);
    }

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on("error", () => {}); // prevent EPIPE from crashing the process
    for (const child of [ytdlp, ffmpeg]) {
      child.stderr.on("data", chunk => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("error", error => finish(new Error(error.message)));
    }

    ffmpeg.stdout.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        ytdlp.kill("SIGKILL");
        ffmpeg.kill("SIGKILL");
        finish(new Error("Audio lebih dari batas 24 MB."));
        return;
      }
      chunks.push(chunk);
    });

    ytdlp.on("close", code => {
      if (code !== 0 && !settled) {
        ffmpeg.kill("SIGKILL");
        finish(new Error(`yt-dlp gagal (exit ${code}). ${stderr}`));
      }
    });
    ffmpeg.on("close", code => {
      if (code !== 0 && !settled) finish(new Error(`FFmpeg gagal (exit ${code}). ${stderr}`));
      else if (code === 0 && !settled) finish(null, Buffer.concat(chunks));
    });
  });
}

function getText(message) {
  const m = message?.message;
  return m?.conversation
    || m?.extendedTextMessage?.text
    || m?.imageMessage?.caption
    || m?.videoMessage?.caption
    || m?.documentMessage?.caption
    || m?.buttonsResponseMessage?.selectedButtonId
    || m?.listResponseMessage?.singleSelectReply?.selectedRowId
    || "";
}

async function startBot() {
  if (starting) return;
  starting = true;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let pairingNumber = process.env.PAIRING_NUMBER || "";
  if (!state.creds.registered && !pairingNumber) {
    const rl = createInterface({ input: stdin, output: stdout });
    pairingNumber = await rl.question("Masukkan nomor WhatsApp (contoh 628123456789): ");
    rl.close();
    pairingNumber = pairingNumber.replace(/\\D/g, "");
    if (!/^\\d{10,15}$/.test(pairingNumber)) throw new Error("Nomor tidak valid. Gunakan kode negara, contoh 628123456789.");
  }
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: ["KaynMusic", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  starting = false;

  sock.ev.on("creds.update", saveCreds);

  let pairingRequested = false;
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log("Menyiapkan pairing code...");
    if (!pairingRequested && !state.creds.registered && pairingNumber) {
      pairingRequested = true;
      try {
        const number = process.env.PAIRING_NUMBER.replace(/\D/g, "");
        const code = await sock.requestPairingCode(number);
        console.log("KaynMusic pairing code:", code);
        console.log("Masukkan kode ini di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.");
      } catch (error) {
        console.error("Gagal meminta pairing code:", error.message);
      }
    }
    if (connection === "open") console.log("KaynMusic Bot terhubung.");
    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log("Koneksi terputus:", status || "unknown");
      if (status !== DisconnectReason.loggedOut) {
        await delay(2500);
        startBot().catch(error => console.error("Reconnect error:", error));
      } else {
        console.log(`Sesi logout. Hapus folder ${AUTH_DIR} lalu tautkan ulang.`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const messageId = msg.key.id;
      if (!jid || jid === "status@broadcast" || handled.has(messageId)) continue;
      handled.add(messageId);
      if (handled.size > 1500) handled.clear();

      const text = getText(msg).trim();
      if (!text.startsWith(PREFIX)) continue;
      const [rawCommand, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
      const command = rawCommand.toLowerCase();
      const query = args.join(" ").trim();

      try {
        if (command === "help" || command === "menu") {
          await sock.sendMessage(jid, {
            text: "*🎵 KAYNMUSIC BOT*\n\n.play <judul> — cari lagu dan kirim audio\n.search <judul> — tampilkan hasil pencarian\n.ping — cek bot\n.help — bantuan\n\nContoh: .play Hindia Evaluasi"
          }, { quoted: msg });
          continue;
        }
        if (command === "ping") {
          await sock.sendMessage(jid, { text: "Pong! KaynMusic aktif 🎶" }, { quoted: msg });
          continue;
        }
        if (command !== "play" && command !== "search") {
          await sock.sendMessage(jid, { text: "Perintah tidak dikenal. Ketik .help" }, { quoted: msg });
          continue;
        }
        if (!query) {
          await sock.sendMessage(jid, { text: `Contoh: .${command} Hindia Evaluasi` }, { quoted: msg });
          continue;
        }

        await sock.sendMessage(jid, { text: `🔎 Mencari: *${query}*\nMohon tunggu...` }, { quoted: msg });
        const results = await searchMusic(query);
        if (command === "search") {
          const lines = results.slice(0, 8).map((track, index) =>
            `${index + 1}. *${track.title}*\n   👤 ${track.channel} · ⏱️ ${formatDuration(track.duration)}\n   ${track.url}`
          );
          await sock.sendMessage(jid, {
            text: `🎧 *Hasil pencarian KaynMusic*\n\n${lines.join("\n\n")}\n\nKetik .play <judul> untuk mengirim audio.`
          }, { quoted: msg });
          continue;
        }

        const track = results[0];
        await sock.sendMessage(jid, {
          text: `🎵 *${track.title}*\n👤 ${track.channel}\n⏱️ ${formatDuration(track.duration)}\n\nMenyiapkan audio...`
        }, { quoted: msg });

        const audio = await downloadAudio(track.url);
        await sock.sendMessage(jid, {
          audio,
          mimetype: "audio/mpeg",
          fileName: `${clean(track.title) || "kayn-music"}.mp3`,
          ptt: false
        }, { quoted: msg });
      } catch (error) {
        console.error("[KaynMusic command]", error);
        await sock.sendMessage(jid, {
          text: `❌ ${String(error.message || error).slice(0, 1000)}`
        }, { quoted: msg }).catch(() => {});
      }
    }
  });
}

startBot().catch(error => {
  console.error("KaynMusic startup failed:", error);
  process.exitCode = 1;
});
