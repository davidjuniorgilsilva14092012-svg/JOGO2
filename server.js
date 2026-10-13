// Servidor do jogo: contas, login, saves, códigos, títulos, banimentos, eventos (Admin Abuse) e eventos naturais.
// Rodar: ADMIN_ABUSE_TOKEN=senha1 ADMIN_STAFF_TOKEN=senha2 ADMIN_PANEL_CODE=chave-secreta node server.js
// ADMIN_PANEL_CODE é uma chave alternativa para entrar nos dois painéis; mantenha-a secreta.
// (a variável antiga ADMIN_TOKEN continua valendo como senha do painel Admin Abuse)
const { WebSocketServer } = require("ws"), fs = require("fs"), crypto = require("crypto"), http = require("http"), path = require("path"), os = require("os");
const PORT = process.env.PORT || 8080;
const BUILD = "v3-2026-10-13";
console.log("Versão do servidor:", BUILD);
const ABUSE = "Giovana1710";
let STAFF = "meteorovulcano3565";
const PANEL_CODE = process.env.ADMIN_PANEL_CODE;
if (!ABUSE) { console.log("Defina a senha do Admin Abuse: ADMIN_ABUSE_TOKEN=senha1 ADMIN_STAFF_TOKEN=senha2 node server.js"); process.exit(1); }
if (!STAFF) console.log("Aviso: ADMIN_STAFF_TOKEN não definido. O painel de Administração Pessoal fica desligado.");
if (STAFF && STAFF === ABUSE) { console.log("Aviso: as duas senhas são iguais. O painel de Administração Pessoal fica desligado até você usar senhas diferentes."); STAFF = null; }

