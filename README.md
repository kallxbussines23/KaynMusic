# KaynMusic

A social music web experience focused on discovery, personal libraries, and real-time listening rooms.

## Stack
- React + Vite
- Node.js + Express
- Socket.IO for room events and chat
- Firebase Authentication (email/password) and Realtime Database
- Railway for deployment

## Local development

```bash
npm install
npm run dev
```

The frontend runs on Vite and proxies `/api` and `/socket.io` to the Express server.

## Deployment

Railway should run `npm install`, build with `npm run build`, and start with `npm start`. Configure Firebase client settings as environment variables before enabling authentication.

## Project status

Initial project setup. Search provider, account flows, synchronized playback, and production room authorization are planned next. Only use audio sources you are authorized to stream.