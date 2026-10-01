import { useState } from "react";

const sections = ["Discover", "Search", "Listening rooms", "Your library"];
export default function App() {
  const [section, setSection] = useState("Discover");
  const [query, setQuery] = useState("");
  const [room, setRoom] = useState("");
  const [name, setName] = useState("Guest");
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [socket, setSocket] = useState(null);

  async function enterRoom() {
    const { io } = await import("socket.io-client");
    const connection = io();
    connection.on("connect", () => connection.emit("room:join", { roomId: room.trim().toUpperCase(), username: name }));
    connection.on("room:message", item => setMessages(old => [...old, item]));
    setSocket(connection);
    setJoined(true);
  }
  function sendMessage(event) {
    event.preventDefault();
    if (!message.trim() || !socket) return;
    socket.emit("room:chat", { text: message });
    setMessage("");
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
      {section === "Discover" && <section className="content"><p className="eyebrow">A SPACE FOR SOUND</p><h1>Find your next<br/><em>favorite sound.</em></h1><p className="intro">A quieter place to discover music and share the moment.</p><form className="search" onSubmit={e => { e.preventDefault(); setSection("Search"); }}><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search songs, artists, or moods..."/><button>Search ↗</button></form><div className="section-title"><div><small>YOUR SPACE</small><h2>Make it a shared moment.</h2></div><button className="plain" onClick={() => setSection("Listening rooms")}>Explore rooms ↗</button></div><div className="feature-grid"><article className="feature"><span>◉　LISTEN TOGETHER</span><h3>Same song.<br/>Different places.</h3><p>Join a listening room and experience music with others.</p><button onClick={() => setSection("Listening rooms")}>Enter rooms ↗</button></article><article className="feature feature-alt"><span>♫　YOUR COLLECTION</span><h3>Keep what<br/>moves you.</h3><p>Your favorites and playlists, gathered in one personal space.</p><button onClick={() => setSection("Your library")}>Open library ↗</button></article></div></section>}
      {section === "Search" && <section className="content"><p className="eyebrow">DISCOVERY</p><h1>Search <em>music.</em></h1><p className="intro">Find a track and explore its details.</p><form className="search" onSubmit={e => e.preventDefault()}><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Song, artist, or keyword..."/><button>Search ↗</button></form><div className="empty"><b>♫</b><h3>{query ? "Search provider is next" : "What are you in the mood for?"}</h3><p>{query ? "The interface is ready for a permitted music catalog integration." : "Try an artist, a song title, or a feeling."}</p></div></section>}
      {section === "Listening rooms" && <section className="content narrow"><p className="eyebrow">LIVE TOGETHER</p><h1>Listening <em>rooms.</em></h1><p className="intro">A shared space for music and conversation.</p><div className="room-card"><div className="room-heading"><div><small>JOIN A ROOM</small><h2>Enter with a room ID</h2></div><span className="live">● LIVE</span></div><label>Display name<input value={name} onChange={e => setName(e.target.value)} maxLength={32}/></label><label>Room ID<input value={room} onChange={e => setRoom(e.target.value.toUpperCase())} placeholder="e.g. KM-7F2A"/></label><button className="join" onClick={enterRoom} disabled={!room.trim()}>Join room ↗</button>{joined && <div className="chat"><div className="chat-head">Room {room.toUpperCase()} <span>Connected</span></div><div className="messages">{messages.map(m => <p key={m.id}><b>{m.username}</b> {m.text}</p>)}</div><form onSubmit={sendMessage}><input value={message} onChange={e => setMessage(e.target.value)} placeholder="Say something..."/><button>↑</button></form></div>}</div><p className="fine">Room chat is an initial development foundation. Authentication, persistence, permissions, and synchronized playback are upcoming.</p></section>}
      {section === "Your library" && <section className="content"><p className="eyebrow">PERSONAL COLLECTION</p><h1>Your <em>library.</em></h1><p className="intro">A home for the tracks and playlists you love.</p><div className="empty"><b>▤</b><h3>Your collection starts here.</h3><p>Favorites and playlists will appear here when connected to your account.</p></div></section>}
      <footer>© 2026 KAYNMUSIC <span>MADE FOR THE MOMENT.</span></footer>
    </main>
  </div>;
}