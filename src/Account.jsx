import { useState } from "react";

export default function Account() {
  const [method, setMethod] = useState("oauth");
  const [showConnect, setShowConnect] = useState(false);
  const [fileName, setFileName] = useState("");
  const [notice, setNotice] = useState("");
  const connected = false;

  return <section className="content account-page">
    <p className="eyebrow">YOUR PERSONAL SPACE</p>
    <h1>Your <em>account.</em></h1>
    <p className="intro">Kelola identitas dan layanan yang terhubung ke KaynMusic.</p>

    <article className="account-profile">
      <div className="account-avatar">G</div>
      <div className="account-profile-copy"><strong>Guest account</strong><span>Belum masuk ke KaynMusic</span><small>Masuk untuk menyimpan preferensi dan mengelola koneksi di perangkat lain.</small></div>
      <span className="account-pill neutral">Guest</span>
    </article>

    <div className="account-section-heading"><div><small>CONNECTED SERVICES</small><h2>Koneksi layanan</h2></div><span className={connected ? "account-pill connected" : "account-pill neutral"}>{connected ? "1 connected" : "Belum terhubung"}</span></div>
    <article className="service-card">
      <div className="service-icon youtube-icon">▶</div>
      <div className="service-copy"><strong>YouTube</strong><span>{connected ? "Akun YouTube terhubung" : "Belum ada akun yang terhubung"}</span><p>Kelola sesi koneksi untuk membantu akses metadata dan pengalaman pemutaran.</p></div>
      <button className="account-primary" onClick={() => setShowConnect(true)}>Hubungkan ↗</button>
    </article>

    <div className="account-benefits">
      <div><b>◫</b><strong>Metadata lebih lengkap</strong><span>Informasi judul, channel, dan durasi.</span></div>
      <div><b>◈</b><strong>Kontrol di tanganmu</strong><span>Putuskan koneksi atau hapus data kapan saja.</span></div>
      <div><b>⌑</b><strong>Privasi sebagai default</strong><span>Kredensial tidak ditampilkan di browser.</span></div>
    </div>

    <article className="security-card"><div className="security-symbol">♢</div><div><strong>Keamanan koneksi</strong><p>KaynMusic tidak akan meminta password Google atau YouTube. Otorisasi dilakukan melalui halaman resmi Google. Jika metode impor cookie kelak tersedia, file akan diproses di server dan aksesnya dibatasi ke akun pemilik.</p><button className="account-text-button" onClick={() => setNotice("Fitur keamanan lanjutan akan diaktifkan bersama backend autentikasi.")}>Pelajari kebijakan data ↗</button></div></article>

    {showConnect && <div className="account-modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setShowConnect(false); }}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
      <button className="account-modal-close" onClick={() => setShowConnect(false)} aria-label="Tutup">×</button>
      <div className="service-icon youtube-icon large">▶</div><p className="eyebrow">YOUTUBE CONNECTION</p><h2 id="connect-title">Hubungkan akun YouTube</h2><p className="account-modal-intro">Pilih metode koneksi. KaynMusic tidak pernah meminta password akun Google-mu secara langsung.</p>
      <label className={`connection-option ${method === "oauth" ? "active" : ""}`}><input type="radio" name="connection-method" checked={method === "oauth"} onChange={() => setMethod("oauth")}/><span><strong>Otorisasi Google (OAuth)</strong><small>Metode resmi. Kamu akan diarahkan ke halaman Google untuk meninjau izin.</small><em>Direkomendasikan</em></span></label>
      <label className={`connection-option ${method === "cookie" ? "active" : ""}`}><input type="radio" name="connection-method" checked={method === "cookie"} onChange={() => setMethod("cookie")}/><span><strong>Impor cookies browser</strong><small>Alternatif lanjutan. File cookies bersifat sensitif dan dapat memberi akses ke sesi akun.</small><em>Perlu perlindungan backend</em></span></label>
      {method === "cookie" && <div className="cookie-upload"><label htmlFor="youtube-cookie-file">Pilih file cookies (.txt)</label><input id="youtube-cookie-file" type="file" accept=".txt,text/plain" onChange={e => setFileName(e.target.files?.[0]?.name || "")}/>{fileName && <small>Dipilih: {fileName}</small>}<p>Impor belum diaktifkan. Jangan unggah file sesi ke layanan atau orang yang tidak kamu percaya.</p></div>}
      <div className="account-modal-note"><span>🔒</span><p>{method === "oauth" ? "Saat ini integrasi OAuth belum dikonfigurasi. Tombol lanjut akan aktif setelah Client ID, redirect URI, dan verifikasi token backend disiapkan." : "Unggah cookies dinonaktifkan sampai enkripsi server-side, isolasi per pengguna, dan fitur hapus/rotasi siap."}</p></div>
      <button className="account-primary full" disabled>{method === "oauth" ? "Lanjutkan dengan Google" : "Simpan cookies dengan aman"}</button>
      <button className="account-cancel" onClick={() => setShowConnect(false)}>Batal</button>
    </section></div>}
    {notice && <div className="account-inline-notice" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
  </section>;
}
