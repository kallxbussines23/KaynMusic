import { useEffect, useRef, useState } from "react";

const sections = ["Discover", "Search", "Listening rooms", "Your library"];
const makeRoomId = () => `KM-${Array.from(crypto.getRandomValues(new Uint8Array(4)), n => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

export default function App() {
  const [section, setSection] = useState("Discover");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [room, setRoom] = useState("");
  const [name, setName] = useState("Guest");
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [socket, setSocket] = useState(null);
  const [trackUrl, setTrackUrl] = useState("");
  const [trackName, setTrackName] = useState("");
  const [trackStatus, setTrackStatus] = useState("Paste a direct audio URL to start listening.");
  const audioRef = useRef(null);
  const soloAudioRef = useRef(null);
  const [soloTrack, setSoloTrack] = useState(null);
  const [soloStatus, setSoloStatus] = useState("");
  const [soloLoading, setSoloLoading] = useState(false);
  const [members, setMembers] = useState([]);

  useEffect(() => () => socket?.disconnect(), [socket]);
  useEffect(() => {
    if (!soloTrack?.streamUrl || !soloAudioRef.current) return;
    const audio = soloAudioRef.current;
    audio.src = soloTrack.streamUrl;
    audio.load();
    audio.play().catch(() => setSoloStatus("Tap play to start listening."));
  }, [soloTrack?.streamUrl]);

  async function enterRoom(id = room) {
    const roomId = id.trim().toUpperCase();
    if (!roomId) return;
    socket?.disconnect();
    const { io } = await import("socket.io-client");
    const connection = io();
    connection.on("connect", () => connection.emit("room:join", { roomId, username: name }));
    connection.on("room:message", item => setMessages(old => [...old, item]));
    connection.on("room:members", setMembers);
    connection.on("room:error", setTrackStatus);
    connection.on("music:load", ({ url, title }) => {
      setTrackUrl(url); setTrackName(title || "Shared track");
      if (audioRef.current) { audioRef.current.src = url; audioRef.current.load(); }
      setTrackStatus("A room member shared a track.");
    });
    connection.on("music:play", ({ currentTime }) => {
      const audio = audioRef.current;
      if (audio) { if (Number.isFinite(currentTime)) audio.currentTime = currentTime; audio.play().catch(() => setTrackStatus("Tap Play to allow audio playback.")); }
    });
    connection.on("music:pause", ({ currentTime }) => {
      const audio = audioRef.current;
      if (audio) { if (Number.isFinite(currentTime)) audio.currentTime = currentTime; audio.pause(); }
    });
    setSocket(connection); setRoom(roomId); setMessages([]); setJoined(true);
  }
  function createRoom() {
    const id = makeRoomId();
    setRoom(id);
    enterRoom(id);
  }
  async function searchMusic(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true); setSearchError("");
    try {
      const response = await fetch(`/api/music/search?q=${encodeURIComponent(query.trim())}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Search failed");
      setSearchResults(data.results || []);
    } catch (error) { setSearchError(error.message || "Search gagal."); }
    finally { setSearching(false); }
  }
  async function playSolo(track) {
    setSoloLoading(true); setSoloStatus("Preparing audio stream…");
    try {
      const response = await fetch("/api/music/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: track.url }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to resolve track");
      setSoloTrack({ ...track, streamUrl: data.url, title: data.title || track.title });
      setSoloStatus("Ready to play");
      const audio = soloAudioRef.current;
      if (audio) {
        audio.src = data.url; audio.load();
        try { await audio.play(); } catch { setSoloStatus("Tap play to start listening."); }
      }
    } catch (error) { setSoloStatus(error.message || "Could not play this track."); }
    finally { setSoloLoading(false); }
  }
  function chooseTrack(track) { setTrackName(track.title); setTrackUrl(track.url); setSection("Listening rooms"); }
  function sendMessage(event) {
    event.preventDefault();
    if (!message.trim() || !socket) return;
    socket.emit("room:chat", { text: message }); setMessage("");
  }
  async function shareTrack(event) {
    event.preventDefault();
    if (!trackUrl.trim() || !socket) return;
    let url = trackUrl.trim();
    if (/youtube\.com|youtu\.be/i.test(url)) {
      setTrackStatus("Resolving YouTube audio…");
      try {
        const response = await fetch("/api/music/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Audio resolution failed");
        url = data.url;
      } catch (error) { setTrackStatus(error.message || "Could not resolve audio."); return; }
    }
    socket.emit("music:load", { url, title: trackName.trim() || "Shared track" });
    setTrackStatus("Track shared with room.");
  }
  function syncPlay() {
    const audio = audioRef.current;
    if (audio && socket) socket.emit("music:play", { currentTime: audio.currentTime });
  }
  function syncPause() {
    const audio = audioRef.current;
    if (audio && socket) socket.emit("music:pause", { currentTime: audio.currentTime });
  }

  return <div className="layout">
    <aside className="sidebar">
      <a className="brand" href="#home" onClick={() => setSection("Discover")}><span className="brand-icon">k</span> Kayn<span>Music</span></a>
      <p className="nav-label">WORKSPACE</p>
      {sections.map((item, i) => <button key={item} className={`nav-link ${section === item ? "selected" : ""}`} onClick={() => setSection(item)}><span>{["⌂", "⌕", "◉", "▤"][i]}</span>{item}</button>)}
      <div className="sidebar-foot"><span className="avatar">K</span><div><b>KaynMusic</b><small>Your sound, your space.</small></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>KaynMusic <i>/</i> {section}</span><span className="ready"><i/> All systems ready</span></header>
      {section === "Discover" && <section className="content"><p className="eyebrow">A SPACE FOR SOUND</p><h1>Find your next<br/><em>favorite sound.</em></h1><p className="intro">A quieter place to discover music and share the moment.</p><form className="search" onSubmit={e => { e.preventDefault(); setSection("Search"); }}><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search songs, artists, or moods..."/><button>Search ↗</button></form><div className="section-title"><div><small>YOUR SPACE</small><h2>Make it a shared moment.</h2></div><button className="plain" onClick={() => setSection("Listening rooms")}>Explore rooms ↗</button></div><div className="feature-grid"><article className="feature"><span>◉　LISTEN TOGETHER</span><h3>Same song.<br/>Different places.</h3><p>Create a room, share its ID, and listen in sync.</p><button onClick={() => setSection("Listening rooms")}>Create a room ↗</button></article><article className="feature feature-alt"><span>♫　YOUR COLLECTION</span><h3>Keep what<br/>moves you.</h3><p>Your favorites and playlists, gathered in one personal space.</p><button onClick={() => setSection("Your library")}>Open library ↗</button></article></div></section>}
      {section === "Search" && <section className="content"><p className="eyebrow">DISCOVERY</p><h1>Search <em>music.</em></h1><p className="intro">Find a track and explore its details.</p><form className="search" onSubmit={searchMusic}><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Song, artist, or keyword..."/><button disabled={searching}>{searching ? "Searching…" : "Search ↗"}</button></form>{searchError && <p className="track-status">{searchError}</p>}{searchResults.length ? <div className="yt-results"><div className="results-caption">YOUTUBE RESULTS · {searchResults.length}</div>{searchResults.map(track => <article className="yt-result" key={track.id}><img src={track.thumbnail || ""} alt="" loading="lazy"/><div className="yt-meta"><b>{track.title}</b><span>{track.channel} {track.duration ? "· " + Math.floor(track.duration/60) + ":" + String(track.duration%60).padStart(2,"0") : ""}</span></div><div className="result-actions"><button onClick={() => playSolo(track)} disabled={soloLoading}>{soloLoading ? "Loading…" : "▶ Play"}</button><button onClick={() => chooseTrack(track)}>＋ Room</button></div></article>)}</div> : <div className="empty"><b>♫</b><h3>{query ? (searching ? "Searching YouTube…" : "Search for a track") : "What are you in the mood for?"}</h3><p>Choose a result to share it in a listening room.</p></div>}</section>}
      {section === "Listening rooms" && <section className="content narrow"><p className="eyebrow">LIVE TOGETHER</p><h1>Listening <em>rooms.</em></h1><p className="intro">Create a room ID or join a friend's room to share music and conversation.</p><div className="room-card"><div className="room-heading"><div><small>ROOM CONTROL</small><h2>{joined ? `Room ${room}` : "Start listening together"}</h2></div><span className="live">● LIVE</span></div>{!joined ? <><label>Display name<input value={name} onChange={e => setName(e.target.value)} maxLength={32}/></label><label>Room ID<input value={room} onChange={e => setRoom(e.target.value.toUpperCase())} placeholder="Enter a friend's ID"/></label><button className="join" onClick={() => enterRoom()} disabled={!room.trim()}>Join room ↗</button><div className="or-divider">OR</div><button className="create-room" onClick={createRoom}>＋ Generate new room ID</button></> : <><div className="room-id-box"><span>SHARE THIS ROOM ID</span><strong>{room}</strong><button onClick={() => navigator.clipboard?.writeText(room)}>Copy ID</button></div><div className="members-line">◉ {members.length} listening {members.length === 1 ? "together" : "together"}</div><div className="player-panel"><div className="player-label">♫　SHARED MUSIC PLAYER</div><form className="track-form" onSubmit={shareTrack}><input value={trackName} onChange={e => setTrackName(e.target.value)} placeholder="Track title (optional)"/><input value={trackUrl} onChange={e => setTrackUrl(e.target.value)} type="url" placeholder="Direct audio URL (MP3, OGG, WAV...)"/><button className="join" disabled={!trackUrl.trim()}>Share track</button></form><audio ref={audioRef} controls onPlay={syncPlay} onPause={syncPause} onError={() => setTrackStatus("Could not load audio. Check the URL and CORS permissions.")} /><p className="track-status">{trackStatus}</p><p className="fine">Use a direct audio file URL that you have permission to play and share. Playback sync is an early version; each listener's browser must be able to access the audio source.</p></div><div className="chat"><div className="chat-head">Room chat <span>Connected</span></div><div className="messages">{messages.map(m => <p key={m.id}><b>{m.username}</b> {m.text}</p>)}</div><form onSubmit={sendMessage}><input value={message} onChange={e => setMessage(e.target.value)} placeholder="Say something..."/><button>↑</button></form></div><button className="leave-room" onClick={() => { socket?.disconnect(); setSocket(null); setJoined(false); setMembers([]); }}>Leave room</button></>}</div><p className="fine">Room IDs are currently temporary and rooms reset when the server restarts. Account permissions and persistent rooms will be added later.</p></section>}
      {section === "Your library" && <section className="content"><p className="eyebrow">PERSONAL COLLECTION</p><h1>Your <em>library.</em></h1><p className="intro">A home for the tracks and playlists you love.</p><div className="empty"><b>▤</b><h3>Your collection starts here.</h3><p>Favorites and playlists will appear here when connected to your account.</p></div></section>}
      <footer>© 2026 KAYNMUSIC <span>MADE FOR THE MOMENT.</span></footer>
      {soloTrack && <div className="solo-player"><div className="solo-track"><img src={soloTrack.thumbnail || ""} alt=""/><div><b>{soloTrack.title}</b><span>{soloTrack.channel || "YouTube"} · {soloStatus}</span></div></div><audio ref={soloAudioRef} controls onError={() => setSoloStatus("Audio stream failed. Try another result.")}/><button className="solo-to-room" onClick={() => { setTrackName(soloTrack.title); setTrackUrl(soloTrack.url); setSection("Listening rooms"); }}>＋ Room</button></div>}
    </main>
  </div>;
}