// ---------- banco (arquivo local ou Upstash: um campo por conta, para não estourar o limite de tamanho) ----------
const FILE = process.env.DB_FILE || "accounts.json", UP_URL = process.env.UPSTASH_URL, UP_TOKEN = process.env.UPSTASH_TOKEN;
let DB = { users: {}, codes: {}, audit: [], cfg: {}, nat: 0 }, SESS = {};
const dirtyU = new Set(); let metaDirty = false, saving = false, loaded = false;
const markU = u => dirtyU.add(u), markM = () => { metaDirty = true; };
const upCmd = async cmd => {
  const r = await fetch(UP_URL, { method: "POST", headers: { Authorization: "Bearer " + UP_TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
};
const meta = () => ({ codes: DB.codes, audit: DB.audit, cfg: DB.cfg, nat: DB.nat });
async function loadDB() {
  try {
    if (UP_URL) {
      const arr = await upCmd(["HGETALL", "dp:users"]) || [];
      for (let i = 0; i < arr.length; i += 2) DB.users[arr[i]] = JSON.parse(arr[i + 1]);
      const m = await upCmd(["GET", "dp:meta"]); if (m) Object.assign(DB, JSON.parse(m));
      if (!arr.length) { // migra o formato antigo (tudo numa chave "accounts")
        const old = await upCmd(["GET", "accounts"]);
        if (old) { const o = JSON.parse(old); DB.users = o.users || {}; Object.keys(DB.users).forEach(markU); markM(); console.log("Migrando", dirtyU.size, "contas do formato antigo."); }
      }
    } else if (fs.existsSync(FILE)) Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (e) { console.log("Não consegui ler o banco:", e.message); process.exit(1); }
  DB.users = DB.users || {}; DB.codes = DB.codes || {}; DB.audit = DB.audit || []; DB.cfg = Object.assign(CFG0(), DB.cfg || {}); delete DB.sessions;
  for (const [u, a] of Object.entries(DB.users)) { if (a.active) SESS[a.active] = u; a.titles = a.titles || []; a.red = a.red || {}; a.pend = a.pend || []; }
  seedCodes(); loaded = true;
  console.log(UP_URL ? "Contas carregadas da nuvem (Upstash)." : "Contas em arquivo local (" + FILE + ").");
}
async function flush() {
  if (!loaded || saving || (!dirtyU.size && !metaDirty)) return;
  saving = true; const us = [...dirtyU]; dirtyU.clear(); const md = metaDirty; metaDirty = false;
  try {
    if (UP_URL) {
      for (let i = 0; i < us.length; i += 20) {
        const part = us.slice(i, i + 20), cmd = ["HSET", "dp:users"];
        part.forEach(u => { if (DB.users[u]) cmd.push(u, JSON.stringify(DB.users[u])); });
        if (cmd.length > 2) await upCmd(cmd);
      }
      if (md) await upCmd(["SET", "dp:meta", JSON.stringify(meta())]);
    } else { fs.writeFileSync(FILE + ".tmp", JSON.stringify({ users: DB.users, ...meta() })); fs.renameSync(FILE + ".tmp", FILE); }
  } catch (e) { console.log("erro ao salvar:", e.message); us.forEach(markU); if (md) markM(); }
  saving = false;
}
setInterval(flush, UP_URL ? 15000 : 3000);
const bye = async () => { saving = false; await flush(); process.exit(); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);

// ---------- utilidades ----------
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const same = (a, b) => { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sameSecret = (a, b) => typeof a === "string" && typeof b === "string" && crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
const clean = n => String(n || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);
const num = (n, a, b) => { n = +n; return Math.max(a, Math.min(b, Number.isFinite(n) ? n : a)); };
const txt = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const rid = () => crypto.randomBytes(6).toString("hex");
function audit(who, act, info) { DB.audit.push({ at: Date.now(), who: txt(who, 24), act, info: txt(typeof info === "string" ? info : JSON.stringify(info), 300) }); if (DB.audit.length > 500) DB.audit.splice(0, DB.audit.length - 500); markM(); }

// ---------- validação de save (formato v4; aceita os campos antigos) ----------
const NUMF = { coins: [0, 1e300], rolls: [0, 1e15], best: [0, 12], rb: [0, 1e6], pr: [0, 1e6], rp: [0, 1e12], stars: [0, 1e12], tayerUntil: [0, 4e12], tay: [0, 4e12], lk: [0, 100], lkr: [0, 1], ls: [0, 4e12], rev: [0, 1e12], v: [0, 100] };
const MAPF = { own: 400, up: 80, rpu: 40, stu: 40, acc: 60, eq: 20, skins: 200, sk: 20, au: 800, mu: 3000, st: 80, ms: 600, pb: 20, red: 60, gids: 300, chd: 20, ds: 40, ws: 40, dg: 40 };
const STRF = { aeq: 40, ch: 20, dk: 20, wk: 20 };
function sanitize(s) {
  if (!s || typeof s !== "object") return null;
  const obj = (o, max) => {
    const r = {};
    if (o && typeof o === "object") Object.keys(o).slice(0, max).forEach(k => {
      const v = o[k], key = String(k).slice(0, 80);
      if (typeof v === "number" && Number.isFinite(v)) r[key] = num(v, 0, 1e300); else if (typeof v === "string") r[key] = v.slice(0, 40);
    });
    return r;
  };
  const r = {};
  for (const k in NUMF) r[k] = num(s[k], NUMF[k][0], NUMF[k][1]);
  r.best |= 0; r.lkr = r.lkr ? 1 : 0;
  for (const k in MAPF) r[k] = obj(s[k], MAPF[k]);
  for (const k in STRF) r[k] = typeof s[k] === "string" ? s[k].slice(0, STRF[k]) : "";
  return r;
}

// ---------- códigos ----------
// Códigos antigos ficam como hash (o texto não está em lugar nenhum); valem uma vez por conta.
const LH = s => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h; };
const lnorm = x => String(x).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const ckey = x => String(x || "").toUpperCase().replace(/\s+/g, "").slice(0, 40);
function seedCodes() {
  const seed = (k, c) => { if (!DB.codes[k]) { DB.codes[k] = Object.assign({ max: 0, per: 1, exp: 0, rev: false, uses: 0, at: Date.now(), by: "padrão" }, c); markM(); } };
  seed("NEUSA-ADM-7KQ9-XP2M", { r: { t: "title", v: "ADM" } });
  seed("TENILDO-ADM-4V8R-ZN6C", { r: { t: "title", v: "ADM" } });
  seed("BETA-NEUSA-2026-TEST", { r: { t: "title", v: "Beta Tester" } });
  seed("#padre", { hash: 4030847110, label: "código antigo da skin Padre", r: { t: "skin", v: "matheus:padre" } });
  seed("#tayer", { hash: 2430989548, label: "código antigo do Tayer", r: { t: "tayer", v: 5 } });
  seed("#aura", { hash: 2503185959, label: "código antigo da Aura do Amaro King", r: { t: "acc", v: "aura" } });
}
const RT = { title: "título", coins: "coins", skin: "skin", aura: "aura", acc: "acessório", tayer: "minutos de Tayer", lucky: "Lucky Spin pronto" };
const rdesc = r => r.t === "title" ? "Título " + r.v : r.t === "coins" ? r.v + " coins" : r.t === "tayer" ? r.v + " min de Tayer" : r.t === "lucky" ? "Lucky Spin pronto" : (RT[r.t] || r.t) + " " + r.v;

// ---------- catálogo do Admin Abuse ----------
const W8 = [["ouro", "Chuva de Ouro"], ["eletrica", "Tempestade Elétrica"], ["meteoro", "Chuva de Meteoros"], ["nevoa", "Névoa Misteriosa"], ["inverno", "Inverno Absoluto"], ["eclipse", "Eclipse Carmesim"], ["aurora", "Aurora Celestial"], ["caosd", "Caos Dimensional"]];
const M5 = [["g", "Dourada"], ["e", "Elétrica"], ["c", "Corrompida"], ["k", "Cósmica"], ["p", "Prismática"]];
const R13 = ["Comum", "Incomum", "Raro", "Épico", "Lendário", "Mítico", "Secreto", "Celestial", "Transcendente", "Dimensional", "Paradoxal", "Primordial", "Absoluta"].map((n, i) => [i, n]);
const pN = (f, l, min, max, def) => ({ f, l, ty: "n", min, max, def });
const pS = (f, l, o, def) => ({ f, l, ty: "s", o, def });
const pT = (f, l, max, def) => ({ f, l, ty: "t", max, def });
const INT = pN("i", "Intensidade (1-3)", 1, 3, 2);
const CAT = [
  { id: "lucky10", k: "lucky", n: "Lucky 10x", c: "Sorte", fix: { x: 10 }, dur: [120, 10, 3600], g: "lucky", d: "Sorte x10 para todos. Lucky não acumula: vale o maior; o mesmo valor renova o tempo." },
  { id: "lucky50", k: "lucky", n: "Lucky 50x", c: "Sorte", fix: { x: 50 }, dur: [90, 10, 3600], g: "lucky", d: "Sorte x50 para todos." },
  { id: "lucky100", k: "lucky", n: "Lucky 100x", c: "Sorte", fix: { x: 100 }, dur: [60, 10, 1800], g: "lucky", d: "Sorte x100 para todos." },
  { id: "lucky1000", k: "lucky", n: "Lucky 1000x", c: "Sorte", fix: { x: 1000 }, dur: [30, 10, 600], g: "lucky", conf: 1, d: "Sorte x1000. Raridades altas ficam muito comuns." },
  { id: "speed", k: "speed", n: "Aumento de velocidade", c: "Velocidade", p: [pS("x", "Multiplicador", [[2, "x2"], [3, "x3"], [5, "x5"]], 2)], dur: [60, 10, 1800], g: "speed", d: "Rolagem, mão e ajudantes mais rápidos." },
  { id: "clima", k: "weather", n: "Clima (escolher)", c: "Clima", p: [pS("w", "Clima", W8, "ouro"), INT], dur: [300, 30, 3600], g: "weather", d: "Inicia qualquer um dos 8 climas. Um clima novo substitui o atual." },
  { id: "ouro", k: "weather", n: "Chuva de Ouro", c: "Clima", fix: { w: "ouro" }, p: [INT], dur: [300, 30, 3600], g: "weather", d: "Coins x2 e mutação Dourada." },
  { id: "caos", k: "chaos", n: "Tempestade do Caos", c: "Clima", fix: { w: "eletrica" }, p: [INT], dur: [180, 30, 1800], g: "weather", tag: "chaos", d: "Tempestade elétrica com pulsos aleatórios de sorte e mutação." },
  { id: "meteoro", k: "weather", n: "Chuva de Meteoros", c: "Clima", fix: { w: "meteoro" }, p: [INT], dur: [300, 30, 3600], g: "weather", d: "Sorte x2 e mutação Cósmica." },
  { id: "nevoa", k: "weather", n: "Névoa Misteriosa", c: "Clima", fix: { w: "nevoa" }, p: [INT], dur: [300, 30, 3600], g: "weather", d: "Secreto ou acima x3." },
  { id: "inverno", k: "weather", n: "Inverno Absoluto", c: "Clima", fix: { w: "inverno" }, p: [INT], dur: [300, 30, 3600], g: "weather", d: "A vó dorme mais e o roubo rende mais." },
  { id: "gravity", k: "gravity", n: "Gravidade Zero", c: "Física", dur: [60, 10, 900], g: "phys", d: "Tudo flutua; roubos x1,5 e mão mais rápida." },
  { id: "giant", k: "giant", n: "Modo Gigante", c: "Física", dur: [90, 10, 900], g: "size", d: "Vó gigante: roubo x2, mas ela vigia mais." },
  { id: "mini", k: "mini", n: "Modo Miniatura", c: "Física", dur: [90, 10, 900], g: "size", d: "Vó miniatura: dorme mais e a mão fica mais rápida." },
  { id: "pipes", k: "pipes", n: "Invasão de Cachimbos", c: "Recompensas", p: [pN("n", "Quantidade", 5, 60, 20), pN("v", "Valor (em cachimbos)", 1, 200, 10)], dur: [40, 10, 300], d: "Cachimbos voadores aparecem na tela; toque para pegar." },
  { id: "fury", k: "fury", n: "Fúria da Vó", c: "Vó Neusa", p: [pN("x", "Recompensa (x)", 2, 10, 5)], dur: [60, 10, 600], g: "vo", tag: "chaos", d: "Ela vigia muito mais, mas cada roubo vale mais." },
  { id: "apoc", k: "apoc", n: "Apocalipse RNG", c: "Sorte", dur: [45, 10, 600], g: "apoc", tag: "chaos", conf: 1, d: "Sorte x25, coins x3, rolagem x2." },
  { id: "revert", k: "revert", n: "Reversão do Caos", c: "Controle", dur: [60, 10, 600], g: "calm", special: "revert", d: "Encerra eventos de caos e dá sorte x2 de calmaria." },
  { id: "overdrive", k: "overdrive", n: "RNG Overdrive", c: "Sorte", p: [pS("x", "Velocidade", [[3, "x3"], [5, "x5"], [10, "x10"]], 5)], dur: [45, 10, 600], g: "overdrive", d: "Rolagens grátis, automáticas e muito mais rápidas." },
  { id: "rainr", k: "rainr", n: "Chuva de Raridades", c: "Sorte", p: [pS("min", "Raridade mínima", R13.slice(2, 7), 2), pN("every", "Rolagem grátis a cada (s)", 5, 60, 15)], dur: [60, 10, 600], g: "rainr", d: "Toda rolagem é pelo menos da raridade escolhida e há rolagens grátis." },
  { id: "hunt", k: "tier", n: "Caçada ao Secreto", c: "Sorte", fix: { from: 6 }, p: [pN("x", "Multiplicador", 2, 50, 10)], dur: [90, 10, 900], g: "hunt", d: "Secreto ou acima muito mais comum." },
  { id: "legend", k: "legend", n: "Lendários em Destaque", c: "Sorte", p: [pN("x", "Multiplicador", 2, 50, 10)], dur: [90, 10, 900], g: "legend", d: "Lendário mais comum e com recompensa x3." },
  { id: "portal", k: "tier", n: "Portal Celestial", c: "Sorte", fix: { from: 7, portal: 1 }, p: [pN("x", "Multiplicador", 2, 100, 20)], dur: [90, 10, 900], g: "portal", d: "Abre um portal: Celestial ou acima muito mais comum." },
  { id: "seq", k: "seq", n: "Sequência de Sorte", c: "Sorte", p: [pN("step", "% de sorte por rolagem", 1, 50, 10)], dur: [90, 10, 900], g: "seq", d: "Cada rolagem seguida aumenta a sorte da próxima." },
  { id: "mutg", k: "mut", n: "Mutação Global", c: "Mutações", p: [pS("m", "Mutação", M5, "g")], dur: [60, 10, 900], g: "mut", d: "Toda rolagem vem com a mutação escolhida." },
  { id: "mutr", k: "mut", n: "Mutação Aleatória", c: "Mutações", rnd: "m", dur: [60, 10, 900], g: "mut", d: "O servidor sorteia uma mutação para todas as rolagens." },
  { id: "mutc", k: "mutc", n: "Mutação em Cascata", c: "Mutações", p: [pN("step", "% de mutação por rolagem", 1, 25, 5)], dur: [90, 10, 900], g: "mut", d: "A chance de mutação sobe a cada rolagem." },
  { id: "muts", k: "mut", n: "Mutação Suprema", c: "Mutações", fix: { m: "p" }, dur: [45, 10, 600], g: "mut", conf: 1, d: "Toda rolagem vem Prismática." },
  { id: "purify", k: "purify", n: "Purificação", c: "Mutações", special: "purify", d: "Encerra todos os eventos de mutação. Não mexe no inventário de ninguém." },
  { id: "mutsel", k: "mut", n: "Mutação Seletiva", c: "Mutações", p: [pS("m", "Mutação", M5, "k"), pS("minR", "A partir de", R13.slice(1), 4)], dur: [90, 10, 900], g: "mut", d: "Só rolagens a partir da raridade escolhida recebem a mutação." },
  { id: "blackout", k: "blackout", n: "Blackout", c: "Efeitos", dur: [45, 10, 600], g: "light", tag: "chaos", d: "As luzes apagam: a vó enxerga menos e o roubo rende x2." },
  { id: "glitch", k: "glitch", n: "Glitch da Realidade", c: "Efeitos", p: [pN("max", "Sorte máxima por rolagem", 2, 100, 20)], dur: [45, 10, 600], g: "glitch", tag: "chaos", d: "A tela falha e cada rolagem recebe sorte aleatória." },
  { id: "invade", k: "invade", n: "Invasão de Personagens", c: "Efeitos", p: [pN("lv", "Nível mínimo dos ajudantes", 1, 40, 15)], dur: [120, 10, 900], g: "invade", d: "Lana, Matheus, Tenildo e Tayer aparecem para todo mundo e trabalham em dobro." },
  { id: "roleta", k: "roleta", n: "Roleta do Admin", c: "Controle", special: "roleta", d: "Sorteia e inicia um evento aleatório seguro." },
  { id: "boss", k: "boss", n: "Evento Final Boss", c: "Vó Neusa", p: [pN("hp", "Vida (roubos)", 5, 200, 25), pN("rew", "Recompensa (em cachimbos)", 10, 1e5, 500)], dur: [180, 30, 1200], g: "size", conf: 1, d: "A Vó vira chefona: cada roubo tira vida. Derrote antes do tempo para ganhar o prêmio." },
  { id: "supremo", k: "supremo", n: "Admin Abuse Supremo", c: "Controle", special: "supremo", p: [pS("preset", "Sequência", [["classico", "Clássico"], ["caos", "Caos total"], ["celestial", "Ascensão celestial"], ["festa", "Festa da Vó"], ["custom", "Personalizada (montada no painel)"]], "classico")], conf: 1, d: "Executa uma sequência de clima, sorte, mutações, efeitos e cutscenes." },
  { id: "cutscene", k: "cutscene", n: "Cutscene ao vivo", c: "Efeitos", p: [pS("r", "Raridade", R13.slice(4), 8)], d: "Mostra a cutscene de uma raridade para todos (só exibição, sem prêmio)." },
  { id: "msg", k: "msg", n: "Aviso para todos", c: "Clássicos", p: [pT("text", "Mensagem", 120, "Atenção jogadores! Evento começando!")], d: "Faixa de aviso no topo da tela." },
  { id: "coins", k: "coins", n: "Coins para todos", c: "Clássicos", p: [pN("n", "Quantidade", 1, 1e12, 1000)], d: "Dá coins para quem está online agora." },
  { id: "mult", k: "mult", n: "Coins xN", c: "Clássicos", p: [pN("x", "Multiplicador", 2, 100, 5)], dur: [60, 5, 900], g: "mult", d: "Multiplica todas as coins." },
  { id: "luckx", k: "lucky", n: "Sorte xN (livre)", c: "Clássicos", p: [pN("x", "Multiplicador", 2, 1000, 5)], dur: [60, 5, 900], g: "lucky", d: "Lucky com valor livre (segue a regra do maior)." },
  { id: "tayer", k: "tayer", n: "Tayer para todos", c: "Clássicos", p: [pN("min", "Minutos", 1, 10, 5)], d: "Chama o Tayer para todo mundo." },
  { id: "sleep", k: "sleep", n: "Vó dorme", c: "Vó Neusa", dur: [60, 5, 300], g: "vo", d: "A vó dorme e não vigia." },
  { id: "drop", k: "drop", n: "Drop de raridade", c: "Clássicos", p: [pS("r", "Raridade", R13.slice(2), 4)], conf: 1, d: "Dá uma rolagem da raridade escolhida para quem está online." },
  { id: "brainrot", k: "brainrot", n: "Brainrot", c: "Clássicos", p: [pN("n", "Coins", 1, 1e12, 5000)], dur: [20, 5, 60], d: "Um botão foge pela tela; quem tocar primeiro no seu aparelho ganha." }
];
const CATI = {}; CAT.forEach(c => CATI[c.id] = c);
const PRESETS = {
  classico: [{ at: 0, id: "ouro", dur: 150 }, { at: 5, id: "lucky10", dur: 120 }, { at: 40, id: "mutr", dur: 60 }, { at: 90, id: "cutscene", p: { r: 8 } }],
  caos: [{ at: 0, id: "caos", dur: 120 }, { at: 3, id: "glitch", dur: 60 }, { at: 10, id: "lucky100", dur: 60 }, { at: 20, id: "mutc", dur: 90 }, { at: 70, id: "apoc", dur: 45 }, { at: 118, id: "revert", dur: 30 }],
  celestial: [{ at: 0, id: "clima", p: { w: "aurora", i: 3 }, dur: 180 }, { at: 5, id: "portal", dur: 150 }, { at: 20, id: "lucky50", dur: 120 }, { at: 60, id: "muts", dur: 60 }, { at: 120, id: "cutscene", p: { r: 11 } }],
  festa: [{ at: 0, id: "msg", p: { text: "A Vó Neusa vai dar uma festa!" } }, { at: 3, id: "pipes", dur: 60 }, { at: 10, id: "invade", dur: 120 }, { at: 30, id: "gravity", dur: 45 }, { at: 80, id: "boss", dur: 240 }]
};
const ROLETA = ["ouro", "meteoro", "lucky10", "lucky50", "speed", "pipes", "gravity", "giant", "mini", "legend", "hunt", "portal", "mutr", "invade", "overdrive", "rainr", "seq"];
const CFG0 = () => ({ natOn: true, natMin: 60, natDur: 8, natW: { ouro: 3, eletrica: 2, meteoro: 2, nevoa: 2, inverno: 2, eclipse: 1, aurora: 1, caosd: 1 } });

function boot() {
// ---------- rede ----------
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "index.html"), (e, d) => {
    if (e) { res.writeHead(500); return res.end("index.html não encontrado ao lado do server.js"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 400000 });
const send = (c, o) => { if (c.readyState === 1) c.send(JSON.stringify(o)); };
const bc = o => { const s = JSON.stringify(o); wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); }); };
const clientsOf = u => [...wss.clients].filter(c => c.user === u);
const loginFails = {}, ipFails = {};
const ACT = new Map(); let SCHED = [];
const pub = ev => ({ id: ev.id, cid: ev.cid, k: ev.k, n: ev.n, p: ev.p, at: ev.at, end: ev.end, by: ev.by, nat: ev.nat || 0 });
const activeList = () => [...ACT.values()].map(pub);

function banned(a) { const b = a && a.ban; if (!b) return null; if (b.until && b.until <= Date.now()) { a.ban = null; return null; } return b; }
const banMsg = b => "Conta banida " + (b.until ? "até " + new Date(b.until).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "permanentemente") + ". Motivo: " + b.reason;
function newSession(u, ws) {
  const tok = crypto.randomBytes(24).toString("hex"), a = DB.users[u];
  if (a.active) delete SESS[a.active];
  SESS[tok] = u; a.active = tok; markU(u);
  wss.clients.forEach(c => { if (c !== ws && c.user === u) { send(c, { t: "kicked" }); c.user = null; } });
  ws.user = u; ws.tok = tok; return tok;
}
const ok = (ws, u, tok) => { const a = DB.users[u]; send(ws, { t: "authok", user: u, token: tok, save: a.save, titles: a.titles, title: a.title || "", pend: a.pend, now: Date.now() }); };
const err = (ws, msg) => send(ws, { t: "err", msg });
function grant(u, r, why) {
  const a = DB.users[u]; if (!a) return;
  const g = { id: rid(), r, why: why || "" };
  a.pend.push(g); if (a.pend.length > 60) a.pend.splice(0, a.pend.length - 60); markU(u);
  clientsOf(u).forEach(c => send(c, { t: "grant", g }));
}
function kickUser(u, msg) { clientsOf(u).forEach(c => { send(c, { t: "banned", msg }); c.user = null; }); const a = DB.users[u]; if (a && a.active) { delete SESS[a.active]; a.active = null; markU(u); } }

// ----- eventos -----
function cleanParams(c, p) {
  p = p && typeof p === "object" ? p : {}; const o = {};
  (c.p || []).forEach(d => {
    const v = p[d.f];
    if (d.ty === "n") o[d.f] = num(v == null ? d.def : v, d.min, d.max);
    else if (d.ty === "s") { const hit = d.o.find(x => String(x[0]) === String(v)); o[d.f] = hit ? hit[0] : d.def; }
    else o[d.f] = txt(v == null ? d.def : v, d.max) || d.def;
  });
  return Object.assign(o, c.fix || {});
}
function endEvent(id, why) { const ev = ACT.get(id); if (!ev) return false; ACT.delete(id); bc({ t: "evend", id, why: why || "fim" }); return true; }
function startEvent(cid, p, dur, by, opt) {
  opt = opt || {}; const c = CATI[cid];
  if (!c) return { ok: false, msg: "Comando desconhecido." };
  if (c.special === "supremo") return runPreset(p, opt.steps, by);
  if (c.special === "roleta") { const pick = ROLETA[(Math.random() * ROLETA.length) | 0]; bc({ t: "ban", msg: "Roleta do Admin escolheu: " + CATI[pick].n + "!" }); audit(by, "roleta", pick); return startEvent(pick, {}, 0, by + " (Roleta)"); }
  if (c.special === "purify") { let n = 0; for (const ev of [...ACT.values()]) if (CATI[ev.cid] && CATI[ev.cid].g === "mut") { endEvent(ev.id, "purificação"); n++; } }
  if (c.special === "revert") { for (const ev of [...ACT.values()]) if (CATI[ev.cid] && CATI[ev.cid].tag === "chaos") endEvent(ev.id, "reversão"); }
  const P = cleanParams(c, p);
  if (c.rnd === "m") P.m = M5[(Math.random() * M5.length) | 0][0];
  const d = c.dur ? num(dur || c.dur[0], c.dur[1], c.dur[2]) : 0;
  if (c.g) {
    for (const ev of [...ACT.values()]) {
      if (!CATI[ev.cid] || CATI[ev.cid].g !== c.g) continue;
      if (c.g === "lucky" && (ev.p.x || 0) > (P.x || 0)) return { ok: false, msg: "Já existe um Lucky maior ativo (x" + ev.p.x + "). Lucky não acumula: vale o maior." };
      endEvent(ev.id, "substituído");
    }
  }
  if (d && ACT.size >= 16) return { ok: false, msg: "Limite de 16 eventos ativos. Encerre algum antes." };
  const ev = { id: rid(), cid, k: c.k, n: c.n + (c.k === "weather" || c.k === "chaos" ? "" : ""), p: P, at: Date.now(), end: d ? Date.now() + d * 1000 : 0, by: txt(by, 30), nat: opt.nat ? 1 : 0 };
  if (d) ACT.set(ev.id, ev);
  bc({ t: "ev", ev: pub(ev), now: Date.now() });
  audit(by, opt.nat ? "evento natural" : "evento", c.n + " " + JSON.stringify(P) + (d ? " por " + d + "s" : ""));
  return { ok: true, ev: pub(ev) };
}
function runPreset(p, steps, by) {
  const name = p && p.preset || "classico";
  let list = name === "custom" ? steps : PRESETS[name];
  if (!Array.isArray(list) || !list.length) return { ok: false, msg: "Sequência vazia." };
  list = list.slice(0, 20).map(s => ({ at: num(s.at, 0, 1800), id: String(s.id), p: s.p || {}, dur: num(s.dur, 0, 3600) })).filter(s => CATI[s.id] && !CATI[s.id].special || s.id === "revert" || s.id === "purify" || s.id === "roleta");
  if (!list.length) return { ok: false, msg: "Nenhum passo válido." };
  bc({ t: "ban", msg: "ADMIN ABUSE SUPREMO começou!" });
  audit(by, "supremo", name + ": " + list.map(s => s.at + "s " + s.id).join(", "));
  list.forEach(s => { const h = setTimeout(() => { SCHED = SCHED.filter(x => x !== h); startEvent(s.id, s.p, s.dur, by + " (Supremo)"); }, s.at * 1000); SCHED.push(h); });
  return { ok: true, ev: { n: "Admin Abuse Supremo", steps: list.length } };
}
function stopAll(by) { SCHED.forEach(clearTimeout); SCHED = []; const n = ACT.size; ACT.clear(); bc({ t: "stopall", by: txt(by, 24) }); audit(by, "parada de emergência", n + " evento(s) encerrado(s)"); }
setInterval(() => { const now = Date.now(); for (const ev of [...ACT.values()]) if (ev.end && ev.end <= now) endEvent(ev.id, "tempo"); }, 1000);
// eventos naturais (clima a cada X minutos, para todos)
setInterval(() => {
  const cf = DB.cfg, now = Date.now();
  if (!cf.natOn) return;
  if (!DB.nat) { DB.nat = now + cf.natMin * 60000; markM(); return; }
  if (now < DB.nat) return;
  DB.nat = now + cf.natMin * 60000; markM();
  if ([...ACT.values()].some(e => CATI[e.cid] && CATI[e.cid].g === "weather")) return; // admin já tem um clima ligado
  const ws_ = W8.map(w => [w[0], Math.max(0, +cf.natW[w[0]] || 0)]), tot = ws_.reduce((a, b) => a + b[1], 0);
  if (!tot) return; let x = Math.random() * tot, w = "ouro";
  for (const [k, v] of ws_) { x -= v; if (x < 0) { w = k; break; } }
  startEvent("clima", { w, i: 1 + ((Math.random() * 3) | 0) }, cf.natDur * 60, "Natureza", { nat: true });
}, 15000);

// ----- ranking -----
let TOPC = { at: 0, rng: [], coins: [] };
function computeTop() {
  const rows = [];
  for (const [name, a] of Object.entries(DB.users)) {
    if (!a.save || banned(a)) continue; const s = a.save;
    const got = Object.values(s.own || {}).filter(v => v > 0).length, earned = (s.st && s.st.earned) || 0;
    if (!Number.isFinite(earned) || !Number.isFinite(got)) continue;
    rows.push({ name, title: a.title || "", got, best: s.best | 0, rolls: s.rolls || 0, earned, coins: s.coins || 0 });
  }
  const rank = (arr, key) => { let pos = 0, prev = null; return arr.slice(0, 50).map((r, i) => { const k = key(r); if (k !== prev) { pos = i + 1; prev = k; } return Object.assign({ pos }, r); }); };
  TOPC = {
    at: Date.now(),
    rng: rank(rows.slice().sort((a, b) => b.got - a.got || b.best - a.best || a.rolls - b.rolls || a.name.localeCompare(b.name)), r => r.got + ":" + r.best),
    coins: rank(rows.slice().sort((a, b) => b.earned - a.earned || a.name.localeCompare(b.name)), r => String(r.earned))
  };
}
setInterval(() => { computeTop(); bc({ t: "top", ...TOPC, online: [...wss.clients].filter(c => c.user).length }); }, 10000);
computeTop();

function profileOf(u, full) {
  const a = DB.users[u]; if (!a) return null; const s = a.save || {};
  const p = { name: u, title: a.title || "", titles: a.titles, best: s.best | 0, got: Object.values(s.own || {}).filter(v => v > 0).length, rolls: s.rolls || 0,
    earned: (s.st && s.st.earned) || 0, steals: (s.st && s.st.steals) || 0, rb: s.rb || 0, pr: s.pr || 0, stars: s.stars || 0, aeq: s.aeq || "",
    auras: Object.values(s.au || {}).filter(v => v > 0).length, muts: Object.values(s.mu || {}).filter(v => v > 0).length, created: a.created, seen: a.seen || 0,
    online: clientsOf(u).length > 0, sk: s.sk || {} };
  if (full) Object.assign(p, { coins: s.coins || 0, ban: banned(a), red: a.red, pend: a.pend.length });
  return p;
}

wss.on("connection", (ws, req) => {
  ws.abuse = false; ws.staff = false; ws.user = null; ws.msgs = 0; ws.who = "admin"; ws.rf = 0;
  ws.ip = String((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?");
  send(ws, { t: "hello", now: Date.now(), active: activeList(), ver: 2 });
  ws.on("message", raw => {
    if (++ws.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const t = m.t, A = ws.user ? DB.users[ws.user] : null;
    // ----- conta -----
    if (t === "register") {
      const u = clean(m.user), p = String(m.pass || "");
      if (u.length < 3) return err(ws, "Usuário precisa ter 3 a 16 letras, números ou _.");
      if (p.length < 6 || p.length > 64) return err(ws, "A senha precisa ter de 6 a 64 caracteres.");
      if (DB.users[u]) return err(ws, "Esse usuário já existe.");
      const salt = crypto.randomBytes(16).toString("hex");
      DB.users[u] = { salt, hash: hash(p, salt), created: Date.now(), save: null, active: null, titles: [], title: "", red: {}, pend: [] }; markU(u);
      ok(ws, u, newSession(u, ws));
    } else if (t === "login") {
      const u = clean(m.user), p = String(m.pass || ""), f = loginFails[u] || (loginFails[u] = { n: 0, until: 0 });
      if (f.until > Date.now()) return err(ws, "Muitas tentativas. Espere 30 segundos.");
      const a = DB.users[u];
      if (!a || !same(hash(p, a.salt), a.hash)) { if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 30000; } return err(ws, "Usuário ou senha incorretos."); }
      f.n = 0; const b = banned(a); if (b) return send(ws, { t: "banned", msg: banMsg(b) });
      ok(ws, u, newSession(u, ws));
    } else if (t === "resume") {
      const u = SESS[String(m.token)], a = u && DB.users[u];
      if (!a || a.active !== m.token) return send(ws, { t: "authfail" });
      const b = banned(a); if (b) return send(ws, { t: "banned", msg: banMsg(b) });
      ws.user = u; ws.tok = m.token; ok(ws, u, m.token);
    } else if (t === "logout") {
      if (A && A.active === ws.tok) { delete SESS[ws.tok]; A.active = null; markU(ws.user); }
      ws.user = null; send(ws, { t: "loggedout" });
    } else if (t === "save") {
      if (!A) return;
      if (A.active !== ws.tok) { send(ws, { t: "kicked" }); ws.user = null; return; }
      const sv = sanitize(m.save); if (!sv) return;
      const old = A.save;
      if (old && !m.reset) {
        if ((sv.rev || 0) < (old.rev || 0)) return send(ws, { t: "saverej", why: "stale", rev: old.rev || 0 });
        if ((sv.rolls || 0) < (old.rolls || 0)) return send(ws, { t: "saverej", why: "regress" });
      }
      if (m.reset) audit(ws.user, "reset de progresso", "rolagens " + ((old && old.rolls) || 0) + " -> " + sv.rolls);
      A.save = sv; A.seen = Date.now(); markU(ws.user); send(ws, { t: "saved", rev: sv.rev });
    } else if (t === "ack") {
      if (!A) return; const i = A.pend.findIndex(g => g.id === m.id); if (i >= 0) { A.pend.splice(i, 1); markU(ws.user); }
    } else if (t === "redeem") {
      if (!A) return send(ws, { t: "redeem", ok: false, msg: "Entre na sua conta para resgatar códigos." });
      if (ws.rf > 8) return send(ws, { t: "redeem", ok: false, msg: "Muitas tentativas. Espere um pouco." });
      const raw = String(m.code || "").slice(0, 64), key = ckey(raw);
      let id = DB.codes[key] && !DB.codes[key].hash ? key : null;
      if (!id) { const h = LH(lnorm(raw)); id = Object.keys(DB.codes).find(k => DB.codes[k].hash === h) || null; }
      if (!id) { ws.rf++; setTimeout(() => ws.rf--, 60000); return send(ws, { t: "redeem", ok: false, msg: "Código inválido." }); }
      const c = DB.codes[id];
      if (c.rev) return send(ws, { t: "redeem", ok: false, msg: "Este código foi desativado." });
      if (c.exp && Date.now() > c.exp) return send(ws, { t: "redeem", ok: false, msg: "Este código expirou." });
      if ((A.red[id] | 0) >= (c.per || 1)) return send(ws, { t: "redeem", ok: false, msg: "Você já resgatou este código." });
      if (c.max && (c.uses | 0) >= c.max) return send(ws, { t: "redeem", ok: false, msg: "Este código esgotou." });
      A.red[id] = (A.red[id] | 0) + 1; c.uses = (c.uses | 0) + 1; markU(ws.user); markM();
      audit(ws.user, "resgate de código", c.label || id);
      if (c.r.t === "title") { if (!A.titles.includes(c.r.v)) A.titles.push(c.r.v); send(ws, { t: "titles", titles: A.titles, title: A.title || "" }); }
      else grant(ws.user, c.r, "código");
      send(ws, { t: "redeem", ok: true, key: c.hash ? id : "", msg: "Código aceito! " + rdesc(c.r) });
    } else if (t === "settitle") {
      if (!A) return; const ti = String(m.title || "");
      if (ti && !A.titles.includes(ti)) return err(ws, "Você não tem esse título.");
      A.title = ti; markU(ws.user); send(ws, { t: "titles", titles: A.titles, title: A.title });
    } else if (t === "profile") {
      const p = profileOf(clean(m.user), false); send(ws, { t: "profile", p });
    } else if (t === "top") { send(ws, { t: "top", ...TOPC, online: [...wss.clients].filter(c => c.user).length });
    // ----- autenticação dos painéis (senhas só no servidor) -----
    } else if (t === "auth2" || t === "auth") {
      const panel = t === "auth" ? "abuse" : m.panel === "staff" ? "staff" : "abuse", f = ipFails[ws.ip] || (ipFails[ws.ip] = { n: 0, until: 0 });
      if (f.until > Date.now()) return send(ws, { t: "auth2", panel, ok: false, msg: "Muitas tentativas. Espere 1 minuto." });
      const secret = panel === "staff" ? STAFF : ABUSE;
      if (!secret && !PANEL_CODE) return send(ws, { t: "auth2", panel, ok: false, msg: panel === "staff" ? "Este painel está desligado no servidor (falta ADMIN_STAFF_TOKEN ou ADMIN_PANEL_CODE)." : "Este painel está desligado no servidor (falta ADMIN_ABUSE_TOKEN ou ADMIN_PANEL_CODE)." });
      // Mantém as senhas existentes e aceita ADMIN_PANEL_CODE como chave alternativa para ambos os painéis.
      // Ignora espaços nas pontas e maiúsculas/minúsculas (teclados de celular costumam capitalizar a 1ª letra).
      const nz = s => String(s || "").trim().toLowerCase();
      const supplied = nz(m.token);
      const good = (secret && sameSecret(supplied, nz(secret))) || (PANEL_CODE && sameSecret(supplied, nz(PANEL_CODE)));
      if (!good) { if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; } audit(txt(m.who, 20) || "?", "senha de painel incorreta", panel + " ip " + ws.ip); console.log("[auth] painel", panel, "recusado: recebeu", supplied.length, "caracteres, esperado", nz(secret).length); return send(ws, { t: "auth2", panel, ok: false, msg: "Senha incorreta. (servidor " + BUILD + ", recebeu " + supplied.length + " caracteres)" }); }
      f.n = 0; ws.who = txt(m.who, 20) || "admin";
      if (panel === "staff") ws.staff = true; else ws.abuse = true;
      audit(ws.who, "entrou no painel", panel === "staff" ? "Administração Pessoal" : "Admin Abuse");
      send(ws, { t: "auth2", panel, ok: true, cat: panel === "abuse" ? CAT : undefined, presets: panel === "abuse" ? Object.keys(PRESETS) : undefined, active: activeList(), cfg: panel === "staff" ? DB.cfg : undefined, nat: DB.nat });
      if (t === "auth") send(ws, { t: "auth", ok: true });
    // ----- Admin Abuse -----
    } else if (ws.abuse && t === "cmd") {
      const r = startEvent(String(m.id), m.p, m.dur, ws.who, { steps: m.steps });
      send(ws, { t: "cmdres", ok: r.ok, msg: r.ok ? "Executado: " + (r.ev.n || m.id) : r.msg });
    } else if (ws.abuse && t === "stop") { const ok_ = endEvent(String(m.id), "encerrado pelo admin"); if (ok_) audit(ws.who, "encerrou evento", m.id); send(ws, { t: "cmdres", ok: ok_, msg: ok_ ? "Evento encerrado." : "Evento não encontrado." });
    } else if (ws.abuse && t === "stopall") { stopAll(ws.who); send(ws, { t: "cmdres", ok: true, msg: "Parada de emergência executada." });
    } else if ((ws.abuse || ws.staff) && t === "log") {
      const q = txt(m.q, 40).toLowerCase(), onlyEv = !!m.ev;
      const list = DB.audit.filter(x => (!onlyEv || /evento|supremo|roleta|parada|encerrou/.test(x.act)) && (!q || (x.who + x.act + x.info).toLowerCase().includes(q))).slice(-200).reverse();
      send(ws, { t: "log", list });
    } else if (ws.abuse && t === "event" && m.ev) { // compatibilidade com o painel antigo
      const map = { msg: "msg", coins: "coins", mult: "mult", luck: "luckx", tayer: "tayer", sleep: "sleep", drop: "drop", brainrot: "brainrot" }, id = map[m.ev.k];
      if (id) startEvent(id, m.ev, m.ev.sec, ws.who);
    // ----- Administração Pessoal -----
    } else if (ws.staff && t === "users") {
      const q = clean(m.q), page = Math.max(0, m.page | 0);
      const all = Object.entries(DB.users).filter(([n, a]) => (!q || n.includes(q)) && (!m.banned || banned(a))).sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0));
      send(ws, { t: "s_users", total: all.length, page, pages: Math.ceil(all.length / 20), list: all.slice(page * 20, page * 20 + 20).map(([name, a]) => ({ name, coins: a.save ? a.save.coins || 0 : 0, online: clientsOf(name).length > 0, banned: !!banned(a), title: a.title || "", seen: a.seen || 0 })) });
    } else if (ws.staff && t === "uprofile") {
      send(ws, { t: "s_profile", p: profileOf(clean(m.user), true) });
    } else if (ws.staff && t === "ban") {
      const u = clean(m.user), a = DB.users[u], reason = txt(m.reason, 140), mins = num(m.mins, 0, 5256000);
      if (!a) return err(ws, "Conta não existe.");
      if (reason.length < 3) return err(ws, "Escreva o motivo do banimento.");
      a.ban = { until: mins ? Date.now() + mins * 60000 : 0, reason, by: ws.who, at: Date.now() }; markU(u);
      audit(ws.who, "baniu", u + (mins ? " por " + mins + " min" : " permanentemente") + ": " + reason);
      kickUser(u, banMsg(a.ban)); send(ws, { t: "ban", msg: "Conta " + u + " banida." }); send(ws, { t: "s_profile", p: profileOf(u, true) });
    } else if (ws.staff && t === "unban") {
      const u = clean(m.user), a = DB.users[u]; if (!a) return err(ws, "Conta não existe.");
      a.ban = null; markU(u); audit(ws.who, "desbaniu", u); send(ws, { t: "ban", msg: "Conta " + u + " desbanida." }); send(ws, { t: "s_profile", p: profileOf(u, true) });
    } else if (ws.staff && t === "kick") {
      const u = clean(m.user); clientsOf(u).forEach(c => { send(c, { t: "kicked" }); c.user = null; }); audit(ws.who, "expulsou", u); send(ws, { t: "ban", msg: u + " foi desconectado." });
    } else if (ws.staff && t === "title") {
      const u = clean(m.user), a = DB.users[u], ti = txt(m.title, 24);
      if (!a || !ti) return err(ws, "Conta ou título inválido.");
      if (m.op === "rm") { a.titles = a.titles.filter(x => x !== ti); if (a.title === ti) a.title = ""; }
      else if (!a.titles.includes(ti)) { if (a.titles.length >= 20) return err(ws, "Limite de 20 títulos."); a.titles.push(ti); }
      markU(u); audit(ws.who, m.op === "rm" ? "removeu título" : "deu título", u + ": " + ti);
      clientsOf(u).forEach(c => send(c, { t: "titles", titles: a.titles, title: a.title || "" })); send(ws, { t: "s_profile", p: profileOf(u, true) });
    } else if (ws.staff && t === "give") {
      const u = clean(m.user), n = num(m.n, 0, 1e15); if (!DB.users[u]) return err(ws, "Conta não existe.");
      grant(u, { t: "coins", v: n }, "admin"); audit(ws.who, "deu coins", u + ": " + n); send(ws, { t: "ban", msg: "Enviado " + n + " coins para " + u + " (entrega garantida, mesmo offline)." });
    } else if (ws.staff && t === "codes") {
      send(ws, { t: "s_codes", list: Object.entries(DB.codes).map(([k, c]) => ({ code: c.hash ? (c.label || k) : k, key: k, r: c.r, desc: rdesc(c.r), max: c.max, per: c.per, exp: c.exp, rev: c.rev, uses: c.uses, by: c.by, at: c.at, legacy: !!c.hash })) });
    } else if (ws.staff && t === "code_new") {
      const k = ckey(m.code), rt = String(m.rt), rv = rt === "coins" || rt === "tayer" ? num(m.rv, 1, rt === "tayer" ? 10 : 1e15) : txt(m.rv, 40);
      if (!/^[A-Z0-9-]{4,32}$/.test(k)) return err(ws, "Código: 4 a 32 letras, números ou hífen.");
      if (DB.codes[k]) return err(ws, "Esse código já existe.");
      if (!RT[rt] || (rt !== "lucky" && !rv)) return err(ws, "Recompensa inválida.");
      const days = num(m.days, 0, 3650);
      DB.codes[k] = { r: { t: rt, v: rv }, max: num(m.max, 0, 1e9) | 0, per: Math.max(1, num(m.per, 1, 100) | 0), exp: days ? Date.now() + days * 86400000 : 0, rev: false, uses: 0, at: Date.now(), by: ws.who };
      markM(); audit(ws.who, "criou código", k + " -> " + rdesc(DB.codes[k].r)); send(ws, { t: "ban", msg: "Código " + k + " criado." });
    } else if (ws.staff && t === "code_rev") {
      const k = String(m.key), c = DB.codes[k]; if (!c) return err(ws, "Código não existe.");
      c.rev = !m.on; markM(); audit(ws.who, c.rev ? "revogou código" : "reativou código", c.label || k); send(ws, { t: "ban", msg: (c.rev ? "Revogado: " : "Reativado: ") + (c.label || k) });
    } else if (ws.staff && t === "cfg") {
      if (m.set) {
        const c = DB.cfg, s = m.set;
        c.natOn = !!s.natOn; c.natMin = num(s.natMin, 10, 1440); c.natDur = num(s.natDur, 1, 60);
        if (s.natW) W8.forEach(([k]) => c.natW[k] = num(s.natW[k], 0, 10));
        DB.nat = Date.now() + c.natMin * 60000; markM(); audit(ws.who, "mudou configurações", JSON.stringify(c));
      }
      send(ws, { t: "s_cfg", cfg: DB.cfg, nat: DB.nat });
    } else if (ws.staff && t === "natnow") {
      DB.nat = Date.now() - 1; markM(); send(ws, { t: "ban", msg: "O próximo evento natural começa em até 15 segundos." });
    }
  });
});
setInterval(() => wss.clients.forEach(c => c.msgs = 0), 1000);
server.listen(PORT, "0.0.0.0", () => {
  console.log("\nSERVIDOR LIGADO. Não feche esta janela.");
  console.log("No seu PC:        http://localhost:" + PORT);
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === "IPv4" && !i.internal)
    .forEach(i => console.log("Mesma rede Wi-Fi: http://" + i.address + ":" + PORT));
});
}
loadDB().then(boot);
