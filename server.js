// Servidor do jogo: contas, login, saves e eventos para todos.
// Rodar:  ADMIN_TOKEN=suasenha node server.js
const { WebSocketServer } = require("ws"), fs = require("fs"), crypto = require("crypto"), http = require("http"), path = require("path"), os = require("os");
const PORT = process.env.PORT || 8080, TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN) { console.log("Defina a senha de admin: ADMIN_TOKEN=suasenha node server.js"); process.exit(1); }

// ---------- banco (arquivo local ou Upstash na nuvem) ----------
const FILE = "accounts.json", UP_URL = process.env.UPSTASH_URL, UP_TOKEN = process.env.UPSTASH_TOKEN;
let DB = { users: {}, sessions: {} }, dirty = false, saving = false, loaded = false;
const upCmd = async cmd => {
  const r = await fetch(UP_URL, { method: "POST", headers: { Authorization: "Bearer " + UP_TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
};
async function loadDB() {
  try {
    if (UP_URL) { const v = await upCmd(["GET", "accounts"]); if (v) DB = JSON.parse(v); }
    else DB = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    if (UP_URL) { console.log("Nao consegui ler o banco na nuvem:", e.message); process.exit(1); }
  }
  DB.users = DB.users || {}; DB.sessions = DB.sessions || {}; loaded = true;
  console.log(UP_URL ? "Contas carregadas da nuvem (Upstash)." : "Contas em arquivo local.");
}
async function flush() {
  if (!dirty || !loaded || saving) return; dirty = false; saving = true;
  try {
    if (UP_URL) await upCmd(["SET", "accounts", JSON.stringify(DB)]);
    else { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB)); fs.renameSync(FILE + ".tmp", FILE); }
  } catch (e) { console.log("erro ao salvar:", e.message); dirty = true; }
  saving = false;
}
setInterval(flush, UP_URL ? 15000 : 5000);
const bye = async () => { dirty = true; saving = false; await flush(); process.exit(); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);

// ---------- utilidades ----------
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const same = (a, b) => { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clean = n => String(n || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);
const num = (n, a, b) => Math.max(a, Math.min(b, +n || 0));
function sanitize(s) {
  if (!s || typeof s !== "object") return null;
  const obj = (o, max) => {
    const r = {};
    if (o && typeof o === "object") Object.keys(o).slice(0, max).forEach(k => {
      const v = o[k], key = String(k).slice(0, 80);
      if (typeof v === "number") r[key] = num(v, 0, 1e15); else if (typeof v === "string") r[key] = v.slice(0, 40);
    });
    return r;
  };
  return { coins: num(s.coins, 0, 1e15), own: obj(s.own, 300), up: obj(s.up, 40), rolls: num(s.rolls, 0, 1e12),
    best: num(s.best, 0, 7) | 0, rb: num(s.rb, 0, 1e6) | 0, acc: obj(s.acc, 60), eq: obj(s.eq, 20),
    skins: obj(s.skins, 100), sk: obj(s.sk, 20), tayerUntil: num(s.tayerUntil, 0, 4e12) };
}

function boot() {
// ---------- rede ----------
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "index.html"), (e, d) => {
    if (e) { res.writeHead(500); return res.end("index.html nao encontrado ao lado do server.js"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 30000 });
const send = (c, o) => { if (c.readyState === 1) c.send(JSON.stringify(o)); };
const bc = o => wss.clients.forEach(c => send(c, o));
const fails = {};
const KINDS = { msg: ["text"], coins: ["n"], mult: ["x", "sec"], luck: ["x", "sec"], tayer: ["min"], sleep: ["sec"], drop: ["r"], brainrot: ["n", "sec"] };

function newSession(u, ws) {
  const tok = crypto.randomBytes(24).toString("hex"), old = DB.users[u].active;
  if (old) delete DB.sessions[old];
  DB.sessions[tok] = { user: u, at: Date.now() }; DB.users[u].active = tok; dirty = true;
  wss.clients.forEach(c => { if (c !== ws && c.user === u) { send(c, { t: "kicked" }); c.user = null; } });
  ws.user = u; ws.tok = tok; return tok;
}
const ok = (ws, u, tok) => send(ws, { t: "authok", user: u, token: tok, save: DB.users[u].save });
const err = (ws, msg) => send(ws, { t: "err", msg });

wss.on("connection", ws => {
  ws.admin = false; ws.user = null; ws.msgs = 0;
  ws.on("message", raw => {
    if (++ws.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "register") {
      const u = clean(m.user), p = String(m.pass || "");
      if (u.length < 3) return err(ws, "Usuário precisa ter 3 a 16 letras, números ou _.");
      if (p.length < 6 || p.length > 64) return err(ws, "A senha precisa ter de 6 a 64 caracteres.");
      if (DB.users[u]) return err(ws, "Esse usuário já existe.");
      const salt = crypto.randomBytes(16).toString("hex");
      DB.users[u] = { salt, hash: hash(p, salt), created: Date.now(), save: null, active: null }; dirty = true;
      ok(ws, u, newSession(u, ws));
    } else if (m.t === "login") {
      const u = clean(m.user), p = String(m.pass || ""), f = fails[u] || (fails[u] = { n: 0, until: 0 });
      if (f.until > Date.now()) return err(ws, "Muitas tentativas. Espere 30 segundos.");
      const acc = DB.users[u];
      if (!acc || !same(hash(p, acc.salt), acc.hash)) { if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 30000; } return err(ws, "Usuário ou senha incorretos."); }
      f.n = 0; ok(ws, u, newSession(u, ws));
    } else if (m.t === "resume") {
      const s = DB.sessions[String(m.token)];
      if (!s || !DB.users[s.user] || DB.users[s.user].active !== m.token) return send(ws, { t: "authfail" });
      ws.user = s.user; ws.tok = m.token; ok(ws, s.user, m.token);
    } else if (m.t === "logout") {
      if (ws.user && DB.users[ws.user] && DB.users[ws.user].active === ws.tok) { delete DB.sessions[ws.tok]; DB.users[ws.user].active = null; dirty = true; }
      ws.user = null;
    } else if (m.t === "save") {
      if (!ws.user) return;
      const acc = DB.users[ws.user];
      if (!acc || acc.active !== ws.tok) { send(ws, { t: "kicked" }); ws.user = null; return; }
      const sv = sanitize(m.save); if (!sv) return;
      acc.save = sv; acc.seen = Date.now(); dirty = true;
    } else if (m.t === "auth") {
      ws.admin = typeof m.token === "string" && m.token === TOKEN; send(ws, { t: "auth", ok: ws.admin });
    } else if (ws.admin && m.t === "event" && m.ev && KINDS[m.ev.k]) {
      const ev = { k: m.ev.k };
      KINDS[ev.k].forEach(f => ev[f] = f === "text" ? String(m.ev.text || "").slice(0, 120) : num(m.ev[f], 0, 1e9));
      console.log("evento", ev); bc({ t: "event", ev });
    } else if (ws.admin && m.t === "give") {
      const u = clean(m.user), n = num(m.n, 0, 1e12), acc = DB.users[u];
      if (!acc) return err(ws, "Conta não existe.");
      if (!acc.save) acc.save = sanitize({}); acc.save.coins = num(acc.save.coins + n, 0, 1e15); dirty = true;
      wss.clients.forEach(c => { if (c.user === u) send(c, { t: "give", n }); });
      send(ws, { t: "ban", msg: "Enviado " + n + " coins para " + u });
    } else if (ws.admin && m.t === "users") {
      send(ws, { t: "users", list: Object.entries(DB.users).map(([name, a]) => ({ name, coins: a.save ? Math.floor(a.save.coins) : 0, online: [...wss.clients].some(c => c.user === name) })) });
    }
  });
});
setInterval(() => wss.clients.forEach(c => c.msgs = 0), 1000);
setInterval(() => {
  const top = Object.entries(DB.users).filter(([, a]) => a.save).map(([name, a]) => ({
    name, got: Object.values(a.save.own).filter(v => v > 0).length, best: a.save.best, rolls: a.save.rolls }))
    .sort((a, b) => b.got - a.got || b.best - a.best || a.rolls - b.rolls).slice(0, 10);
  bc({ t: "state", online: [...wss.clients].filter(c => c.user).length, top });
}, 3000);
server.listen(PORT, "0.0.0.0", () => {
  console.log("\nSERVIDOR LIGADO. Nao feche esta janela.");
  console.log("No seu PC:        http://localhost:" + PORT);
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === "IPv4" && !i.internal)
    .forEach(i => console.log("Mesma rede Wi-Fi: http://" + i.address + ":" + PORT));
});
}
loadDB().then(boot);
