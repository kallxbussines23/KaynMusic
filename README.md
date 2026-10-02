# KaynMusic

KaynMusic is a web-based music discovery and listening-room prototype built with React, Vite, Express, Socket.IO, and optional Firebase Authentication/Realtime Database.

## Current features

- YouTube-oriented music search through Piped instances, with yt-dlp search fallback.
- Progressive audio endpoint: yt-dlp pipes source audio into FFmpeg, which encodes MP3 and sends packets to the client as they are produced. The full track is not saved to disk.
- Custom mini-player with seek controls and an expanded now-playing view.
- Listening rooms with room IDs, member presence, chat, and basic play/pause synchronization.
- Optional private YouTube cookies through a server-side Railway variable. Cookie contents are never returned to clients or logged.
- Health endpoint at `/api/health`.

## Stack

- React + Vite
- Node.js + Express
- yt-dlp + FFmpeg
- Socket.IO
- Firebase Authentication and Realtime Database (account UI is scaffolded)
- Railway / Docker

## Local development

Requirements: Node.js 22+, Python 3, FFmpeg, and yt-dlp available on PATH.

```bash
npm install
npm run dev
```

The Vite development server proxies API and Socket.IO requests to the Express server. Set the proxy target in `vite.config.js` if your server runs on a different port.

## Railway deployment

The included Dockerfile installs Python, FFmpeg, yt-dlp, and Deno, then builds and starts the app. Railway can deploy directly from the repository using Docker.

Optional environment variables:

- `PORT`: assigned automatically by Railway.
- `CLIENT_ORIGIN`: allowed Socket.IO origin; defaults to `*` for the prototype.
- `YOUTUBE_COOKIES_BASE64`: optional base64-encoded Netscape cookies file. Store only in Railway Variables, never commit cookies or paste them into client code.
- Firebase client variables: see `.env.example`.

## Streaming notes

Playback is progressive, not a completed-file download: the server streams FFmpeg output while yt-dlp is still processing the source. Startup time still depends on source availability, extractor response time, and the user's network. Buffering on the client cannot bypass YouTube rate limits, bot checks, expired media URLs, or copyright/platform restrictions. Use only sources and content you are authorized to access and stream.

For production, add request rate limits, room authorization, observability, and a compliant licensed audio provider. The current YouTube extraction integration is experimental and may stop working when upstream services change.
