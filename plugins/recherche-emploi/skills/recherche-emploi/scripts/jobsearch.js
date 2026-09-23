#!/usr/bin/env node
// jobsearch.js : base SQLite + CLI + dashboard local. Aucune dependance npm (Node >= 22.13).
'use strict';
const VERSION = '2.10.0';
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (String(w).includes('SQLite')) return; _emit.call(process, w, ...a); };
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const ROOT = __dirname;
const CV_DIR = path.join(ROOT, 'cv');
const DATA_DIR = path.join(ROOT, 'data');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DB_PATH = path.join(DATA_DIR, 'jobsearch.db');

const SCHEMA_VERSION = 9;
const RECOS = ['postuler', 'a_etudier', 'ne_pas_postuler'];
const KANBAN = ['a_postuler', 'postulee', 'entretien', 'refus', 'accepte'];
const APPLIED = ['postulee', 'entretien', 'refus', 'accepte'];
const STATUSES = KANBAN.concat(['ecartee']);
const STATUS_ALIAS = { nouvelle: 'a_postuler' };
const SITES = ['hellowork', 'indeed', 'les_deux'];
// Types de contrat proposes a la recherche. 'tous' = pas de filtre, et c'est
// le defaut : mieux vaut ne rien filtrer que filtrer a l'envers.
const CONTRATS = ['tous', 'cdi', 'cdd', 'alternance', 'stage', 'interim', 'temps_partiel'];
// Actions declenchables par un bouton du dashboard. Le watcher les emet sur
// stdout, l'outil Monitor de Claude Code transforme chaque ligne en notification.
const ACTIONS = ['check-deps', 'scan-cv', 'analyze-cv', 'audit-cv', 'new-search', 'letter', 'letters-missing', 'message', 'answer'];
const VENDOR_FILES = { 'pdf.min.mjs': 'text/javascript', 'pdf.worker.min.mjs': 'text/javascript' };
const WATCHER_TTL_MS = 15000;   // au-dela, le dashboard considere que Claude n'ecoute plus
// Dependances que seul Claude peut verifier : elles restent grises tant qu'il
// n'a pas repondu via set-dep. Les autres sont calculees par le serveur.
const CLAUDE_DEPS = {
  playwright: 'Playwright MCP (navigateur)',
  hellowork: 'HelloWork accessible',
  indeed: 'Indeed accessible',
};
// Skills dont depend le parcours. Le serveur les voit sur le disque, donc ces
// cases sont vertes ou rouges tout de suite, sans attendre une reponse de Claude.
const SKILL_DEPS = {
  humanizer: { label: 'Skill humanizer (lettres)', dirs: ['humanizer', 'avoid-ai-writing'] },
  audit_ats: { label: 'Skill audit-cv-ats (audit)', dirs: ['audit-cv-ats'] },
};
const SITE_HOSTS = { hellowork: 'hellowork', indeed: 'indeed' };

// --- sortie / erreurs -------------------------------------------------------
const now = () => new Date().toISOString();
const out = (o) => console.log(JSON.stringify(o, null, 2));
function fail(msg) { console.error(JSON.stringify({ ok: false, error: msg })); process.exit(1); }

// `version` doit repondre meme si node:sqlite manque ou si la migration casse.
if (process.argv[2] === 'version') {
  out({ ok: true, version: VERSION, schema_version: SCHEMA_VERSION, node: process.version, root: ROOT });
  process.exit(0);
}

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { fail('node:sqlite indisponible : installe Node >= 22.13 (actuel ' + process.version + ')'); }

// --- schema -----------------------------------------------------------------
// Utilise tel quel sur une base neuve ; sur une base existante les MIGRATIONS
// font le travail et ce bloc ne cree que ce qui manque encore.
// offers.status garde DEFAULT 'nouvelle' : changer un defaut imposerait un rebuild
// complet de offers (cible du ON DELETE CASCADE de letters). add-offer fournit
// toujours status explicitement, ce defaut n'est donc jamais utilise.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cv (
  id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, raw_text TEXT,
  profile_json TEXT NOT NULL, file_mtime TEXT, is_active INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_active ON cv(is_active) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, location TEXT NOT NULL, site TEXT NOT NULL,
  target_count INTEGER, offers_seen INTEGER DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT, notes TEXT,
  cv_id INTEGER REFERENCES cv(id) ON DELETE SET NULL, stats_json TEXT, max_seen INTEGER,
  contract_wanted TEXT);                 -- voir migration 9
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER REFERENCES searches(id), site TEXT, url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, company TEXT, location TEXT, contract TEXT, salary TEXT, remote TEXT, posted_at TEXT,
  description TEXT, match_score INTEGER NOT NULL, strengths TEXT, gaps TEXT,
  recommendation TEXT NOT NULL, advice TEXT, status TEXT NOT NULL DEFAULT 'nouvelle', found_at TEXT NOT NULL,
  cv_id INTEGER REFERENCES cv(id) ON DELETE SET NULL,
  status_updated_at TEXT, applied_at TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, payload_json TEXT, label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, taken_at TEXT, done_at TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS cv_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cv_id INTEGER REFERENCES cv(id) ON DELETE CASCADE, filename TEXT NOT NULL,
  offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
  score REAL NOT NULL, items_json TEXT, blockers_json TEXT,
  keywords_total INTEGER, keywords_present INTEGER,
  report_path TEXT, summary TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_search ON offers(search_id);
CREATE INDEX IF NOT EXISTS idx_offers_cv     ON offers(cv_id);
CREATE INDEX IF NOT EXISTS idx_letters_offer ON letters(offer_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,                -- user | claude
  content TEXT NOT NULL,
  action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  session_id TEXT);                  -- conversation en cours, voir migration 8
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_cv_audits_cv ON cv_audits(cv_id);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL, options_json TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0, allow_text INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | answered | cancelled
  answer_json TEXT, message_id INTEGER, action_id INTEGER,
  created_at TEXT NOT NULL, answered_at TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
`;

// --- migrations -------------------------------------------------------------
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasCol = (db, t, c) => db.prepare('PRAGMA table_info(' + t + ')').all().some((r) => r.name === c);
const addCol = (db, t, c, ddl) => { if (hasTable(db, t) && !hasCol(db, t, c)) db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + ddl); };

const MIGRATIONS = [
  { v: 1, name: 'cv multi-lignes', up(db) {
    if (!hasTable(db, 'cv') || hasCol(db, 'cv', 'is_active')) return;
    const before = db.prepare('SELECT COUNT(*) n FROM cv').get().n;
    db.exec(`
      CREATE TABLE cv_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, raw_text TEXT,
        profile_json TEXT NOT NULL, file_mtime TEXT, is_active INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO cv_new (id, filename, raw_text, profile_json, file_mtime, is_active, imported_at, updated_at)
        SELECT id, filename, raw_text, profile_json, NULL,
               CASE WHEN id = (SELECT MIN(id) FROM cv) THEN 1 ELSE 0 END,
               updated_at, updated_at FROM cv;
      DROP TABLE cv;
      ALTER TABLE cv_new RENAME TO cv;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_active ON cv(is_active) WHERE is_active = 1;
    `);
    const after = db.prepare('SELECT COUNT(*) n FROM cv').get().n;
    if (after !== before) throw new Error('perte de lignes cv : ' + before + ' -> ' + after);
  } },
  { v: 2, name: 'colonnes cv_id / suivi / plafond', up(db) {
    addCol(db, 'offers', 'cv_id', 'cv_id INTEGER REFERENCES cv(id) ON DELETE SET NULL');
    addCol(db, 'offers', 'status_updated_at', 'status_updated_at TEXT');
    addCol(db, 'offers', 'applied_at', 'applied_at TEXT');
    addCol(db, 'offers', 'notes', 'notes TEXT');
    addCol(db, 'searches', 'cv_id', 'cv_id INTEGER REFERENCES cv(id) ON DELETE SET NULL');
    addCol(db, 'searches', 'stats_json', 'stats_json TEXT');
    addCol(db, 'searches', 'max_seen', 'max_seen INTEGER');
    db.exec(`
      UPDATE offers   SET cv_id = (SELECT id FROM cv WHERE is_active = 1) WHERE cv_id IS NULL;
      UPDATE searches SET cv_id = (SELECT id FROM cv WHERE is_active = 1) WHERE cv_id IS NULL;
      UPDATE offers   SET status_updated_at = found_at WHERE status_updated_at IS NULL;
      -- reprend la regle implicite "4x l'objectif", sans jamais placer le plafond
      -- sous le nombre d'annonces deja lues : une recherche passee ne doit pas
      -- s'afficher comme ayant bute sur une limite qui n'existait pas encore.
      UPDATE searches SET max_seen = MAX(COALESCE(target_count * 4, 40), COALESCE(offers_seen, 0))
        WHERE max_seen IS NULL;
    `);
  } },
  { v: 3, name: 'statuts kanban', up(db) {
    db.exec(`
      UPDATE offers SET status = 'a_postuler', status_updated_at = COALESCE(status_updated_at, found_at)
        WHERE status = 'nouvelle' OR status IS NULL OR status = '';
      UPDATE offers SET applied_at = COALESCE(applied_at, status_updated_at, found_at)
        WHERE status IN ('postulee','entretien','refus','accepte') AND applied_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
      CREATE INDEX IF NOT EXISTS idx_offers_search ON offers(search_id);
      CREATE INDEX IF NOT EXISTS idx_offers_cv     ON offers(cv_id);
      CREATE INDEX IF NOT EXISTS idx_letters_offer ON letters(offer_id);
    `);
    const bad = db.prepare('SELECT COUNT(*) n FROM offers WHERE status NOT IN (' +
      STATUSES.map(() => '?').join(',') + ')').get(...STATUSES).n;
    if (bad) throw new Error(bad + ' offre(s) avec un statut inconnu');
  } },
  { v: 4, name: 'file d\'actions du dashboard', up(db) {
    // Deux tables neuves, aucune table existante touchee.
    db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, payload_json TEXT, label TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, taken_at TEXT, done_at TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
    `);
  } },
  { v: 5, name: 'audits ATS des CV', up(db) {
    // Table neuve, aucune table existante touchee.
    db.exec(`
      CREATE TABLE IF NOT EXISTS cv_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cv_id INTEGER REFERENCES cv(id) ON DELETE CASCADE, filename TEXT NOT NULL,
        offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
        score REAL NOT NULL, items_json TEXT, blockers_json TEXT,
        keywords_total INTEGER, keywords_present INTEGER,
        report_path TEXT, summary TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_cv_audits_cv ON cv_audits(cv_id);
    `);
  } },
  { v: 6, name: 'messages du chat', up(db) {
    // Table neuve, aucune table existante touchee.
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
    `);
  } },
  { v: 7, name: 'questions cliquables du chat', up(db) {
    // Table neuve, aucune table existante touchee.
    db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL, options_json TEXT NOT NULL,
        multi INTEGER NOT NULL DEFAULT 0, allow_text INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        answer_json TEXT, message_id INTEGER, action_id INTEGER,
        created_at TEXT NOT NULL, answered_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
    `);
  } },
  { v: 8, name: 'chat par session', up(db) {
    // Une colonne neuve, les lignes existantes sont rattachees a une session
    // close : le chat repart vide a la prochaine session sans rien perdre.
    const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!cols.includes('session_id')) db.exec('ALTER TABLE messages ADD COLUMN session_id TEXT');
    db.prepare("UPDATE messages SET session_id = 'sessions-precedentes' WHERE session_id IS NULL").run();
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)');
  } },
  { v: 9, name: 'type de contrat recherche', up(db) {
    // Une colonne neuve, laissee a NULL sur les recherches passees : elles ont
    // ete menees sans filtre de contrat, autant que ca se voie.
    const cols = db.prepare('PRAGMA table_info(searches)').all().map((c) => c.name);
    if (!cols.includes('contract_wanted')) db.exec('ALTER TABLE searches ADD COLUMN contract_wanted TEXT');
  } },
];

let LAST_BACKUP = null;
function backupDb(db, fromVersion) {
  if (!fs.existsSync(DB_PATH)) return null;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // sans ca le contenu du -wal n'est pas dans la copie
  const dst = path.join(DATA_DIR, 'jobsearch.backup-v' + fromVersion + '-' + now().replace(/[:.]/g, '-') + '.db');
  fs.copyFileSync(DB_PATH, dst);
  LAST_BACKUP = dst;
  return dst;
}

function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  if (v >= SCHEMA_VERSION) return v;
  const from = v;
  backupDb(db, v);
  for (const m of MIGRATIONS) {
    if (m.v <= v) continue;
    db.exec('BEGIN IMMEDIATE;');
    try { m.up(db); db.exec('PRAGMA user_version = ' + m.v + '; COMMIT;'); }
    catch (e) { try { db.exec('ROLLBACK;'); } catch {} fail('Migration v' + m.v + ' (' + m.name + ') : ' + e.message + (LAST_BACKUP ? ' | sauvegarde : ' + LAST_BACKUP : '')); }
    v = m.v;
  }
  const fkc = db.prepare('PRAGMA foreign_key_check').all();
  if (fkc.length) fail('Integrite FK cassee apres migration : ' + JSON.stringify(fkc.slice(0, 3)));
  process.stderr.write(JSON.stringify({ migrated: from + ' -> ' + v, backup: LAST_BACKUP }) + '\n');
  return v;
}

function openDb() {
  fs.mkdirSync(CV_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  // foreign_keys reste OFF pendant toute la fenetre de migration : le PRAGMA est
  // un no-op dans une transaction, on ne l'active donc qu'une fois tout applique.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const fresh = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='offers'").get().n === 0;
  if (fresh) {
    db.exec(SCHEMA);
    db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
  } else {
    migrate(db);
    db.exec(SCHEMA);
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// --- utilitaires ------------------------------------------------------------
function input(args) {
  const i = args.indexOf('--file');
  let raw;
  try { raw = i >= 0 ? fs.readFileSync(args[i + 1], 'utf8') : fs.readFileSync(0, 'utf8'); }
  catch (e) { fail('Lecture impossible : ' + e.message); }
  try { return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch (e) { fail('JSON invalide : ' + e.message); }
}
function arg(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function normalizeUrl(u) {
  let p;
  try { p = new URL(u); } catch { fail('URL invalide : ' + u); }
  if (!/^https?:$/.test(p.protocol)) fail('URL non http(s) : ' + u);
  if (p.hostname.includes('indeed.') && p.searchParams.get('jk')) return p.origin + '/viewjob?jk=' + p.searchParams.get('jk');
  return p.origin + p.pathname.replace(/\/$/, '');
}
const listText = (v) => Array.isArray(v) ? v.join('\n') : (v == null ? null : String(v));
const cvFiles = () => fs.existsSync(CV_DIR) ? fs.readdirSync(CV_DIR).filter((f) => /\.pdf$/i.test(f)).sort() : [];
const mtimeOf = (name) => { try { return fs.statSync(path.join(CV_DIR, name)).mtime.toISOString(); } catch { return null; } };

function findCv(db, ref) {
  if (ref === undefined || ref === null || ref === '') return db.prepare('SELECT * FROM cv WHERE is_active = 1').get() || null;
  const n = Number(ref);
  if (Number.isInteger(n) && String(n) === String(ref).trim()) return db.prepare('SELECT * FROM cv WHERE id = ?').get(n) || null;
  return db.prepare('SELECT * FROM cv WHERE filename = ?').get(String(ref)) || null;
}
function setActive(db, id) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE cv SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('UPDATE cv SET is_active = 1 WHERE id = ?').run(id);
    db.exec('COMMIT;');
  } catch (e) { try { db.exec('ROLLBACK;'); } catch {} throw e; }
}
function applyStatus(db, id, status) {
  const s = STATUS_ALIAS[status] || status;
  if (!STATUSES.includes(s)) return { error: 'Statut attendu : ' + STATUSES.join(' | ') };
  const o = db.prepare('SELECT id, status, applied_at FROM offers WHERE id = ?').get(Number(id));
  if (!o) return { error: 'Offre introuvable : ' + id };
  const t = now();
  const applied = (APPLIED.includes(s) && !o.applied_at) ? t : (o.applied_at || null);
  db.prepare('UPDATE offers SET status = ?, status_updated_at = ?, applied_at = ? WHERE id = ?').run(s, t, applied, o.id);
  return { id: o.id, status: s, status_updated_at: t, applied_at: applied };
}
const setSetting = (db, k, v) => db.prepare(
  'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
).run(k, String(v), now());
const getSetting = (db, k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
const watcherAlive = (db) => {
  const t = getSetting(db, 'watcher_seen_at');
  return !!t && (Date.now() - Date.parse(t)) < WATCHER_TTL_MS;
};
const parseAudit = (r) => {
  if (!r) return null;
  const j = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const { items_json, blockers_json, ...rest } = r;
  return { ...rest, items: j(items_json), blockers: j(blockers_json) };
};
function queueAction(db, type, payload, label) {
  if (!ACTIONS.includes(type)) return { error: 'type doit valoir : ' + ACTIONS.join(' | ') };
  const r = db.prepare('INSERT INTO actions (type, payload_json, label, status, created_at) VALUES (?, ?, ?, \'pending\', ?)')
    .run(type, payload == null ? null : JSON.stringify(payload), label || null, now());
  return { action_id: Number(r.lastInsertRowid) };
}
// Playwright MCP est configure avec --browser chrome : sans Chrome installe,
// le serveur MCP ne demarre pas du tout.
function chromeInfo() {
  const plat = process.platform;
  let dirs = [], exe = 'chrome';
  if (plat === 'win32') {
    exe = 'chrome.exe';
    dirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map((b) => path.join(b, 'Google', 'Chrome', 'Application'));
  } else if (plat === 'darwin') {
    exe = 'Google Chrome';
    dirs = ['/Applications/Google Chrome.app/Contents/MacOS'];
  } else {
    dirs = ['/opt/google/chrome', '/usr/bin', '/usr/local/bin'];
  }
  for (const dir of dirs) {
    for (const name of plat === 'linux' ? ['google-chrome', 'google-chrome-stable', 'chrome', 'chromium'] : [exe]) {
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) continue;
      let version = null;
      // le dossier d'installation contient un sous-dossier nomme par la version
      try { version = fs.readdirSync(dir).filter((f) => /^\d+\.\d+\.\d+\.\d+$/.test(f)).sort().pop() || null; } catch {}
      return { found: true, path: full, version };
    }
  }
  return { found: false };
}

// Recense les SKILL.md installes. Trois dispositions coexistent et il faut les
// couvrir toutes : le dossier personnel, un plugin qui declare skills:["./"]
// (SKILL.md a sa racine, cas de humanizer), et un plugin avec un sous-dossier
// skills/. On lit le nom declare dans l'entete plutot que de se fier au nom du
// dossier, qui ne correspond pas toujours.
let SKILLS_CACHE = { at: 0, list: null };
const SKILLS_TTL_MS = 30000;

function skillDirs() {
  const home = os.homedir();
  const out = [];
  // pas de filtre isDirectory : un skill peut etre un lien de jonction, que
  // readdir signale comme lien et non comme dossier. On exclut juste les fichiers.
  const sub = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => !e.isFile()).map((e) => path.join(p, e.name)); } catch { return []; } };

  for (const d of sub(path.join(home, '.claude', 'skills'))) out.push(d);

  for (const mk of sub(path.join(home, '.claude', 'plugins', 'marketplaces'))) {
    out.push(mk);                                   // plugin a la racine du depot
    for (const bucket of ['plugins', 'external_plugins']) {
      for (const p of sub(path.join(mk, bucket))) {
        out.push(p);                                // plugin avec SKILL.md a sa racine
        for (const s of sub(path.join(p, 'skills'))) out.push(s);
      }
    }
  }

  let dir = ROOT;
  for (let i = 0; i < 4; i++) {
    for (const d of sub(path.join(dir, '.claude', 'skills'))) out.push(d);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}
function skillsInstalled() {
  if (SKILLS_CACHE.list && Date.now() - SKILLS_CACHE.at < SKILLS_TTL_MS) return SKILLS_CACHE.list;
  const list = [];
  for (const dir of skillDirs()) {
    const f = path.join(dir, 'SKILL.md');
    let head;
    try { head = fs.readFileSync(f, 'utf8').slice(0, 600); } catch { continue; }
    const m = head.match(/^\s*---\s*[\r\n]+[\s\S]*?^name:\s*([^\r\n]+)/m);
    const declared = m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    list.push({ dir, folder: path.basename(dir), name: declared || path.basename(dir) });
  }
  SKILLS_CACHE = { at: Date.now(), list };
  return list;
}
// L'ordre de names fait foi : le premier nom est le skill prefere, les suivants
// sont des equivalents acceptes. On ne rend pas un equivalent quand le prefere
// est installe, sinon le detail affiche affole plus qu'il n'informe.
function skillInfo(names) {
  const list = skillsInstalled();
  for (const n of names) {
    const w = n.toLowerCase();
    const hit = list.find((s) => String(s.name).toLowerCase() === w || s.folder.toLowerCase() === w);
    if (hit) return { found: true, name: hit.name, path: hit.dir };
  }
  return { found: false };
}

// Lit le profil persistant de Playwright MCP pour savoir si le navigateur est
// deja passe sur HelloWork et Indeed (banniere cookies traitee, profil "chaud").
// Cache 30 s : /api/state est appele toutes les 5 s.
let PROFILE_CACHE = { at: 0, val: null };
function mcpProfileInfo(db) {
  if (Date.now() - PROFILE_CACHE.at < 30000 && PROFILE_CACHE.val) return PROFILE_CACHE.val;
  const home = os.homedir();
  const root = [
    path.join(home, 'AppData', 'Local', 'ms-playwright-mcp'),
    path.join(home, 'Library', 'Caches', 'ms-playwright-mcp'),
    path.join(home, '.cache', 'ms-playwright-mcp'),
  ].find((r) => { try { return fs.existsSync(r); } catch { return false; } });

  let val = { found: false, sites: {} };
  if (root) {
    // Le profil pertinent est le plus recemment utilise, pas le plus fourni :
    // se rabattre sur un vieux profil ferait afficher "0 cookie" a tort.
    const profs = [];
    let names = [];
    try { names = fs.readdirSync(root); } catch {}
    for (const prof of names) {
      const ck = [['Default', 'Network', 'Cookies'], ['Default', 'Cookies'], ['Network', 'Cookies'], ['Cookies']]
        .map((rel) => path.join(root, prof, ...rel)).find((f) => { try { return fs.existsSync(f); } catch { return false; } });
      if (!ck) continue;
      try { profs.push({ prof, ck, mtime: fs.statSync(ck).mtimeMs }); } catch {}
    }
    profs.sort((a, b) => b.mtime - a.mtime);

    for (const p of profs) {
      const tmp = path.join(os.tmpdir(), 'jobsearch-ck-' + process.pid + '.db');
      try {
        fs.copyFileSync(p.ck, tmp);   // EBUSY si Chrome tourne : le fichier est verrouille
        const d = new DatabaseSync(tmp, { readOnly: true });
        // pas de last_access_utc : l'horodatage Chrome depasse le format nombre de JS
        const rows = d.prepare('SELECT host_key, COUNT(*) n FROM cookies GROUP BY host_key').all();
        d.close();
        const sites = {};
        for (const k of Object.keys(SITE_HOSTS)) {
          sites[k] = rows.filter((r) => String(r.host_key).includes(SITE_HOSTS[k])).reduce((a, r) => a + r.n, 0);
        }
        val = { found: true, root, profile: p.prof, sites, stale: false };
        if (db) { try { setSetting(db, 'profile_cookies', JSON.stringify({ sites, profile: p.prof, at: now() })); } catch {} }
        break;
      } catch (e) {
        // profil verrouille : on ne descend pas vers un profil plus ancien, on
        // reprend la derniere lecture reussie en la signalant comme datee.
        let last = null;
        if (db) { try { const raw = getSetting(db, 'profile_cookies'); last = raw ? JSON.parse(raw) : null; } catch {} }
        val = { found: true, root, profile: p.prof, locked: true,
          sites: last ? last.sites : {}, stale: !!last, at: last ? last.at : null };
        break;
      } finally { try { fs.unlinkSync(tmp); } catch {} }
    }
    if (!profs.length) val = { found: false, root, sites: {} };
  }
  PROFILE_CACHE = { at: Date.now(), val };
  return val;
}

// Identifiant de la conversation en cours. Le watcher en ouvre une a chaque
// demarrage : le chat du dashboard ne montre que la session courante, sinon il
// accumule l'historique de toutes les sessions Claude Code passees.
function sessionChat(db) {
  let id = getSetting(db, 'chat_session');
  if (!id) { id = 's-' + now(); setSetting(db, 'chat_session', id); }
  return id;
}

function depsState(db) {
  const m = process.version.slice(1).split('.').map(Number);
  const nodeOk = m[0] > 22 || (m[0] === 22 && m[1] >= 13);
  const v = db.prepare('PRAGMA user_version').get().user_version;
  const vendor = Object.keys(VENDOR_FILES).filter((f) => fs.existsSync(path.join(VENDOR_DIR, f)));
  const files = cvFiles();
  const d = {
    node: { label: 'Node.js 22.13 ou plus', status: nodeOk ? 'ok' : 'ko', detail: process.version },
    script: { label: 'Script jobsearch.js', status: 'ok', detail: 'v' + VERSION },
    base: { label: 'Base SQLite', status: v === SCHEMA_VERSION ? 'ok' : 'ko', detail: 'schema ' + v + ' / ' + SCHEMA_VERSION },
    vendor: { label: 'PDF.js embarque', status: vendor.length === 2 ? 'ok' : 'ko',
      detail: vendor.length === 2 ? 'vendor/ complet' : 'manque ' + (2 - vendor.length) + ' fichier(s)' },
    cv: { label: 'Dossier cv/', status: files.length ? 'ok' : 'ko',
      detail: files.length ? files.length + ' PDF' : 'aucun PDF depose' },
    watcher: { label: 'Watcher (boutons actifs)', status: watcherAlive(db) ? 'ok' : 'ko',
      detail: watcherAlive(db) ? 'Claude ecoute' : 'aucune session Claude armee' },
  };
  const ch = chromeInfo();
  d.chrome = { label: 'Google Chrome installe', status: ch.found ? 'ok' : 'ko',
    detail: ch.found ? ('version ' + (ch.version || 'inconnue')) : 'introuvable : Playwright MCP est configure avec --browser chrome' };
  const pr = mcpProfileInfo(db);
  const counts = Object.keys(SITE_HOSTS).map((k) => k + ' ' + (pr.sites[k] || 0) + ' cookie(s)').join(', ');
  const warm = Object.keys(SITE_HOSTS).filter((k) => (pr.sites[k] || 0) > 0).length;
  let pStatus = 'unknown', pDetail;
  if (!pr.found) {
    pDetail = 'aucun profil : le navigateur n a pas encore ete lance par Playwright MCP';
  } else if (pr.locked && !pr.stale) {
    pDetail = 'profil verrouille (navigateur ouvert) et jamais lu jusqu ici';
  } else if (pr.locked) {
    pStatus = warm === Object.keys(SITE_HOSTS).length ? 'ok' : 'unknown';
    pDetail = counts + ' - releve du ' + String(pr.at).slice(0, 16).replace('T', ' ') + ', profil verrouille depuis';
  } else {
    pStatus = warm === Object.keys(SITE_HOSTS).length ? 'ok' : 'unknown';
    pDetail = counts;
  }
  d.profil = { label: 'Profil navigateur prepare', status: pStatus, detail: pDetail };
  for (const [k, spec] of Object.entries(SKILL_DEPS)) {
    const sk = skillInfo(spec.dirs);
    d[k] = { label: spec.label, status: sk.found ? 'ok' : 'ko',
      detail: sk.found ? ('installe : ' + sk.name) : ('introuvable dans ' + path.join(os.homedir(), '.claude', 'skills')) };
  }
  for (const k of Object.keys(CLAUDE_DEPS)) {
    let r = null;
    try { const raw = getSetting(db, 'dep:' + k); r = raw ? JSON.parse(raw) : null; } catch {}
    d[k] = r ? { label: CLAUDE_DEPS[k], status: r.status, detail: r.detail || '', checked_at: r.checked_at }
             : { label: CLAUDE_DEPS[k], status: 'unknown', detail: 'pas encore verifie' };
  }
  return d;
}
function cvState(db) {
  const rows = db.prepare('SELECT id, filename, file_mtime, is_active, imported_at, updated_at FROM cv ORDER BY id').all();
  const byName = new Map(rows.map((r) => [r.filename, r]));
  const files = cvFiles();
  const cvs = files.map((f) => {
    const r = byName.get(f);
    const mt = mtimeOf(f);
    const stale = !!(r && mt && mt > (r.file_mtime || r.updated_at));
    return { id: r ? r.id : null, filename: f, in_db: !!r, needs_import: !r || stale,
      is_active: r ? !!r.is_active : false, imported_at: r ? r.imported_at : null, updated_at: r ? r.updated_at : null };
  });
  const orphans = rows.filter((r) => !files.includes(r.filename)).map((r) => ({ id: r.id, filename: r.filename }));
  const active = rows.find((r) => r.is_active) || null;
  return { cvs, orphans, active_cv: active ? { id: active.id, filename: active.filename } : null };
}

// --- commandes --------------------------------------------------------------
const commands = {
  init() { const db = openDb(); out({ ok: true, version: VERSION, root: ROOT, cv_dir: CV_DIR, db: DB_PATH, schema_version: db.prepare('PRAGMA user_version').get().user_version }); },

  migrate() {
    const before = fs.existsSync(DB_PATH) ? (() => { const d = new DatabaseSync(DB_PATH); const v = d.prepare('PRAGMA user_version').get().user_version; d.close(); return v; })() : null;
    const db = openDb();
    out({ ok: true, from: before, to: db.prepare('PRAGMA user_version').get().user_version, backup: LAST_BACKUP });
  },

  check() {
    const db = openDb();
    const st = cvState(db);
    out({ ok: true, version: VERSION, node: process.version, db: DB_PATH, cv_dir: CV_DIR,
      schema_version: db.prepare('PRAGMA user_version').get().user_version,
      cvs: st.cvs, orphans: st.orphans, active_cv: st.active_cv,
      cv_needs_import: st.cvs.some((c) => c.needs_import),
      offers: db.prepare('SELECT COUNT(*) n FROM offers').get().n,
      searches: db.prepare('SELECT COUNT(*) n FROM searches').get().n,
      letters: db.prepare('SELECT COUNT(*) n FROM letters').get().n });
  },

  'save-cv'(args) {
    const d = input(args);
    if (!d.filename || !d.profile) fail('Champs requis : filename, profile');
    const db = openDb();
    const files = cvFiles();
    if (!files.includes(d.filename)) fail('PDF introuvable dans ' + CV_DIR + ' : ' + d.filename + ' (presents : ' + (files.join(', ') || 'aucun') + ')');
    const t = now();
    db.prepare(`INSERT INTO cv (filename, raw_text, profile_json, file_mtime, is_active, imported_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(filename) DO UPDATE SET raw_text = excluded.raw_text, profile_json = excluded.profile_json,
        file_mtime = excluded.file_mtime, updated_at = excluded.updated_at`)
      .run(d.filename, d.raw_text || null, JSON.stringify(d.profile), mtimeOf(d.filename), t, t);
    const row = db.prepare('SELECT id FROM cv WHERE filename = ?').get(d.filename);
    // un seul CV en base, ou demande explicite : il devient actif
    const nActive = db.prepare('SELECT COUNT(*) n FROM cv WHERE is_active = 1').get().n;
    if (d.active === true || nActive === 0) setActive(db, row.id);
    out({ ok: true, cv_id: row.id, filename: d.filename, is_active: !!db.prepare('SELECT is_active FROM cv WHERE id = ?').get(row.id).is_active });
  },

  // Resultat d'un audit ATS mene par le skill audit-cv-ats. Le score est sur 20 ;
  // items est la grille (six lignes notees sur 5), blockers les alertes bloquantes.
  'save-audit'(args) {
    const d = input(args);
    if (!d.filename || d.score == null) fail('Champs requis : filename, score');
    const score = Number(d.score);
    if (!Number.isFinite(score) || score < 0 || score > 20) fail('score doit etre un nombre entre 0 et 20');
    const db = openDb();
    const cv = db.prepare('SELECT id FROM cv WHERE filename = ?').get(d.filename);
    if (!cv && d.cv_id) fail('CV introuvable : ' + d.filename);
    const offerId = d.offer_id == null ? null : Number(d.offer_id);
    if (offerId != null && !db.prepare('SELECT 1 FROM offers WHERE id = ?').get(offerId)) fail('Offre introuvable : ' + offerId);
    const r = db.prepare(`INSERT INTO cv_audits
      (cv_id, filename, offer_id, score, items_json, blockers_json, keywords_total, keywords_present, report_path, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cv ? cv.id : null, d.filename, offerId, score,
        d.items ? JSON.stringify(d.items) : null,
        d.blockers ? JSON.stringify(d.blockers) : null,
        d.keywords_total == null ? null : Number(d.keywords_total),
        d.keywords_present == null ? null : Number(d.keywords_present),
        d.report_path || null, d.summary == null ? null : String(d.summary).slice(0, 2000), now());
    out({ ok: true, audit_id: Number(r.lastInsertRowid), cv_id: cv ? cv.id : null, filename: d.filename, score });
  },

  'list-audits'(args) {
    const db = openDb();
    const i = args.indexOf('--cv');
    const cible = i >= 0 ? args[i + 1] : null;
    const cv = cible ? findCv(db, cible) : null;
    if (cible && !cv) fail('CV introuvable : ' + cible);
    out({ ok: true, audits: db.prepare('SELECT * FROM cv_audits' + (cv ? ' WHERE cv_id = ?' : '') + ' ORDER BY id DESC LIMIT 30')
      .all(...(cv ? [cv.id] : [])).map(parseAudit) });
  },

  'get-cv'(args) {
    const db = openDb();
    const r = findCv(db, args[0]);
    if (!r) return out({ ok: false, error: args[0] ? 'CV introuvable : ' + args[0] : 'Aucun CV en base' });
    out({ ok: true, id: r.id, filename: r.filename, is_active: !!r.is_active, updated_at: r.updated_at,
      profile: JSON.parse(r.profile_json), raw_text: r.raw_text });
  },

  'list-cv'() {
    const db = openDb();
    const files = cvFiles();
    out({ ok: true, cv_dir: CV_DIR, cvs: db.prepare(`SELECT c.id, c.filename, c.is_active, c.imported_at, c.updated_at,
        (SELECT COUNT(*) FROM offers o WHERE o.cv_id = c.id) AS offers_count,
        (SELECT COUNT(*) FROM searches s WHERE s.cv_id = c.id) AS searches_count
      FROM cv c ORDER BY c.id`).all().map((r) => ({ ...r, is_active: !!r.is_active, file_present: files.includes(r.filename) })) });
  },

  'set-active-cv'(args) {
    if (!args[0]) fail('Usage : set-active-cv <id|nom-du-fichier.pdf>');
    const db = openDb();
    const r = findCv(db, args[0]);
    if (!r) fail('CV introuvable : ' + args[0]);
    setActive(db, r.id);
    out({ ok: true, cv_id: r.id, filename: r.filename });
  },

  'start-search'(args) {
    const d = input(args);
    if (!d.title || !d.location || !d.site) fail('Champs requis : title, location, site');
    if (!SITES.includes(d.site)) fail('site doit valoir : ' + SITES.join(' | '));
    const db = openDb();
    const target = d.target_count ? Number(d.target_count) : null;
    const maxSeen = d.max_seen ? Number(d.max_seen) : (target ? target * 4 : 40);
    if (!(maxSeen > 0)) fail('max_seen doit etre un entier positif');
    if (target && maxSeen < target) fail('max_seen (' + maxSeen + ') est inferieur a target_count (' + target + ') : impossible d\'enregistrer plus d\'offres que d\'annonces lues');
    const contrat = String(d.contract_wanted || 'tous').trim().toLowerCase();
    if (!CONTRATS.includes(contrat)) fail('contract_wanted doit valoir : ' + CONTRATS.join(' | '));
    const cv = findCv(db, d.cv_id);
    const r = db.prepare('INSERT INTO searches (title, location, site, target_count, max_seen, cv_id, started_at, contract_wanted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.title, d.location, d.site, target, maxSeen, cv ? cv.id : null, now(), contrat);
    out({ ok: true, search_id: Number(r.lastInsertRowid), target_count: target, max_seen: maxSeen,
      contract_wanted: contrat, cv_id: cv ? cv.id : null, cv_filename: cv ? cv.filename : null });
  },

  'update-search'(args) {
    const d = input(args);
    if (!d.search_id) fail('Champ requis : search_id');
    const db = openDb();
    const s = db.prepare('SELECT * FROM searches WHERE id = ?').get(Number(d.search_id));
    if (!s) fail('Recherche introuvable : ' + d.search_id);
    let stats = {};
    try { stats = s.stats_json ? JSON.parse(s.stats_json) : {}; } catch { stats = {}; }
    if (d.stats && typeof d.stats === 'object') Object.assign(stats, d.stats);
    const seen = d.offers_seen != null ? Number(d.offers_seen) : (s.offers_seen || 0);
    db.prepare('UPDATE searches SET offers_seen = ?, stats_json = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run(seen, JSON.stringify(stats), d.notes || null, s.id);
    const saved = db.prepare('SELECT COUNT(*) n FROM offers WHERE search_id = ?').get(s.id).n;
    out({ ok: true, search_id: s.id, offers_seen: seen, max_seen: s.max_seen,
      budget_restant: s.max_seen == null ? null : Math.max(0, s.max_seen - seen),
      offers_saved: saved, target_count: s.target_count,
      offres_restantes: s.target_count == null ? null : Math.max(0, s.target_count - saved), stats });
  },

  'finish-search'(args) {
    const d = input(args);
    if (!d.search_id) fail('Champ requis : search_id');
    const db = openDb();
    const s = db.prepare('SELECT * FROM searches WHERE id = ?').get(Number(d.search_id));
    if (!s) fail('Recherche introuvable : ' + d.search_id);
    let stats = {};
    try { stats = s.stats_json ? JSON.parse(s.stats_json) : {}; } catch { stats = {}; }
    if (d.stats && typeof d.stats === 'object') Object.assign(stats, d.stats);
    db.prepare('UPDATE searches SET finished_at = ?, offers_seen = ?, notes = ?, stats_json = ? WHERE id = ?')
      .run(now(), d.offers_seen != null ? Number(d.offers_seen) : (s.offers_seen || 0), d.notes || null, JSON.stringify(stats), s.id);
    out({ ok: true, search_id: s.id, max_seen: s.max_seen, stats });
  },

  'has-url'(args) {
    if (!args[0]) fail('Usage : has-url <url>');
    const db = openDb();
    const r = db.prepare('SELECT id, title, company, match_score, status, recommendation, found_at FROM offers WHERE url = ?').get(normalizeUrl(args[0]));
    out({ ok: true, known: !!r, offer: r || null });
  },

  'find-offer'(args) {
    const company = arg(args, '--company');
    const title = arg(args, '--title');
    if (!company && !title) fail('Usage : find-offer --company "X" [--title "Y"]');
    const db = openDb();
    const like = (v) => '%' + String(v).trim().toLowerCase() + '%';
    let rows;
    if (company && title) {
      rows = db.prepare(`SELECT id, site, url, title, company, location, match_score, status FROM offers
        WHERE lower(company) LIKE ? AND lower(title) LIKE ? ORDER BY id DESC`).all(like(company), like(title));
    } else {
      const col = company ? 'company' : 'title';
      rows = db.prepare(`SELECT id, site, url, title, company, location, match_score, status FROM offers
        WHERE lower(${col}) LIKE ? ORDER BY id DESC`).all(like(company || title));
    }
    out({ ok: true, count: rows.length, offers: rows });
  },

  'add-offer'(args) {
    const d = input(args);
    if (!d.url || !d.title) fail('Champs requis : url, title');
    const score = Math.round(Number(d.match_score));
    if (!(score >= 0 && score <= 100)) fail('match_score doit etre entre 0 et 100');
    if (!RECOS.includes(d.recommendation)) fail('recommendation doit valoir : ' + RECOS.join(' | '));
    const db = openDb();
    const url = normalizeUrl(d.url);
    const cv = findCv(db, d.cv_id);
    const status = STATUS_ALIAS[d.status] || d.status || 'a_postuler';
    if (!STATUSES.includes(status)) fail('status doit valoir : ' + STATUSES.join(' | '));
    const t = now();
    db.prepare(`INSERT INTO offers (search_id, site, url, title, company, location, contract, salary, remote, posted_at,
        description, match_score, strengths, gaps, recommendation, advice, status, found_at, cv_id, status_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET title = excluded.title, company = excluded.company, location = excluded.location,
        contract = excluded.contract, salary = excluded.salary, remote = excluded.remote, posted_at = excluded.posted_at,
        description = excluded.description, match_score = excluded.match_score, strengths = excluded.strengths,
        gaps = excluded.gaps, recommendation = excluded.recommendation, advice = excluded.advice, cv_id = excluded.cv_id`)
      .run(d.search_id || null, d.site || null, url, d.title, d.company || null, d.location || null, d.contract || null,
        d.salary || null, d.remote || null, d.posted_at || null, d.description || null, score,
        listText(d.strengths), listText(d.gaps), d.recommendation, d.advice || null, status, t, cv ? cv.id : null, t);
    const r = db.prepare('SELECT id, status FROM offers WHERE url = ?').get(url);
    out({ ok: true, offer_id: r.id, url, status: r.status, cv_id: cv ? cv.id : null });
  },

  'list-offers'(args) {
    const db = openDb();
    const cols = `o.id, o.search_id, o.site, o.url, o.title, o.company, o.location, o.contract, o.salary,
      o.match_score, o.recommendation, o.status, o.found_at, o.status_updated_at, o.applied_at, o.cv_id,
      c.filename AS cv_filename`;
    const where = [], params = [];
    const s = arg(args, '--search'); if (s !== undefined) { where.push('o.search_id = ?'); params.push(Number(s)); }
    const st = arg(args, '--status'); if (st !== undefined) { where.push('o.status = ?'); params.push(STATUS_ALIAS[st] || st); }
    const cv = arg(args, '--cv'); if (cv !== undefined) { where.push('o.cv_id = ?'); params.push(Number(cv)); }
    if (args.includes('--kanban')) { where.push("o.status <> 'ecartee'"); }
    const sql = 'SELECT ' + cols + ' FROM offers o LEFT JOIN cv c ON c.id = o.cv_id' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY o.match_score DESC, o.id DESC';
    const rows = db.prepare(sql).all(...params);
    out({ ok: true, count: rows.length, offers: rows });
  },

  'get-offer'(args) {
    const db = openDb();
    const o = db.prepare('SELECT o.*, c.filename AS cv_filename FROM offers o LEFT JOIN cv c ON c.id = o.cv_id WHERE o.id = ?').get(Number(args[0]));
    if (!o) fail('Offre introuvable : ' + args[0]);
    out({ ok: true, offer: o, letters: db.prepare('SELECT * FROM letters WHERE offer_id = ? ORDER BY id DESC').all(o.id) });
  },

  'add-letter'(args) {
    const d = input(args);
    if (!d.offer_id || !d.content) fail('Champs requis : offer_id, content');
    const db = openDb();
    if (!db.prepare('SELECT id FROM offers WHERE id = ?').get(d.offer_id)) fail('Offre introuvable : ' + d.offer_id);
    const r = db.prepare('INSERT INTO letters (offer_id, content, created_at) VALUES (?, ?, ?)').run(d.offer_id, d.content, now());
    out({ ok: true, letter_id: Number(r.lastInsertRowid) });
  },

  'set-status'(args) {
    if (!args[0] || !args[1]) fail('Usage : set-status <id> <' + STATUSES.join('|') + '>');
    const r = applyStatus(openDb(), args[0], args[1]);
    if (r.error) fail(r.error);
    out({ ok: true, ...r });
  },

  'set-note'(args) {
    const d = input(args);
    if (!d.offer_id) fail('Champ requis : offer_id');
    const db = openDb();
    const r = db.prepare('UPDATE offers SET notes = ? WHERE id = ?').run(d.notes || null, Number(d.offer_id));
    if (!r.changes) fail('Offre introuvable : ' + d.offer_id);
    out({ ok: true, offer_id: Number(d.offer_id) });
  },

  // Tourne sous l'outil Monitor de Claude Code : chaque ligne imprimee ici
  // devient une notification dans la conversation. Ne se termine jamais seul.
  'watch-actions'(args) {
    const db = openDb();
    const i = args.indexOf('--interval');
    const interval = Math.max(500, (Number(i >= 0 ? args[i + 1] : 1) || 1) * 1000);
    // Une action prise en charge par une session morte resterait suspendue.
    // Exclusivite : deux watchers sur la meme base se volent les actions au
    // premier arrive, sans que personne ne puisse savoir laquelle ecoute.
    const seen = getSetting(db, 'watcher_seen_at');
    const otherPid = getSetting(db, 'watcher_pid');
    const fresh = seen && (Date.now() - Date.parse(seen)) < WATCHER_TTL_MS;
    if (fresh && otherPid && Number(otherPid) !== process.pid && !args.includes('--force')) {
      fail('Un watcher ecoute deja ce dossier (PID ' + otherPid + ', demarre ' +
        (getSetting(db, 'watcher_started_at') || '?') + '). Ferme l\'autre session Claude Code, ' +
        'ou relance avec --force pour prendre sa place.');
    }
    const startedAt = now();
    setSetting(db, 'watcher_pid', String(process.pid));
    setSetting(db, 'watcher_started_at', startedAt);
    // Conversation neuve : le chat du dashboard repart vide a chaque session
    // Claude Code, au lieu d'empiler les echanges de toutes les precedentes.
    // Rien n'est supprime, les anciens messages restent lisibles avec
    // list-messages --all.
    const sessionPrec = getSetting(db, 'chat_session');
    const session = 's-' + startedAt;
    setSetting(db, 'chat_session', session);
    // Une question restee sans reponse dans la session d'avant n'a plus
    // personne pour la traiter : la laisser cliquable serait un piege.
    const orphelines = db.prepare(`UPDATE questions SET status = 'cancelled', answered_at = ?
      WHERE status = 'pending' AND message_id IN (SELECT id FROM messages WHERE session_id IS NOT ?)`)
      .run(startedAt, session);
    const restes = sessionPrec
      ? db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionPrec).c : 0;
    if (restes || orphelines.changes) {
      process.stderr.write(JSON.stringify({ chat: 'nouvelle session', session,
        messages_archives: restes, questions_annulees: orphelines.changes }) + '\n');
    }
    const stale = db.prepare(`UPDATE actions SET status = 'failed', done_at = ?, result = 'session interrompue'
      WHERE status = 'taken' AND taken_at < ?`).run(now(), new Date(Date.now() - 600000).toISOString());
    if (stale.changes) process.stderr.write(JSON.stringify({ nettoyees: stale.changes }) + '\n');
    process.stderr.write(JSON.stringify({ watcher: 'arme', pid: process.pid, db: DB_PATH, interval_ms: interval }) + '\n');
    const tick = () => {
      try {
        // Un autre watcher a pris la main (--force) : on se retire plutot que
        // de continuer a voler des actions en silence.
        const owner = getSetting(db, 'watcher_pid');
        if (owner && Number(owner) !== process.pid) {
          process.stderr.write(JSON.stringify({ watcher: 'remplace', par_pid: Number(owner) }) + '\n');
          process.exit(0);
        }
        setSetting(db, 'watcher_seen_at', now());
        // Plafond de 5 : Monitor s'arrete de lui-meme s'il est inonde de lignes.
        const rows = db.prepare("SELECT id, type, payload_json FROM actions WHERE status = 'pending' ORDER BY id LIMIT 5").all();
        for (const r of rows) {
          db.prepare("UPDATE actions SET status = 'taken', taken_at = ? WHERE id = ?").run(now(), r.id);
          let payload = null;
          try { payload = r.payload_json ? JSON.parse(r.payload_json) : null; } catch {}
          console.log(JSON.stringify({ action: r.id, type: r.type, payload }));
        }
      } catch (e) { process.stderr.write(JSON.stringify({ watcher_error: e.message }) + '\n'); }
    };
    tick();
    setInterval(tick, interval);
  },

  'action-done'(args) {
    const d = input(args);
    if (!d.action_id) fail('Champ requis : action_id');
    const status = d.status || 'done';
    if (!['done', 'failed'].includes(status)) fail('status doit valoir : done | failed');
    const db = openDb();
    const r = db.prepare('UPDATE actions SET status = ?, done_at = ?, result = ? WHERE id = ?')
      .run(status, now(), d.result == null ? null : String(d.result).slice(0, 2000), Number(d.action_id));
    if (!r.changes) fail('Action introuvable : ' + d.action_id);
    out({ ok: true, action_id: Number(d.action_id), status });
  },

  'list-actions'(args) {
    const db = openDb();
    const where = args.includes('--pending') ? " WHERE status IN ('pending','taken')" : '';
    out({ ok: true, watcher_alive: watcherAlive(db),
      actions: db.prepare('SELECT * FROM actions' + where + ' ORDER BY id DESC LIMIT 50').all()
        .map((r) => { let p = null; try { p = r.payload_json ? JSON.parse(r.payload_json) : null; } catch {} const { payload_json, ...rest } = r; return { ...rest, payload: p }; }) });
  },

  'delete-offer'(args) {
    if (!args[0]) fail('Usage : delete-offer <id>');
    const db = openDb();
    const o = db.prepare('SELECT id, title, company FROM offers WHERE id = ?').get(Number(args[0]));
    if (!o) fail('Offre introuvable : ' + args[0]);
    const n = db.prepare('SELECT COUNT(*) n FROM letters WHERE offer_id = ?').get(o.id).n;
    db.prepare('DELETE FROM offers WHERE id = ?').run(o.id);   // les lettres suivent (ON DELETE CASCADE)
    out({ ok: true, deleted: o.id, title: o.title, company: o.company, letters_deleted: n });
  },

  'delete-letter'(args) {
    if (!args[0]) fail('Usage : delete-letter <id>');
    const r = openDb().prepare('DELETE FROM letters WHERE id = ?').run(Number(args[0]));
    if (!r.changes) fail('Lettre introuvable : ' + args[0]);
    out({ ok: true, deleted: Number(args[0]) });
  },

  // Retire l'analyse de la base. Le PDF reste dans cv/ : supprimer un fichier de
  // l'utilisateur sans qu'il l'ait demande n'est pas le role de cette commande.
  'delete-cv'(args) {
    if (!args[0]) fail('Usage : delete-cv <id|nom-du-fichier.pdf>');
    const db = openDb();
    const c = findCv(db, args[0]);
    if (!c) fail('CV introuvable : ' + args[0]);
    const off = db.prepare('SELECT COUNT(*) n FROM offers WHERE cv_id = ?').get(c.id).n;
    db.prepare('DELETE FROM cv WHERE id = ?').run(c.id);       // offers.cv_id passe a NULL
    // s'il etait actif, on reactive le premier CV restant pour ne pas rester sans reference
    if (c.is_active) {
      const next = db.prepare('SELECT id FROM cv ORDER BY id LIMIT 1').get();
      if (next) setActive(db, next.id);
    }
    out({ ok: true, deleted: c.id, filename: c.filename, offers_detached: off,
      note: 'le PDF reste dans ' + CV_DIR });
  },

  'set-dep'(args) {
    const d = input(args);
    if (!Object.prototype.hasOwnProperty.call(CLAUDE_DEPS, d.name)) fail('name doit valoir : ' + Object.keys(CLAUDE_DEPS).join(' | '));
    if (!['ok', 'ko', 'unknown'].includes(d.status)) fail('status doit valoir : ok | ko | unknown');
    const db = openDb();
    setSetting(db, 'dep:' + d.name, JSON.stringify({ status: d.status, detail: String(d.detail || '').slice(0, 300), checked_at: now() }));
    out({ ok: true, name: d.name, status: d.status });
  },

  deps() { out({ ok: true, deps: depsState(openDb()) }); },

  // Reponse de Claude dans le chat du dashboard. Cloture l'action au passage
  // quand action_id est fourni : un aller-retour au lieu de deux.
  say(args) {
    const d = input(args);
    if (!d.content || !String(d.content).trim()) fail('Champ requis : content');
    const db = openDb();
    const r = db.prepare('INSERT INTO messages (role, content, action_id, created_at, session_id) VALUES (\'claude\', ?, ?, ?, ?)')
      .run(String(d.content), d.action_id ? Number(d.action_id) : null, now(), sessionChat(db));
    let closed = false;
    if (d.action_id) {
      const a = db.prepare('UPDATE actions SET status = \'done\', done_at = ?, result = ? WHERE id = ? AND status <> \'done\'')
        .run(now(), 'repondu', Number(d.action_id));
      closed = a.changes > 0;
    }
    out({ ok: true, message_id: Number(r.lastInsertRowid), action_closed: closed });
  },

  // Pose une question cliquable dans le chat du dashboard. Claude termine son
  // tour apres l'appel ; la reponse revient plus tard comme action `answer`.
  ask(args) {
    const d = input(args);
    const prompt = String(d.prompt || '').trim();
    if (!prompt) fail('Champ requis : prompt');
    const opts = Array.isArray(d.options) ? d.options : [];
    if (!opts.length && !d.allow_text) fail('Fournis au moins une option, ou allow_text a true');
    if (opts.length > 12) fail('12 options au maximum');
    const clean = opts.map((o, i) => {
      const value = String((o && o.value != null ? o.value : o) || '').trim() || ('opt' + (i + 1));
      const label = String((o && o.label) || value).trim();
      return { value, label, detail: o && o.detail ? String(o.detail) : null };
    });
    const db = openDb();
    const t = now();
    const m = db.prepare('INSERT INTO messages (role, content, created_at, session_id) VALUES (\'claude\', ?, ?, ?)').run(prompt, t, sessionChat(db));
    const q = db.prepare(`INSERT INTO questions (prompt, options_json, multi, allow_text, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(prompt, JSON.stringify(clean), d.multi ? 1 : 0, d.allow_text ? 1 : 0, Number(m.lastInsertRowid), t);
    // une action en cours ? on la clot : la question remplace la reponse
    if (d.action_id) {
      db.prepare('UPDATE actions SET status = \'done\', done_at = ?, result = ? WHERE id = ? AND status <> \'done\'')
        .run(t, 'question posee', Number(d.action_id));
    }
    out({ ok: true, question_id: Number(q.lastInsertRowid), message_id: Number(m.lastInsertRowid),
      options: clean.map((c) => c.value) });
  },

  answers(args) {
    const db = openDb();
    const where = args.includes('--pending') ? " WHERE status = 'pending'" : '';
    out({ ok: true, questions: db.prepare('SELECT * FROM questions' + where + ' ORDER BY id DESC LIMIT 30').all()
      .map((r) => {
        let o = [], a = null;
        try { o = JSON.parse(r.options_json); } catch {}
        try { a = r.answer_json ? JSON.parse(r.answer_json) : null; } catch {}
        const { options_json, answer_json, ...rest } = r;
        return { ...rest, multi: !!r.multi, allow_text: !!r.allow_text, options: o, answer: a };
      }) });
  },

  'cancel-question'(args) {
    if (!args[0]) fail('Usage : cancel-question <id>');
    const r = openDb().prepare('UPDATE questions SET status = \'cancelled\', answered_at = ? WHERE id = ? AND status = \'pending\'')
      .run(now(), Number(args[0]));
    out({ ok: r.changes > 0 });
  },

  'list-messages'(args) {
    const n = Math.min(500, Math.max(1, Number(arg(args, '--limit')) || 50));
    const db = openDb();
    const rows = args.includes('--all')
      ? db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(n).reverse()
      : db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionChat(db), n).reverse();
    out({ ok: true, count: rows.length, messages: rows });
  },

  'queue-action'(args) {
    const d = input(args);
    const db = openDb();
    const r = queueAction(db, d.type, d.payload, d.label);
    if (r.error) fail(r.error);
    out({ ok: true, ...r });
  },

  serve(args) { serve(Number(args[0]) || 3000); },
};
commands['scan-cv'] = commands.check;   // meme sortie, nom parlant pour le rescan du dossier cv/

// --- serveur ----------------------------------------------------------------
function serve(port) {
  const db = openDb();
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const readJson = (req, res, limit, cb) => {
    if (!String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'json attendu' });
    let body = '', over = false;
    req.on('data', (c) => { body += c; if (body.length > limit) { over = true; req.destroy(); } });
    req.on('end', () => { if (over) return; try { cb(JSON.parse(body)); } catch { json(res, 400, { error: 'requete invalide' }); } });
  };
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, 'http://localhost');
    const mStatus = url.pathname.match(/^\/api\/offers\/(\d+)\/status$/);
    const mNotes = url.pathname.match(/^\/api\/offers\/(\d+)\/notes$/);
    const mDel = url.pathname.match(/^\/api\/(offers|letters|cv)\/(\d+)$/);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(PAGE);
      }
      if (req.method === 'GET' && url.pathname === '/api/version') {
        return json(res, 200, { version: VERSION, schema_version: SCHEMA_VERSION });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        // Liste blanche stricte : aucun segment de chemin ne vient de la requete.
        const name = url.pathname.slice('/vendor/'.length);
        if (!Object.prototype.hasOwnProperty.call(VENDOR_FILES, name)) return json(res, 404, { error: 'not found' });
        const full = path.join(VENDOR_DIR, name);
        if (!fs.existsSync(full)) return json(res, 404, { error: 'fichier absent : vendor/' + name });
        // Seule exception au no-store du dashboard : ces fichiers sont immuables
        // et peses en Mo, les recharger a chaque sondage serait absurde.
        res.writeHead(200, { 'Content-Type': VENDOR_FILES[name], 'Cache-Control': 'public, max-age=31536000, immutable' });
        return fs.createReadStream(full).pipe(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const files = cvFiles();
        const rows = db.prepare(`SELECT c.id, c.filename, c.is_active, c.imported_at, c.updated_at, c.file_mtime, c.profile_json,
            (SELECT COUNT(*) FROM offers o WHERE o.cv_id = c.id) AS offers_count,
            (SELECT COUNT(*) FROM searches s WHERE s.cv_id = c.id) AS searches_count
          FROM cv c ORDER BY c.id`).all().map((r) => {
            let profile = {}; try { profile = JSON.parse(r.profile_json); } catch {}
            const mt = mtimeOf(r.filename);
            const present = files.includes(r.filename);
            return { id: r.id, filename: r.filename, is_active: !!r.is_active, imported_at: r.imported_at,
              updated_at: r.updated_at, offers_count: r.offers_count, searches_count: r.searches_count,
              file_present: present, in_db: true,
              needs_import: present && !!mt && mt > (r.file_mtime || r.updated_at), profile };
          });
        // Un PDF depose dans cv/ mais jamais importe doit apparaitre lui aussi,
        // sinon le bouton "Analyser ce CV" ne s'affiche jamais pour un CV neuf.
        const known = new Set(rows.map((r) => r.filename));
        const cvs = rows.concat(files.filter((f) => !known.has(f)).map((f) => ({
          id: null, filename: f, is_active: false, imported_at: null, updated_at: null,
          offers_count: 0, searches_count: 0, file_present: true, in_db: false, needs_import: true, profile: {},
        })));
        // Un audit est rattache au fichier, pas a l'id : un CV oublie puis
        // re-importe doit retrouver son dernier audit.
        const audits = db.prepare('SELECT * FROM cv_audits ORDER BY id DESC LIMIT 60').all().map(parseAudit);
        for (const c of cvs) c.last_audit = audits.find((a) => a.filename === c.filename && a.offer_id == null) || null;
        const active = cvs.find((c) => c.is_active) || null;
        const searches = db.prepare(`SELECT s.*, c.filename AS cv_filename,
            (SELECT COUNT(*) FROM offers o WHERE o.search_id = s.id) AS offers_saved
          FROM searches s LEFT JOIN cv c ON c.id = s.cv_id ORDER BY s.id DESC`).all().map((r) => {
            let stats = null; try { stats = r.stats_json ? JSON.parse(r.stats_json) : null; } catch {}
            const { stats_json, ...rest } = r;
            return { ...rest, stats };
          });
        return json(res, 200, {
          version: VERSION,
          watcher_alive: watcherAlive(db),
          pdfjs: fs.existsSync(path.join(VENDOR_DIR, 'pdf.min.mjs')),
          deps: depsState(db),
          actions: db.prepare('SELECT id, type, label, status, created_at, done_at, result FROM actions ORDER BY id DESC LIMIT 20').all(),
          watcher_pid: getSetting(db, 'watcher_pid'),
          watcher_started_at: getSetting(db, 'watcher_started_at'),
          messages: db.prepare(`SELECT m.id, m.role, m.content, m.action_id, m.created_at, a.status AS action_status
            FROM messages m LEFT JOIN actions a ON a.id = m.action_id
            WHERE m.session_id = ?
            ORDER BY m.id DESC LIMIT 40`).all(sessionChat(db)).reverse(),
          questions: db.prepare('SELECT * FROM questions ORDER BY id DESC LIMIT 20').all().map((r) => {
            let o = [], a = null;
            try { o = JSON.parse(r.options_json); } catch {}
            try { a = r.answer_json ? JSON.parse(r.answer_json) : null; } catch {}
            const { options_json, answer_json, ...rest } = r;
            return { ...rest, multi: !!r.multi, allow_text: !!r.allow_text, options: o, answer: a };
          }),
          offers: db.prepare(`SELECT o.*, c.filename AS cv_filename,
              (SELECT COUNT(*) FROM letters l WHERE l.offer_id = o.id) AS letters_count
            FROM offers o LEFT JOIN cv c ON c.id = o.cv_id ORDER BY o.match_score DESC, o.id DESC`).all(),
          searches,
          letters: db.prepare(`SELECT l.*, o.title AS offer_title, o.company AS offer_company
            FROM letters l JOIN offers o ON o.id = l.offer_id ORDER BY l.id DESC`).all(),
          cvs, audits,
          cv: active ? { id: active.id, filename: active.filename, updated_at: active.updated_at, profile: active.profile } : null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/cv/file') {
        const files = cvFiles();
        const q = url.searchParams;
        let name = null;
        if (q.has('id')) { const r = db.prepare('SELECT filename FROM cv WHERE id = ?').get(Number(q.get('id')) || 0); name = r && r.filename; }
        else if (q.has('file')) name = q.get('file');
        else { const r = db.prepare('SELECT filename FROM cv WHERE is_active = 1').get(); name = r && r.filename; }
        if (!name || !files.includes(name)) name = files[0];           // garde 1 : liste blanche readdir
        if (!name) return json(res, 404, { error: 'Aucun CV' });
        const full = path.resolve(CV_DIR, name);
        if (path.dirname(full) !== path.resolve(CV_DIR)) return json(res, 400, { error: 'chemin invalide' });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
        return fs.createReadStream(full).pipe(res);
      }
      if (req.method === 'POST' && mStatus) {
        return readJson(req, res, 1e4, (d) => {
          const r = applyStatus(db, mStatus[1], d.status);
          if (r.error) return json(res, 400, { error: r.error });
          json(res, 200, { ok: true, offer: r });
        });
      }
      if (req.method === 'POST' && mNotes) {
        return readJson(req, res, 2e4, (d) => {
          const r = db.prepare('UPDATE offers SET notes = ? WHERE id = ?').run(d.notes || null, Number(mNotes[1]));
          json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'offre introuvable' });
        });
      }
      if (req.method === 'DELETE' && mDel) {
        const id = Number(mDel[2]);
        if (mDel[1] === 'offers') {
          const o = db.prepare('SELECT id FROM offers WHERE id = ?').get(id);
          if (!o) return json(res, 404, { error: 'offre introuvable' });
          const n = db.prepare('SELECT COUNT(*) n FROM letters WHERE offer_id = ?').get(id).n;
          db.prepare('DELETE FROM offers WHERE id = ?').run(id);
          return json(res, 200, { ok: true, letters_deleted: n });
        }
        if (mDel[1] === 'letters') {
          const r = db.prepare('DELETE FROM letters WHERE id = ?').run(id);
          return json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'lettre introuvable' });
        }
        const c = db.prepare('SELECT id, is_active FROM cv WHERE id = ?').get(id);
        if (!c) return json(res, 404, { error: 'CV introuvable' });
        const off = db.prepare('SELECT COUNT(*) n FROM offers WHERE cv_id = ?').get(id).n;
        db.prepare('DELETE FROM cv WHERE id = ?').run(id);
        if (c.is_active) {
          const next = db.prepare('SELECT id FROM cv ORDER BY id LIMIT 1').get();
          if (next) setActive(db, next.id);
        }
        return json(res, 200, { ok: true, offers_detached: off });
      }
      if (req.method === 'POST' && url.pathname === '/api/actions') {
        return readJson(req, res, 1e4, (d) => {
          const r = queueAction(db, d.type, d.payload, d.label);
          if (r.error) return json(res, 400, { error: r.error });
          json(res, 200, { ok: true, ...r, watcher_alive: watcherAlive(db) });
        });
      }
      // Reponse a une question cliquable : on enregistre le choix, on l'ajoute
      // au fil du chat, et on reveille Claude avec une action `answer`.
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        return readJson(req, res, 2e4, (d) => {
          const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(d.question_id));
          if (!q) return json(res, 404, { error: 'question introuvable' });
          if (q.status !== 'pending') return json(res, 409, { error: 'question deja repondue' });
          let opts = []; try { opts = JSON.parse(q.options_json); } catch {}
          const vals = Array.isArray(d.values) ? d.values.map(String) : [];
          const libre = String(d.text || '').trim();
          if (!vals.length && !libre) return json(res, 400, { error: 'aucun choix' });
          if (libre && !q.allow_text) return json(res, 400, { error: 'reponse libre non autorisee' });
          const connus = vals.filter((v) => opts.some((o) => o.value === v));
          if (connus.length !== vals.length) return json(res, 400, { error: 'option inconnue' });
          if (!q.multi && connus.length > 1) return json(res, 400, { error: 'une seule option attendue' });
          const libelles = connus.map((v) => (opts.find((o) => o.value === v) || {}).label || v);
          if (libre) libelles.push(libre);
          const t = now();
          const payload = { question_id: q.id, prompt: q.prompt, values: connus, labels: libelles, text: libre || null };
          const a = queueAction(db, 'answer', payload, libelles.join(', ').slice(0, 60));
          if (a.error) return json(res, 400, { error: a.error });
          db.prepare('INSERT INTO messages (role, content, action_id, created_at, session_id) VALUES (\'user\', ?, ?, ?, ?)')
            .run(libelles.join(', '), a.action_id, t, sessionChat(db));
          db.prepare('UPDATE questions SET status = \'answered\', answer_json = ?, action_id = ?, answered_at = ? WHERE id = ?')
            .run(JSON.stringify({ values: connus, labels: libelles, text: libre || null }), a.action_id, t, q.id);
          json(res, 200, { ok: true, action_id: a.action_id, watcher_alive: watcherAlive(db) });
        });
      }
      // Chat : un message ecrit dans la page devient une ligne messages + une
      // action que le watcher emet. Claude repond avec la commande `say`.
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return readJson(req, res, 2e4, (d) => {
          const content = String(d.content || '').trim();
          if (!content) return json(res, 400, { error: 'message vide' });
          if (content.length > 8000) return json(res, 400, { error: 'message trop long (8000 caracteres maximum)' });
          const a = queueAction(db, 'message', { content }, content.slice(0, 60));
          if (a.error) return json(res, 400, { error: a.error });
          const m = db.prepare('INSERT INTO messages (role, content, action_id, created_at, session_id) VALUES (\'user\', ?, ?, ?, ?)')
            .run(content, a.action_id, now(), sessionChat(db));
          json(res, 200, { ok: true, message_id: Number(m.lastInsertRowid), action_id: a.action_id, watcher_alive: watcherAlive(db) });
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/cv/active') {
        return readJson(req, res, 1e4, (d) => {
          const r = db.prepare('SELECT id FROM cv WHERE id = ?').get(Number(d.cv_id));
          if (!r) return json(res, 404, { error: 'CV introuvable' });
          setActive(db, r.id);
          json(res, 200, { ok: true, cv_id: r.id });
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        return readJson(req, res, 1e3, (d) => {
          if (d.confirm !== 'stop') return json(res, 400, { error: 'confirm attendu' });
          json(res, 200, { ok: true });
          setTimeout(() => { server.close(); process.exit(0); }, 50);
        });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });
  server.on('error', (e) => fail(e.code === 'EADDRINUSE' ? 'Port ' + port + ' deja utilise (dashboard deja lance ?)' : e.message));
  server.listen(port, '127.0.0.1', () => console.log('Dashboard v' + VERSION + ' : http://localhost:' + port));
}

// --- dashboard --------------------------------------------------------------
const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recherche d'emploi</title><style>
/* Themes. Chaque palette ne declare que ses deux accents ; le mode clair ou
   sombre choisit lequel appliquer. Trois regles de mode au lieu d'une par
   combinaison. Le mode "auto" suit le reglage du systeme. */
:root{--acc-l:#2f6fed;--acc-d:#7aa2ff}
:root[data-theme=violet]{--acc-l:#6d45e8;--acc-d:#b09bff}
:root[data-theme=vert]{--acc-l:#0e8a5f;--acc-d:#4fd0a0}
:root[data-theme=ambre]{--acc-l:#b4690e;--acc-d:#f0b657}
:root[data-theme=rose]{--acc-l:#c2255c;--acc-d:#ff8fb1}
:root[data-theme=ardoise]{--acc-l:#475569;--acc-d:#9fb3c8}
:root{
 --bg:#f4f6fa;--card:#fff;--fg:#141a24;--mut:#5f6b7f;--line:#e4e8f0;
 --acc:var(--acc-l);--ok:#0f8a56;--mid:#b57500;--ko:#c0392b;
 --sh1:0 1px 2px rgba(16,24,40,.05);
 --sh2:0 4px 14px rgba(16,24,40,.08);
 --sh3:0 18px 48px rgba(16,24,40,.18);
 --tint:color-mix(in oklab,var(--acc) 9%,var(--card));
 --ring:color-mix(in oklab,var(--acc) 35%,transparent);
 --r:14px;--r2:10px;
 --t:.16s cubic-bezier(.4,0,.2,1);
}
:root[data-mode=sombre]{
 --bg:#0d1017;--card:#161b24;--fg:#e9edf5;--mut:#93a0b5;--line:#252c39;
 --acc:var(--acc-d);--ok:#45c98d;--mid:#e0a63a;--ko:#f2705f;
 --sh1:0 1px 2px rgba(0,0,0,.4);
 --sh2:0 4px 16px rgba(0,0,0,.45);
 --sh3:0 20px 52px rgba(0,0,0,.6);
 --tint:color-mix(in oklab,var(--acc) 15%,var(--card));
}
@media(prefers-color-scheme:dark){
 :root[data-mode=auto]{
  --bg:#0d1017;--card:#161b24;--fg:#e9edf5;--mut:#93a0b5;--line:#252c39;
  --acc:var(--acc-d);--ok:#45c98d;--mid:#e0a63a;--ko:#f2705f;
  --sh1:0 1px 2px rgba(0,0,0,.4);
  --sh2:0 4px 16px rgba(0,0,0,.45);
  --sh3:0 20px 52px rgba(0,0,0,.6);
  --tint:color-mix(in oklab,var(--acc) 15%,var(--card));
 }
}
*{box-sizing:border-box}html{height:100%}
body{margin:0;display:flex;flex-direction:column;height:100dvh;overflow:hidden;
 font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
 background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
::selection{background:var(--ring)}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
body>header{flex:0 0 auto;padding:14px 24px 0;max-width:none;margin:0;
 background:linear-gradient(180deg,var(--tint),var(--bg) 78%);border-bottom:1px solid var(--line)}
h1{font-size:19px;font-weight:650;letter-spacing:-.01em;margin:0 0 12px;display:flex;align-items:center;gap:10px}
h1 .ver{font-size:12px;font-weight:400;color:var(--mut)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.stat{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--r);
 padding:9px 16px;min-width:116px;box-shadow:var(--sh1);transition:transform var(--t),box-shadow var(--t)}
.stat:hover{transform:translateY(-1px);box-shadow:var(--sh2)}
.stat b{display:block;font-size:22px;font-weight:650;letter-spacing:-.02em;line-height:1.2}
.stat span{color:var(--mut);font-size:12.5px}
nav{display:flex;gap:2px;border-bottom:1px solid var(--line)}
nav button{position:relative;background:none;border:0;color:var(--mut);padding:10px 15px;font:inherit;
 cursor:pointer;border-radius:var(--r2) var(--r2) 0 0;transition:color var(--t),background var(--t)}
nav button:hover{color:var(--fg);background:color-mix(in oklab,var(--fg) 5%,transparent)}
nav button::after{content:'';position:absolute;left:12px;right:12px;bottom:-1px;height:2px;border-radius:2px;
 background:var(--acc);transform:scaleX(0);transition:transform var(--t)}
nav button.on{color:var(--fg);font-weight:600}
nav button.on::after{transform:scaleX(1)}
#shell{flex:1 1 auto;display:flex;align-items:stretch;min-height:0;min-width:0}
main{flex:1 1 auto;min-width:0;max-width:none;margin:0;padding:18px 24px 60px;overflow:auto;overscroll-behavior:contain}
#grip{flex:0 0 9px;cursor:col-resize;position:relative;touch-action:none;display:none}
body.panel-open #grip{display:block}
#grip::before{content:'';position:absolute;inset:0 4px;background:var(--line);border-radius:2px;transition:background var(--t),inset var(--t)}
#grip:hover::before,#grip.on::before{background:var(--acc);inset:0 3px}
body.resizing{cursor:col-resize;user-select:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:99px;background:var(--mut);margin-right:7px;vertical-align:middle}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px color-mix(in oklab,var(--ok) 25%,transparent);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px color-mix(in oklab,var(--ok) 25%,transparent)}50%{box-shadow:0 0 0 6px color-mix(in oklab,var(--ok) 6%,transparent)}}
.watch{font-size:13px;color:var(--mut);display:inline-flex;align-items:center;white-space:nowrap;
 background:var(--card);border:1px solid var(--line);border-radius:99px;padding:3px 12px 3px 10px}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.acts .b{font-size:13px;padding:6px 12px}
.feed{font-size:13px;color:var(--mut);display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.feed b{font-weight:600;color:var(--fg)}
.feed .done{color:var(--ok)}.feed .failed{color:var(--ko)}.feed .taken{color:var(--mid)}
/* selecteur de theme */
#themebtn{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13px;
 background:var(--card);border:1px solid var(--line);border-radius:99px;padding:5px 13px;color:var(--mut);
 cursor:pointer;transition:border-color var(--t),color var(--t),transform var(--t)}
#themebtn:hover{border-color:var(--acc);color:var(--fg)}
#themebtn:active{transform:scale(.97)}
#themebtn i{width:13px;height:13px;border-radius:99px;background:var(--acc);display:inline-block}
#themepop{position:fixed;z-index:60;background:var(--card);border:1px solid var(--line);border-radius:var(--r);
 box-shadow:var(--sh3);padding:14px;width:238px;display:none;transform-origin:top right}
#themepop.on{display:block;animation:pop .17s cubic-bezier(.34,1.3,.64,1)}
@keyframes pop{from{opacity:0;transform:scale(.94) translateY(-6px)}to{opacity:1;transform:none}}
#themepop h4{margin:0 0 7px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600}
.modes{display:flex;gap:5px;margin-bottom:14px}
.modes button{flex:1;font:inherit;font-size:13px;padding:6px 0;border:1px solid var(--line);border-radius:var(--r2);
 background:var(--bg);color:var(--mut);cursor:pointer;transition:all var(--t)}
.modes button.on{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.swatches{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
.sw{width:100%;aspect-ratio:1;border-radius:99px;border:2px solid transparent;cursor:pointer;padding:0;
 transition:transform var(--t),border-color var(--t)}
.sw:hover{transform:scale(1.14)}
.sw.on{border-color:var(--fg);transform:scale(1.1)}
#modal{position:fixed;inset:0;background:rgba(8,11,18,.5);backdrop-filter:blur(3px);display:none;
 align-items:flex-start;justify-content:center;z-index:40;padding:8vh 16px}
body.modal-open #modal{display:flex;animation:fade .18s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
#modalbox{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;
 width:min(460px,100%);box-shadow:var(--sh3);animation:rise .22s cubic-bezier(.34,1.2,.64,1)}
@keyframes rise{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
#modalbox label{display:block;margin:12px 0 0;font-size:13px;color:var(--mut)}
#modalbox input,#modalbox select{width:100%;margin-top:4px}
.err{color:var(--ko);font-size:13px;margin-top:8px}
.x{position:absolute;top:10px;right:12px;background:none;border:0;color:var(--mut);font:inherit;font-size:22px;
   line-height:1;padding:2px 7px;border-radius:var(--r2);cursor:pointer;transition:background var(--t),color var(--t),transform var(--t)}
.x:hover{background:var(--bg);color:var(--fg);transform:rotate(90deg)}
.panel-head{position:relative}
.del{color:var(--ko);border-color:transparent}
.del:hover{border-color:var(--ko);background:color-mix(in oklab,var(--ko) 10%,var(--card))}
.card.pick{cursor:pointer}
.deps{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:11px}
.dep{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--mut);border-radius:var(--r);
 padding:12px 15px;box-shadow:var(--sh1);transition:transform var(--t),box-shadow var(--t)}
.dep:hover{transform:translateY(-1px);box-shadow:var(--sh2)}
.dep.ok{border-left-color:var(--ok)}.dep.ko{border-left-color:var(--ko)}.dep.unknown{border-left-color:var(--mut)}
.dep b{display:block;font-size:14px}
.dep .s{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.dep.ok .s{color:var(--ok)}.dep.ko .s{color:var(--ko)}.dep.unknown .s{color:var(--mut)}
.dep .d{color:var(--mut);font-size:13px;overflow-wrap:anywhere}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
input,select{font:inherit;padding:8px 11px;border:1px solid var(--line);border-radius:var(--r2);
 background:var(--card);color:var(--fg);transition:border-color var(--t),box-shadow var(--t)}
input:focus,select:focus{outline:0;border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}
label.ck{display:flex;align-items:center;gap:6px;font-size:14px;color:var(--mut)}label.ck input{padding:0}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh1)}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600;
 position:sticky;top:0;background:var(--card);z-index:1}
tbody tr{cursor:pointer;transition:background var(--t)}
tbody tr:hover{background:var(--tint)}tr:last-child td{border-bottom:0}
tbody tr.on{background:var(--tint);box-shadow:inset 3px 0 0 var(--acc)}
/* colonnes secondaires : une ligne, coupee proprement, texte complet en infobulle */
td.cut{max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* largeurs pilotees par le colgroup : sans table-layout fixe, le navigateur
   recalcule tout a partir du contenu et ignore ce qu'on tire a la souris. */
table.fixe{table-layout:fixed;min-width:0;width:100%}
table.fixe td,table.fixe th{overflow:hidden;text-overflow:ellipsis}
table.fixe td.cut,table.fixe td.nw,table.fixe td.poste{max-width:none;min-width:0}
table.fixe td.poste{white-space:normal}
table.fixe th{position:relative;white-space:nowrap}
.rz{position:absolute;top:0;right:0;width:9px;height:100%;cursor:col-resize;touch-action:none}
.rz::before{content:'';position:absolute;top:22%;bottom:22%;right:4px;width:1px;background:var(--line)}
.rz:hover::before,.rz.on::before{top:0;bottom:0;right:3px;width:2px;background:var(--acc)}
td.cut.w2{max-width:142px}td.cut.w0{max-width:96px}
td.nw{white-space:nowrap}
td.poste{min-width:186px}
/* statut : une pastille discrete, lisible d'un coup d'oeil dans la colonne */
.st{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:var(--tint);border:1px solid var(--line)}
.st-postulee{color:var(--acc)}.st-entretien{color:var(--ok);border-color:var(--ok)}
.st-refus{color:var(--ko)}.st-accepte{color:var(--ok);border-color:var(--ok);font-weight:600}
.st-ecartee{color:var(--mut)}
td strong{font-weight:600}
th:first-child,td:first-child{padding-left:16px}
.score{display:flex;align-items:center;gap:9px;min-width:112px}
.score i{flex:1;height:7px;border-radius:99px;background:var(--line);overflow:hidden;display:block}
.score i b{display:block;height:100%;border-radius:99px;animation:fill .5s cubic-bezier(.2,.8,.3,1)}
@keyframes fill{from{width:0}}
.tag{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:500;
 border:1px solid currentColor;white-space:nowrap;background:color-mix(in oklab,currentColor 10%,transparent)}
.postuler{color:var(--ok)}.a_etudier{color:var(--mid)}.ne_pas_postuler{color:var(--ko)}.mut{color:var(--mut)}
a{color:var(--acc);text-underline-offset:2px}
.blk{border-left:3px solid var(--ko);padding:4px 0 4px 11px;margin-bottom:6px;overflow-wrap:anywhere}
.grid-row{padding:8px 0;border-bottom:1px solid var(--line)}.grid-row:last-child{border-bottom:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:15px 17px;margin-bottom:12px;
 box-shadow:var(--sh1);transition:border-color var(--t),box-shadow var(--t),transform var(--t)}
.card.pick:hover{border-color:var(--acc);box-shadow:var(--sh2);transform:translateY(-1px)}
.card.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc),var(--sh2)}
.pre{white-space:pre-wrap;overflow-wrap:anywhere}
h2{font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 4px}
h3{font-size:12px;margin:18px 0 5px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.b{text-decoration:none;display:inline-block;font:inherit;padding:7px 13px;border-radius:var(--r2);
 border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;
 transition:border-color var(--t),background var(--t),transform var(--t),box-shadow var(--t)}
.b:hover{border-color:var(--acc);box-shadow:var(--sh1);transform:translateY(-1px)}
.b:active{transform:translateY(0) scale(.98)}
.b[disabled]{opacity:.45;cursor:default;transform:none;box-shadow:none;border-color:var(--line)}
.b.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.b.primary:hover{filter:brightness(1.07)}
.chips span{display:inline-block;background:var(--tint);border:1px solid var(--line);border-radius:99px;
 padding:3px 11px;margin:2px;font-size:13px}
.empty{padding:40px;text-align:center;color:var(--mut)}
#panel{flex:0 0 var(--panelw,clamp(340px,32vw,560px));min-width:0;display:none;overflow:auto;overscroll-behavior:contain;
       background:var(--card);border-left:1px solid var(--line);padding:18px 22px 48px}
body.panel-open #panel{display:block;animation:slide .2s cubic-bezier(.2,.8,.3,1)}
@keyframes slide{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
.panel-head{position:sticky;top:-18px;z-index:2;background:var(--card);margin:-18px -22px 12px;padding:14px 22px 10px;border-bottom:1px solid var(--line)}
.panel-head .bar{margin:8px 0 0}
#pdfhost{display:none}
/* selecteurs alignes sur "body.panel-open #panel" : sinon cette regle-la (1,1,1)
   l'emporte sur "#panel.flush" (1,1,0) et le panneau ne passe jamais en flex */
body.panel-open #panel.flush{padding:0;display:flex;flex-direction:column;overflow:hidden}
body.panel-open #panel.flush #panelbody{flex:0 0 auto;padding:11px 15px;border-bottom:1px solid var(--line);overflow:auto;max-height:40%}
body.panel-open #panel.flush .panel-head{position:static;margin:0;padding:0;border:0;background:none}
body.panel-open #panel.flush #pdfhost{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
#pdfbar{flex:0 0 auto;display:flex;gap:6px;align-items:center;padding:7px 11px;border-bottom:1px solid var(--line);font-size:13px;color:var(--mut)}
#pdfbar .b{padding:4px 10px;font-size:13px}
#pdfview{flex:1 1 auto;min-height:0;overflow:auto;background:#31363e;padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px}
.pdfpage{position:relative;box-shadow:0 3px 14px rgba(0,0,0,.45);background:#fff;flex:0 0 auto;border-radius:3px;overflow:hidden}
.pdfpage canvas{display:block}
/* couche texte : invisible, mais selectionnable et trouvable au Ctrl+F */
.pdfpage .tl{position:absolute;inset:0;overflow:hidden;opacity:1;line-height:1;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:transparent}
.pdfpage .tl span,.pdfpage .tl br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.pdfpage .tl ::selection{background:rgba(0,116,255,.35)}
.pdfpage .tl span.markedContent{top:0;height:0}
main.kanban-mode{overflow:hidden;display:flex;flex-direction:column;padding-bottom:16px}
#kanban{flex:1 1 auto;min-height:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);gap:10px;align-items:stretch;overflow-x:auto;padding-bottom:4px}
.kcol{background:var(--card);border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;min-height:0;
 box-shadow:var(--sh1);transition:border-color var(--t),box-shadow var(--t)}
.kh{flex:0 0 auto;display:flex;justify-content:space-between;gap:8px;padding:10px 13px;border-bottom:1px solid var(--line);
    font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600}
.kh .n{color:var(--fg);font-weight:700}
.klist{flex:1 1 auto;min-height:60px;overflow-y:auto;overscroll-behavior:contain;padding:9px;display:flex;flex-direction:column;gap:9px}
.kcol.over{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc),var(--sh2)}
.kcard{background:var(--bg);border:1px solid var(--line);border-radius:var(--r2);padding:9px 11px;cursor:grab;
 user-select:none;display:flex;flex-direction:column;gap:3px;transition:transform var(--t),box-shadow var(--t),border-color var(--t)}
.kcard:hover{transform:translateY(-1px);box-shadow:var(--sh2);border-color:var(--acc)}
.kcard:active{cursor:grabbing}
.kcard.drag{opacity:.35;transform:rotate(1.5deg) scale(.98)}
.kcard.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.kcard .t{font-weight:600;font-size:14px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.kcard .m{font-size:12px;color:var(--mut)}
.karch{flex:0 0 auto;margin-top:10px;border:1px dashed var(--line);border-radius:var(--r);padding:10px 13px;color:var(--mut);font-size:13px;text-align:center;transition:all var(--t)}
main.chat-mode{overflow:hidden;display:flex;flex-direction:column;padding-bottom:16px}
#chatlog{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 2px 12px;display:flex;flex-direction:column}
.msg{max-width:min(720px,86%);padding:10px 14px;border-radius:16px;margin-bottom:10px;white-space:pre-wrap;
 overflow-wrap:anywhere;line-height:1.5;box-shadow:var(--sh1)}
.msg.user{background:var(--acc);color:#fff;align-self:flex-end;border-bottom-right-radius:5px}
.msg.claude{background:var(--card);border:1px solid var(--line);align-self:flex-start;border-bottom-left-radius:5px}
.msg .h{font-size:11px;opacity:.72;margin-bottom:3px}
.pending{align-self:flex-start;color:var(--mut);font-size:13px;padding:4px 2px 8px}
.pending b{display:inline-block;width:6px;height:6px;border-radius:99px;background:var(--mid);margin-right:5px;animation:bl 1s ease-in-out infinite}
@keyframes bl{0%,100%{opacity:.25}50%{opacity:1}}
#chatbar{flex:0 0 auto;display:flex;gap:8px;align-items:flex-end;padding-top:11px;border-top:1px solid var(--line)}
#f-chat{flex:1 1 auto;min-height:46px;max-height:180px;resize:vertical;font:inherit;padding:10px 12px;
 border:1px solid var(--line);border-radius:var(--r);background:var(--card);color:var(--fg);
 transition:border-color var(--t),box-shadow var(--t)}
#f-chat:focus{outline:0;border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}
#f-chat:disabled{opacity:.6}
.qbox{align-self:flex-start;max-width:min(720px,86%);margin:-4px 0 12px;padding:12px 14px;border:1px solid var(--acc);
 border-radius:var(--r);background:var(--tint);box-shadow:var(--sh1)}
.qbox .qt{font-size:11px;color:var(--acc);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;font-weight:600}
.qopt{display:block;width:100%;text-align:left;margin-bottom:7px;padding:9px 12px;border:1px solid var(--line);
 border-radius:var(--r2);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;
 transition:border-color var(--t),transform var(--t),box-shadow var(--t)}
.qopt:hover{border-color:var(--acc);transform:translateX(3px);box-shadow:var(--sh1)}
.qopt.sel{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
.qopt b{display:block;font-weight:600}
.qopt span{color:var(--mut);font-size:13px}
.qbox input[type=text]{width:100%;margin-top:5px}
.karch.over{border-color:var(--ko);color:var(--ko);background:color-mix(in oklab,var(--ko) 8%,transparent)}
/* entree en scene, uniquement au changement d'onglet : un rendu declenche par
   le sondage ne doit pas refaire danser toute la liste. */
main.anim>*{animation:enter .26s cubic-bezier(.2,.8,.3,1) backwards}
main.anim>*:nth-child(2){animation-delay:.04s}
main.anim>*:nth-child(3){animation-delay:.08s}
main.anim>*:nth-child(n+4){animation-delay:.12s}
@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){
 *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
}
@media(max-width:900px){
 body{height:auto;overflow:auto;display:block}
 #shell{display:block}main{overflow:visible}main.kanban-mode{overflow:visible;height:auto}
 main.chat-mode{height:78vh}
 #kanban{overflow-x:auto;grid-auto-columns:minmax(78vw,1fr);max-height:70vh}
 body.panel-open{overflow:hidden}
 #panel{position:fixed;top:0;right:0;bottom:0;left:auto;width:min(560px,100%);z-index:20;box-shadow:var(--sh3)}
 #panel.flush{height:100dvh}
 #themepop{right:12px}
}
</style></head><body>
<header><h1>Recherche d'emploi <span class="ver" id="ver"></span> <span class="watch" id="watch"></span><button id="themebtn" title="Couleurs de l'interface"><i></i>Theme</button></h1>
<div class="stats" id="stats"></div><div class="acts" id="acts"></div><div class="feed" id="feed"></div><nav id="nav"></nav></header>
<div id="shell"><main id="main"></main><div id="grip" title="Glisser pour redimensionner, double-clic pour revenir au defaut"></div>
<aside id="panel"><div id="panelbody"></div><div id="pdfhost"><div id="pdfbar"></div><div id="pdfview"></div></div></aside></div>
<div id="modal"><div id="modalbox"></div></div>
<div id="themepop"></div>
<script>
// applique le theme avant le premier rendu, sinon la page clignote en clair
// puis bascule en sombre sous les yeux de l'utilisateur.
(function(){try{
 var r=document.documentElement;
 r.dataset.mode=localStorage.getItem('jobsearch.mode')||'auto';
 r.dataset.theme=localStorage.getItem('jobsearch.theme')||'bleu';
}catch(e){}})();
</script>
<script>
var S={offers:[],searches:[],letters:[],cvs:[],cv:null,actions:[],audits:[],messages:[],questions:[],deps:{},version:'',watcher_alive:false,pdfjs:false};
var tab='offres',filt={q:'',champ:'',reco:'',status:'',min:0,cv:'',contrat:''},kfilt={q:'',champ:'',cv:'',min:0},openId=null,openSearchId=null,cvView=null;
var dragging=false,resizing=false,lockUntil=0,last='',tabRendu=null;
var RECO={postuler:'Postuler',a_etudier:'À étudier',ne_pas_postuler:'Ne pas postuler'};
var SITE={hellowork:'HelloWork',indeed:'Indeed',les_deux:'HelloWork et Indeed'};
var CONTRAT=[['tous','Tous les contrats'],['cdi','CDI'],['cdd','CDD'],['alternance','Alternance'],
             ['stage','Stage'],['interim','Interim'],['temps_partiel','Temps partiel']];
var CONTRAT_NOM={};CONTRAT.forEach(function(x){CONTRAT_NOM[x[0]]=x[1];});
function nomContrat(v){return v?(CONTRAT_NOM[v]||v):'';}
// Reconnait le contrat d'une annonce a partir de son texte libre : les sites
// ecrivent "CDI", "C.D.I.", "Contrat a duree indeterminee", "Alternance"...
// Aucune contre-oblique dans ce bloc : PAGE est un litteral gabarit, et une
// classe comme [.\-_] y perdrait son echappement avant d'arriver au navigateur.
// Le premier passage ne garde que les lettres ; compact recolle les sigles
// ecrits avec des points ou des espaces, "C.D.I." aussi bien que "C D I".
function typeContrat(t){
 var x=String(t||'').toLowerCase().replace(/[^a-zà-öø-ÿ]+/g,' ').trim();
 var mots=' '+x+' ', compact=x.replace(/ /g,'');
 if(/altern|apprentis|professionnalisation/.test(x))return 'alternance';
 if(/stage|stagiaire|internship/.test(x))return 'stage';
 if(/int[ée]rim|interim|mission temporaire/.test(x))return 'interim';
 if(/temps partiel|mi temps|part time/.test(x))return 'temps_partiel';
 if(mots.indexOf(' cdd ')>=0||/dur[ée]ed[ée]termin/.test(compact)||compact.indexOf('cdd')===0)return 'cdd';
 if(mots.indexOf(' cdi ')>=0||/dur[ée]eind[ée]termin/.test(compact)||compact.indexOf('cdi')===0)return 'cdi';
 return '';
}
function nomSite(v){return SITE[v]||v||'';}
var STAT={a_postuler:'À postuler',postulee:'Postulée',entretien:'Entretien',refus:'Refus',accepte:'Acceptée',ecartee:'Écartée',nouvelle:'Nouvelle'};
var KAN=[['a_postuler','À postuler'],['postulee','Postulée'],['entretien','Entretien'],['refus','Refus'],['accepte','Acceptée']];
var APPLIED=['postulee','entretien','refus','accepte'];
function h(t,a){var e=document.createElement(t);a=a||{};for(var k in a){if(k==='text')e.textContent=a[k];else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),a[k]);else if(a[k]!=null)e.setAttribute(k,a[k]);}
for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null)continue;e.appendChild(typeof c==='string'?document.createTextNode(c):c);}return e;}
function d(s){return s?new Date(s).toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric'}):'';}
function col(n){return n>=75?'var(--ok)':n>=50?'var(--mid)':'var(--ko)';}
function score(n){var b=h('b');b.style.width=n+'%';b.style.background=col(n);return h('div',{class:'score'},h('strong',{text:n+'%'}),h('i',{},b));}
function safe(u){return /^https?:\\/\\//i.test(u||'')?u:'#';}
function copy(t,btn){navigator.clipboard.writeText(t).then(function(){var o=btn.textContent;btn.textContent='Copié !';setTimeout(function(){btn.textContent=o;},1200);});}
function sel(opts,val,fn){var s=h('select',{onchange:function(){fn(s.value);}});opts.forEach(function(o){var e=h('option',{value:o[0],text:o[1]});if(String(o[0])===String(val))e.selected=true;s.appendChild(e);});return s;}
function cvOpts(){return [['','Tous les CV']].concat(S.cvs.map(function(c){return [String(c.id),c.filename];}));}
// Choix du champ filtre : vide = les trois a la fois, comportement d'origine.
var CHAMPS=[['','Partout'],['title','Poste'],['company','Entreprise'],['location','Ville']];
var CHAMP_PH={'':'Filtrer sur le poste, l\\'entreprise ou la ville','title':'Filtrer sur le poste','company':'Filtrer sur l\\'entreprise','location':'Filtrer sur la ville'};
function matchTxt(o,q,champ){
 if(!q)return true;
 var v=champ?String(o[champ]||''):[o.title,o.company,o.location].join(' ');
 return v.toLowerCase().indexOf(q.toLowerCase())>=0;
}
function del(path,then){
 fetch(path,{method:'DELETE'}).then(function(r){return r.json();}).then(function(j){
  if(j&&j.error){alert(j.error);return;}last='';lockUntil=0;if(then)then(j);load();});
}
// Suppression en deux temps : le bouton devient "Confirmer ?" pendant 4 s.
function delBtn(label,confirmer,fn){
 var b=h('button',{class:'b del',text:label,onclick:function(){
  if(b.dataset.armed){delete b.dataset.armed;fn();return;}
  b.dataset.armed='1';var o=b.textContent;b.textContent=confirmer;
  setTimeout(function(){if(b.dataset.armed){delete b.dataset.armed;b.textContent=o;}},4000);
 }});
 return b;
}
function closeX(fn){return h('button',{class:'x',title:'Fermer','aria-label':'Fermer',text:'×',onclick:fn});}
// Les annonces donnent la date en JJ/MM/AAAA ou AAAA-MM-JJ, parfois suivie d'une
// reference. On normalise pour la colonne, le texte brut reste en infobulle.
function dPub(v){
 if(!v)return '';
 var t=String(v).split(/\\s+-\\s+/)[0].trim();
 var m=t.match(/^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/);
 if(m)return d(m[3]+'-'+m[2]+'-'+m[1]);
 if(/^\\d{4}-\\d{2}-\\d{2}/.test(t))return d(t);
 return t.length>16?t.slice(0,15)+'…':t;
}
// "Estimation Hellowork : 41 200 - 66 200 EUR / an (non affiche)" -> "est. 41 200 - 66 200 EUR/an"
function sal(v){
 if(!v)return '';
 var t=String(v).replace(/\\([^)]*\\)/g,' ').replace(/\\s+/g,' ').trim();
 var est=/estimation/i.test(String(v));
 var m=t.match(/(\\d[\\d\\s ]{2,})\\s*[-–aà]\\s*(\\d[\\d\\s ]{2,})\\s*(?:€|EUR)?\\s*\\/?\\s*(an|jour|mois)?/i);
 if(m){
  var u=m[3]?('/'+m[3].toLowerCase()):'';
  return (est?'est. ':'')+m[1].replace(/\\s+/g,' ').trim()+' - '+m[2].replace(/\\s+/g,' ').trim()+' €'+u;
 }
 return t.length>22?t.slice(0,21)+'…':t;
}
function post(path,body,then){fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(then||function(){last='';load();});}

var VIEWS={
 offres:{left:vOffres,right:pOffer},
 suivi:{left:vKanban,right:pOffer},
 historique:{left:vHist,right:pSearch},
 cv:{left:vCvList,right:pCv},
 lettres:{left:vLettres,right:pOffer},
 chat:{left:vChat,right:pOffer},
 systeme:{left:vDeps,right:pOffer}
};
function load(){
 if(dragging||resizing||Date.now()<lockUntil)return;
 fetch('/api/state').then(function(r){return r.json();}).then(function(j){var k=JSON.stringify(j);if(k===last)return;last=k;S=j;render();});
}

/* ---- separateur : une largeur memorisee par contexte ---- */
function wKey(){return 'jobsearch.panelw.'+(tab==='cv'?'cv':'std');}
function wDefault(){return tab==='cv'?'min(62vw, 900px)':'clamp(340px,32vw,560px)';}
function applyWidth(){
 var v=null;try{v=localStorage.getItem(wKey());}catch(e){}
 document.documentElement.style.setProperty('--panelw',v||wDefault());
}
(function grip(){
 var g=document.getElementById('grip');
 g.addEventListener('pointerdown',function(e){
  e.preventDefault();g.setPointerCapture(e.pointerId);
  resizing=true;g.classList.add('on');document.body.classList.add('resizing');
 });
 g.addEventListener('pointermove',function(e){
  if(!resizing)return;
  var w=Math.min(Math.max(320,window.innerWidth-e.clientX),Math.max(360,window.innerWidth-380));
  document.documentElement.style.setProperty('--panelw',w+'px');
 });
 function stop(e){
  if(!resizing)return;
  resizing=false;g.classList.remove('on');document.body.classList.remove('resizing');
  try{g.releasePointerCapture(e.pointerId);}catch(err){}
  try{localStorage.setItem(wKey(),getComputedStyle(document.getElementById('panel')).width);}catch(err){}
  pdfRefit();
 }
 g.addEventListener('pointerup',stop);g.addEventListener('pointercancel',stop);
 g.addEventListener('dblclick',function(){try{localStorage.removeItem(wKey());}catch(e){}applyWidth();pdfRefit();});
})();

/* ---- actions : le dashboard demande, Claude execute ---- */
function queue(type,payload,label,btn){
 if(btn){btn.disabled=true;var o=btn.textContent;btn.textContent='demande...';setTimeout(function(){btn.textContent=o;btn.disabled=!S.watcher_alive;},2500);}
 fetch('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type,payload:payload||null,label:label||null})})
  .then(function(r){return r.json();}).then(function(){last='';load();});
}
function actBtn(label,type,payload){
 var b=h('button',{class:'b',text:label,onclick:function(){queue(type,payload,label,b);}});
 if(!S.watcher_alive){b.setAttribute('disabled','');b.setAttribute('title','Claude n\\'ecoute pas : lance le skill recherche-emploi dans Claude Code');}
 return b;
}
function openBtn(label,fn){
 var b=h('button',{class:'b',text:label,onclick:fn});
 if(!S.watcher_alive){b.setAttribute('disabled','');b.setAttribute('title','Claude n\\'ecoute pas : lance le skill recherche-emploi dans Claude Code');}
 return b;
}
function renderActs(){
 var a=document.getElementById('acts');a.replaceChildren();
 a.appendChild(openBtn('Lancer une recherche',searchForm));
 a.appendChild(actBtn('Rescanner le dossier cv/','scan-cv'));
 a.appendChild(openBtn('Vérifier les dépendances',function(){
  queue('check-deps',null,'Vérifier les dépendances');
  tab='systeme';render();
 }));
 var f=document.getElementById('feed');f.replaceChildren();
 var STA={pending:'en attente',taken:'prise en charge',done:'faite',failed:'echouee'};
 var cut=function(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'\\u2026':s;};
 // les messages du chat sont deja visibles dans leur onglet : hors bandeau
 (S.actions||[]).filter(function(x){return x.type!=='message';}).slice(0,3).forEach(function(x){
  f.appendChild(h('span',{title:(x.label||x.type)+(x.result?' - '+x.result:'')},
   h('b',{text:cut(x.label||x.type,38)+' : '}),
   h('span',{class:x.status,text:STA[x.status]||x.status}),
   x.result?h('span',{text:' - '+cut(x.result,50)}):null));
 });
}
// Le headline d'un CV ("Administrateur systemes - 8 ans / certifie X") n'est pas
// une requete de recherche : on ne garde que le premier segment.
function guessPoste(p,lastS){
 var t=String(p.headline||'').split(/\\s+[-\\/|]\\s+/)[0].trim();
 if(!t&&p.experiences&&p.experiences.length)t=String(p.experiences[0].title||'').trim();
 return t||lastS.title||'';
}
// "44000 Nantes, France" -> "Nantes 44000", le format attendu par les deux sites.
function guessVille(p,lastS){
 var v=String(p.location||lastS.location||'').replace(/,\\s*France\\s*$/i,'').trim();
 var m=v.match(/^(\\d{5})[\\s,]+(.+)$/);
 return m?(m[2].trim()+' '+m[1]):v;
}
function searchForm(){
 var cv=(S.cvs||[]).filter(function(c){return c.is_active;})[0]||(S.cvs||[])[0]||null;
 var p=cv?(cv.profile||{}):{};
 var lastS=(S.searches||[])[0]||{};
 var box=document.getElementById('modalbox');box.replaceChildren();
 box.appendChild(h('h2',{text:'Lancer une recherche'}));
 box.appendChild(h('div',{class:'mut',style:'font-size:13px',text:cv?('CV utilise : '+cv.filename):'Aucun CV en base'}));
 var poste=h('input',{value:guessPoste(p,lastS)});
 var ville=h('input',{value:guessVille(p,lastS),placeholder:'Ville et code postal'});
 var obj=sel([['5','5 offres'],['10','10 offres'],['15','15 offres']],String(lastS.target_count||10),function(){majPlaf();});
 var plaf=h('select');
 // Le plafond suit l'objectif : 2x, 4x (defaut) et 6x. Il ne peut donc jamais
 // etre inferieur a l'objectif, la regle que start-search fait respecter.
 function majPlaf(){
  var n=Number(obj.value),cur=Number(plaf.value)||0;
  plaf.replaceChildren();
  [2,4,6].forEach(function(k){
   var v=n*k;
   plaf.appendChild(h('option',{value:String(v),text:v+' annonces'+(k===4?' (conseille)':'')}));
  });
  plaf.value=String(cur&&cur%n===0?cur:n*4);
  if(!plaf.value)plaf.value=String(n*4);
 }
 majPlaf();
 var site=sel([['hellowork','HelloWork (recommande)'],['indeed','Indeed'],['les_deux','Les deux, HelloWork puis Indeed']],lastS.site||'hellowork',function(){});
 var contrat=sel(CONTRAT,lastS.contract_wanted||'tous',function(){});
 [['Poste recherche',poste],['Ou (ville + code postal)',ville],['Type de contrat',contrat],
  ['Objectif : offres a enregistrer',obj],['Plafond : annonces a lire au maximum',plaf],['Site',site]].forEach(function(x){
   box.appendChild(h('label',{text:x[0]}));box.appendChild(x[1]);});
 var err=h('div',{class:'err'});
 box.appendChild(err);
 box.appendChild(h('div',{class:'bar',style:'margin-top:14px'},
  h('button',{class:'b',text:'Lancer',onclick:function(){
   err.textContent='';
   if(!poste.value.trim()){err.textContent='Indique le poste recherche.';return;}
   if(!ville.value.trim()){err.textContent='Indique la ville et le code postal.';return;}
   if(Number(plaf.value)<Number(obj.value)){err.textContent='Le plafond ('+plaf.value+') doit etre au moins egal a l\\'objectif ('+obj.value+').';return;}
   queue('new-search',{title:poste.value.trim(),location:ville.value.trim(),site:site.value,
    contract_wanted:contrat.value,
    target_count:Number(obj.value),max_seen:Number(plaf.value),cv_id:cv?cv.id:null},
    'Recherche '+poste.value.trim());
   document.body.classList.remove('modal-open');
  }}),
  h('button',{class:'b',text:'Annuler',onclick:function(){document.body.classList.remove('modal-open');}})));
 document.body.classList.add('modal-open');
 poste.focus();
}
document.getElementById('modal').addEventListener('click',function(e){if(e.target.id==='modal')document.body.classList.remove('modal-open');});
document.addEventListener('keydown',function(e){if(e.key==='Escape')document.body.classList.remove('modal-open');});

/* ---- visionneuse PDF (PDF.js embarque) ---- */
var pdfLib=null,pdfDoc=null,pdfKey=null,pdfUrl=null,pdfScale=null,pdfFit=true,pdfToken=0;
function pdfLoad(){
 if(pdfLib)return Promise.resolve(pdfLib);
 return import('/vendor/pdf.min.mjs').then(function(m){
  m.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.min.mjs';pdfLib=m;return m;});
}
function pdfFail(msg){
 var v=document.getElementById('pdfview');v.replaceChildren();
 v.appendChild(h('div',{class:'empty',style:'color:#ddd'},msg+' ',
  h('a',{href:pdfUrl||'#',target:'_blank',rel:'noopener noreferrer',text:'ouvrir le PDF directement'})));
}
function pdfShow(key,url){
 var tok=++pdfToken;pdfUrl=url;
 pdfLoad().then(function(lib){
  if(tok!==pdfToken)return;
  if(pdfKey===key&&pdfDoc)return pdfDraw(tok);
  return lib.getDocument({url:url}).promise.then(function(doc){
   if(tok!==pdfToken)return;
   pdfDoc=doc;pdfKey=key;pdfFit=true;pdfScale=null;return pdfDraw(tok);});
 }).catch(function(e){if(tok===pdfToken)pdfFail('Visionneuse indisponible ('+e.message+').');});
}
function pdfDraw(tok){
 var view=document.getElementById('pdfview');
 if(!pdfDoc||tok!==pdfToken)return;
 var fit=pdfFit||pdfScale==null;
 var ratio=view.scrollHeight>0?view.scrollTop/view.scrollHeight:0;
 var pages=[];
 for(var n=1;n<=pdfDoc.numPages;n++)pages.push(pdfDoc.getPage(n));
 return Promise.all(pages).then(function(ps){
  if(tok!==pdfToken)return;
  var base=ps[0].getViewport({scale:1});
  var scale=fit?Math.max(0.2,(view.clientWidth-24)/base.width):pdfScale;
  var dpr=window.devicePixelRatio||1;
  // On construit et on attache d'abord : la couche texte se mesure dans le DOM.
  var items=ps.map(function(page){
   var vp=page.getViewport({scale:scale});
   var wrap=h('div',{class:'pdfpage'});
   wrap.style.width=Math.floor(vp.width)+'px';wrap.style.height=Math.floor(vp.height)+'px';
   var cv=h('canvas');
   cv.width=Math.floor(vp.width*dpr);cv.height=Math.floor(vp.height*dpr);
   cv.style.width=Math.floor(vp.width)+'px';cv.style.height=Math.floor(vp.height)+'px';
   wrap.appendChild(cv);
   return {page:page,vp:vp,wrap:wrap,cv:cv};
  });
  view.replaceChildren.apply(view,items.map(function(i){return i.wrap;}));
  pdfScale=scale;pdfBar();
  view.scrollTop=ratio*view.scrollHeight;
  var chain=Promise.resolve();
  items.forEach(function(it){
   chain=chain.then(function(){
    if(tok!==pdfToken)return;
    return it.page.render({canvasContext:it.cv.getContext('2d'),viewport:it.vp,
     transform:dpr!==1?[dpr,0,0,dpr,0,0]:null}).promise.then(function(){
     if(tok!==pdfToken||!pdfLib.TextLayer)return;
     return it.page.getTextContent().then(function(tc){
      if(tok!==pdfToken)return;
      var tl=h('div',{class:'tl'});
      tl.style.setProperty('--scale-factor',String(scale));
      it.wrap.appendChild(tl);
      return new pdfLib.TextLayer({textContentSource:tc,container:tl,viewport:it.vp}).render();
     });
    });
   }).catch(function(){});   // un rendu annule ne doit pas casser la chaine
  });
  return chain;
 }).catch(function(e){if(tok===pdfToken)pdfFail('Rendu impossible ('+e.message+').');});
}
function pdfZoom(mult){
 if(!pdfDoc)return;
 pdfFit=false;pdfScale=Math.min(3,Math.max(0.5,(pdfScale||1)*mult));
 pdfDraw(++pdfToken);
}
// pdfFit est un mode, pas une valeur : pdfScale garde toujours l'echelle courante
// (affichee dans la barre), sinon le re-ajustement au redimensionnement est perdu.
function pdfFitNow(){pdfFit=true;pdfDraw(++pdfToken);}
function pdfRefit(){if(pdfDoc&&pdfFit&&tab==='cv')pdfDraw(++pdfToken);}
function pdfBar(){
 var b=document.getElementById('pdfbar');if(!b)return;
 b.replaceChildren();
 if(!pdfDoc)return;
 b.appendChild(h('span',{text:pdfDoc.numPages+' page(s)'}));
 b.appendChild(h('button',{class:'b',text:'-',title:'Reduire',onclick:function(){pdfZoom(1/1.25);}}));
 b.appendChild(h('span',{text:Math.round((pdfScale||1)*100)+' %'}));
 b.appendChild(h('button',{class:'b',text:'+',title:'Agrandir',onclick:function(){pdfZoom(1.25);}}));
 b.appendChild(h('button',{class:'b',text:'Ajuster',onclick:pdfFitNow}));
 b.appendChild(h('a',{class:'b',href:pdfUrl||'#',target:'_blank',rel:'noopener noreferrer',text:'Ouvrir'}));
}
(function(){
 var t=null;
 new ResizeObserver(function(){
  clearTimeout(t);
  t=setTimeout(function(){if(!resizing)pdfRefit();},150);
 }).observe(document.getElementById('pdfview'));
})();
function snapshot(){
 var m=document.getElementById('main'),k=document.getElementById('kanban');
 // un rendu declenche par le sondage ne doit pas voler la saisie en cours :
 // on retient le champ actif et la position du curseur pour les rendre apres.
 var a=document.activeElement,foc=null;
 if(a&&a.id&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')){
  foc={id:a.id,val:a.value,debut:null,fin:null};
  try{foc.debut=a.selectionStart;foc.fin=a.selectionEnd;}catch(e){}
 }
 return {main:m.scrollTop,panel:document.getElementById('panel').scrollTop,kx:k?k.scrollLeft:0,
  cols:k?[].map.call(k.querySelectorAll('.klist'),function(l){return l.scrollTop;}):[],foc:foc};
}
function restore(s){
 document.getElementById('main').scrollTop=s.main;
 document.getElementById('panel').scrollTop=s.panel;
 if(s.foc){
  var e=document.getElementById(s.foc.id);
  if(e){
   if(e.value!==s.foc.val)e.value=s.foc.val;
   e.focus();
   if(s.foc.debut!=null){try{e.setSelectionRange(s.foc.debut,s.foc.fin);}catch(err){}}
  }
 }
 var k=document.getElementById('kanban');if(!k)return;
 k.scrollLeft=s.kx;
 [].forEach.call(k.querySelectorAll('.klist'),function(l,i){if(s.cols[i]!=null)l.scrollTop=s.cols[i];});
}
function render(){
 var snap=snapshot();
 document.getElementById('ver').textContent=S.version?'v'+S.version:'';
 var w=document.getElementById('watch');w.replaceChildren();
 w.appendChild(h('span',{class:'dot'+(S.watcher_alive?' on':'')}));
 w.appendChild(h('span',{text:S.watcher_alive?('Claude ecoute'+(S.watcher_pid?' (PID '+S.watcher_pid+(S.watcher_started_at?', depuis '+dHeure(S.watcher_started_at):'')+')':'')):'Claude hors ligne'}));
 w.setAttribute('title',S.watcher_alive?'Les boutons d\\'action sont actifs.':'Lance le skill recherche-emploi dans Claude Code pour activer les boutons.');
 renderActs();
 var st=document.getElementById('stats');st.replaceChildren();
 var good=S.offers.filter(function(o){return o.recommendation==='postuler';}).length;
 var app=S.offers.filter(function(o){return APPLIED.indexOf(o.status)>=0;}).length;
 var itw=S.offers.filter(function(o){return o.status==='entretien';}).length;
 [['Offres',S.offers.length],['Conseillées',good],['Candidatures',app],['Entretiens',itw],['Recherches',S.searches.length],['Lettres',S.letters.length]]
  .forEach(function(x){st.appendChild(h('div',{class:'stat'},h('b',{text:String(x[1])}),h('span',{text:x[0]})));});
 var nav=document.getElementById('nav');nav.replaceChildren();
 [['offres','Offres'],['suivi','Suivi'],['historique','Historique'],['cv','CV'],['lettres','Lettres'],['chat','Chat'],['systeme','Systeme']].forEach(function(x){
  nav.appendChild(h('button',{class:tab===x[0]?'on':'',text:x[1],onclick:function(){tab=x[0];render();}}));});
 var m=document.getElementById('main');m.replaceChildren();
 var neuf=(tab!==tabRendu);tabRendu=tab;
 m.className=(tab==='suivi'?'kanban-mode':tab==='chat'?'chat-mode':'')+(neuf?' anim':'');
 VIEWS[tab].left(m);
 renderPanel();
 restore(snap);
}
function renderPanel(){
 var p=document.getElementById('panel'),b=document.getElementById('panelbody');
 b.replaceChildren();p.className='';
 var open=VIEWS[tab].right(b,p);
 document.body.classList.toggle('panel-open',!!open);
 applyWidth();
}

/* ---- onglet Offres ---- */
// --- colonnes redimensionnables ------------------------------------------
// Les intitules d'annonces sont longs et personne n'a la meme idee de ce qui
// merite de la place. Chaque colonne se tire a la souris et sa largeur est
// gardee dans le navigateur, par tableau. Double-clic sur la poignee : retour
// a la largeur par defaut.
var COLS_MIN = 56;

function colsLues(cle, defauts) {
 var w = defauts.slice();
 try {
  var v = JSON.parse(localStorage.getItem('jobsearch.cols.' + cle) || 'null');
  if (Array.isArray(v) && v.length === defauts.length) {
   v.forEach(function(x, i) { if (typeof x === 'number' && x >= COLS_MIN) w[i] = x; });
  }
 } catch (e) {}
 return w;
}
function colsEcrites(cle, w) {
 try { localStorage.setItem('jobsearch.cols.' + cle, JSON.stringify(w)); } catch (e) {}
}

// table : le <table>, deja rempli de son <thead>. defauts : une largeur par colonne.
function colonnesReglables(table, cle, defauts) {
 var w = colsLues(cle, defauts);
 var cg = h('colgroup');
 w.forEach(function(x) { cg.appendChild(h('col', { style: 'width:' + x + 'px' })); });
 table.insertBefore(cg, table.firstChild);
 table.classList.add('fixe');

 var ths = table.querySelectorAll('thead th');
 [].forEach.call(ths, function(th, i) {
  if (i >= w.length - 1) return;            // rien a tirer apres la derniere
  var poignee = h('i', { class: 'rz', title: 'Glisser pour redimensionner, double-clic pour revenir au defaut' });
  poignee.addEventListener('pointerdown', function(e) {
   e.preventDefault(); e.stopPropagation();
   poignee.setPointerCapture(e.pointerId);
   poignee.classList.add('on');
   resizing = true;                          // gele le sondage pendant le glissement
   var x0 = e.clientX, l0 = cg.children[i].getBoundingClientRect().width;
   function bouge(ev) {
    var n = Math.max(COLS_MIN, Math.round(l0 + ev.clientX - x0));
    w[i] = n; cg.children[i].style.width = n + 'px';
   }
   function lache(ev) {
    poignee.releasePointerCapture(ev.pointerId);
    poignee.removeEventListener('pointermove', bouge);
    poignee.removeEventListener('pointerup', lache);
    poignee.classList.remove('on');
    resizing = false; colsEcrites(cle, w);
   }
   poignee.addEventListener('pointermove', bouge);
   poignee.addEventListener('pointerup', lache);
  });
  poignee.addEventListener('dblclick', function(e) {
   e.preventDefault(); e.stopPropagation();
   w[i] = defauts[i]; cg.children[i].style.width = defauts[i] + 'px'; colsEcrites(cle, w);
  });
  th.appendChild(poignee);
 });
}

function vOffres(m){
 var multi=S.cvs.length>1;
 var q=h('input',{id:'f-offres',placeholder:CHAMP_PH[filt.champ],value:filt.q,oninput:function(){filt.q=q.value;body();}});
 q.style.flex='1';q.style.minWidth='170px';
 var bar=h('div',{class:'bar'},
  sel(CHAMPS,filt.champ,function(v){filt.champ=v;q.setAttribute('placeholder',CHAMP_PH[v]);body();}),q,
  sel([['','Tous les avis']].concat(Object.keys(RECO).map(function(k){return [k,RECO[k]];})),filt.reco,function(v){filt.reco=v;body();}),
  sel([['','Tous les statuts']].concat(KAN.concat([['ecartee','Écartée']])),filt.status,function(v){filt.status=v;body();}),
  sel([['','Tous les contrats']].concat(CONTRAT.slice(1)),filt.contrat,function(v){filt.contrat=v;body();}),
  sel([['0','Score mini'],['50','50 %'],['60','60 %'],['70','70 %'],['80','80 %']],String(filt.min),function(v){filt.min=Number(v);body();}));
 if(multi)bar.appendChild(sel(cvOpts(),filt.cv,function(v){filt.cv=v;body();}));
 m.appendChild(bar);
 var heads=['Score','Poste','Entreprise','Lieu','Contrat','Salaire','Publiée','Avis','Statut'].concat(multi?['CV']:[]).concat(['Trouvée le','Lien']);
 var tb=h('tbody'),head=h('tr');heads.forEach(function(t){head.appendChild(h('th',{text:t}));});
 var tbl=h('table',{},h('thead',{},head),tb);
 m.appendChild(h('div',{class:'wrap'},tbl));
 // 12 colonnes quand plusieurs CV coexistent, 11 sinon : les defauts suivent.
 var defs=[100,198,142,130,98,122,118,96,106].concat(multi?[98]:[]).concat([118,88]);
 colonnesReglables(tbl,multi?'offres12':'offres11',defs);
 function body(){
  tb.replaceChildren();
  var rows=S.offers.filter(function(o){
   return matchTxt(o,filt.q,filt.champ)
    &&(!filt.reco||o.recommendation===filt.reco)&&(!filt.status||o.status===filt.status)
    &&(!filt.contrat||typeContrat(o.contract)===filt.contrat)
    &&(!filt.cv||String(o.cv_id)===filt.cv)&&o.match_score>=filt.min;});
  if(!rows.length){tb.appendChild(h('tr',{},h('td',{colspan:String(heads.length),class:'empty',text:'Aucune offre pour le moment.'})));return;}
  rows.forEach(function(o){
   var tr=h('tr',{class:openId===o.id?'on':'',onclick:function(){openId=o.id;renderPanel();body();}},
    h('td',{},score(o.match_score)),
    h('td',{class:'poste'},h('strong',{text:o.title}),o.letters_count?h('div',{class:'mut',text:o.letters_count+' lettre(s)'}):null),
    h('td',{class:'cut w2',title:o.company||'',text:o.company||''}),
    h('td',{class:'cut',title:o.location||'',text:o.location||''}),
    h('td',{class:'cut',title:o.contract||'',text:o.contract||''}),
    h('td',{class:'cut',title:o.salary||'',text:sal(o.salary)}),
    h('td',{class:'nw',title:o.posted_at||'',text:dPub(o.posted_at)}),
    h('td',{},h('span',{class:'tag '+o.recommendation,text:RECO[o.recommendation]||o.recommendation})),
    h('td',{class:'nw'},h('span',{class:'st st-'+o.status,text:STAT[o.status]||o.status})));
   if(multi)tr.appendChild(h('td',{class:'mut cut w0',title:o.cv_filename||'',text:o.cv_filename||''}));
   tr.appendChild(h('td',{class:'nw',text:d(o.found_at)}));
   tr.appendChild(h('td',{},h('a',{href:safe(o.url),target:'_blank',rel:'noopener noreferrer',text:o.site||'ouvrir',onclick:function(e){e.stopPropagation();}})));
   tb.appendChild(tr);});}
 body();
}

/* ---- onglet Suivi (kanban) ---- */
function kanbanRows(){
 return S.offers.filter(function(o){
  return matchTxt(o,kfilt.q,kfilt.champ)
   &&(!kfilt.cv||String(o.cv_id)===kfilt.cv)&&o.match_score>=kfilt.min;});
}
function kcard(o){
 var c=h('article',{class:'kcard'+(openId===o.id?' on':''),draggable:'true','data-id':String(o.id),
  ondragstart:function(e){e.dataTransfer.setData('text/plain',String(o.id));e.dataTransfer.effectAllowed='move';dragging=true;c.classList.add('drag');},
  ondragend:function(){dragging=false;c.classList.remove('drag');},
  onclick:function(){openId=o.id;renderPanel();render();}});
 c.appendChild(h('div',{class:'t',text:'#'+o.id+' '+o.title}));
 c.appendChild(h('div',{class:'m',text:[o.company,o.location].filter(Boolean).join(' · ')}));
 c.appendChild(score(o.match_score));
 var meta=[o.contract,RECO[o.recommendation]].filter(Boolean).join(' · ');
 if(o.letters_count)meta+=(meta?' · ':'')+o.letters_count+' lettre(s)';
 if(o.notes)meta+=(meta?' · ':'')+'note';
 if(meta)c.appendChild(h('div',{class:'m',text:meta}));
 var applied=APPLIED.indexOf(o.status)>=0&&o.applied_at;
 var when=applied?('candidature le '+d(o.applied_at)):(o.status_updated_at?('déplacée le '+d(o.status_updated_at)):'');
 if(when)c.appendChild(h('div',{class:'m',text:when}));
 return c;
}
function dropZone(el,status){
 el.addEventListener('dragover',function(e){e.preventDefault();e.dataTransfer.dropEffect='move';el.classList.add('over');});
 el.addEventListener('dragleave',function(e){if(!el.contains(e.relatedTarget))el.classList.remove('over');});
 el.addEventListener('drop',function(e){e.preventDefault();el.classList.remove('over');
  var id=Number(e.dataTransfer.getData('text/plain'));dragging=false;if(id)moveOffer(id,status);});
}
function moveOffer(id,status){
 var o=S.offers.filter(function(x){return x.id===id;})[0];
 if(!o||o.status===status)return;
 o.status=status;o.status_updated_at=new Date().toISOString();
 if(APPLIED.indexOf(status)>=0&&!o.applied_at)o.applied_at=o.status_updated_at;
 lockUntil=Date.now()+2500;last='';
 render();
 fetch('/api/offers/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:status})})
  .then(function(){lockUntil=0;load();},function(){lockUntil=0;load();});
}
function vKanban(m){
 var q=h('input',{id:'f-suivi',placeholder:CHAMP_PH[kfilt.champ],value:kfilt.q,
  oninput:function(){kfilt.q=q.value;body();}});
 q.style.flex='1';q.style.minWidth='170px';
 var bar=h('div',{class:'bar'},
  sel(CHAMPS,kfilt.champ,function(v){kfilt.champ=v;q.setAttribute('placeholder',CHAMP_PH[v]);body();}),q,
  sel([['0','Score mini'],['50','50 %'],['60','60 %'],['70','70 %'],['80','80 %']],String(kfilt.min),function(v){kfilt.min=Number(v);body();}));
 if(S.cvs.length>1)bar.appendChild(sel(cvOpts(),kfilt.cv,function(v){kfilt.cv=v;body();}));
 bar.appendChild(h('span',{class:'mut',style:'font-size:13px',text:'Glisser-déposer entre colonnes, ou statut dans la fiche à droite.'}));
 m.appendChild(bar);
 var k=h('div',{id:'kanban'});
 var lists={},compteurs={};
 KAN.forEach(function(x){
  var list=h('div',{class:'klist'});
  var n=h('span',{class:'n',text:'0'});
  lists[x[0]]=list;compteurs[x[0]]=n;
  var c=h('section',{class:'kcol','data-status':x[0]},h('div',{class:'kh'},h('span',{text:x[1]}),n),list);
  dropZone(c,x[0]);
  k.appendChild(c);});
 m.appendChild(k);
 var arch=h('div',{class:'karch'});
 dropZone(arch,'ecartee');
 m.appendChild(arch);
 // ne reconstruit que les colonnes : la barre de filtre, et donc le champ de
 // saisie avec son focus, n'est jamais recree pendant la frappe.
 function body(){
  var rows=kanbanRows();
  KAN.forEach(function(x){
   var items=rows.filter(function(o){return o.status===x[0];});
   compteurs[x[0]].textContent=String(items.length);
   lists[x[0]].replaceChildren();
   if(!items.length)lists[x[0]].appendChild(h('div',{class:'mut',style:'font-size:13px;text-align:center;padding:8px 0',text:'-'}));
   items.forEach(function(o){lists[x[0]].appendChild(kcard(o));});
  });
  var nArch=rows.filter(function(o){return o.status==='ecartee';}).length;
  arch.textContent='Glisser ici pour écarter - '+nArch+' offre(s) écartée(s)';
 }
 body();
}

/* ---- panneau : fiche offre ---- */
function pOffer(b){
 if(openId==null)return false;
 var o=S.offers.filter(function(x){return x.id===openId;})[0];
 if(!o){openId=null;return false;}
 var head=h('div',{class:'panel-head'});
 head.appendChild(closeX(function(){openId=null;render();}));
 head.appendChild(h('h2',{style:'padding-right:32px',text:'#'+o.id+' '+o.title}));
 head.appendChild(h('div',{class:'mut',text:[o.company,o.location,o.contract,o.salary,o.remote,o.posted_at?'publiée le '+dPub(o.posted_at):null].filter(Boolean).join(' · ')}));
 head.appendChild(h('div',{class:'bar'},
  h('a',{class:'b',href:safe(o.url),target:'_blank',rel:'noopener noreferrer',text:'Voir l\\'annonce'}),
  sel(KAN.concat([['ecartee','Écartée']]),o.status,function(v){moveOffer(o.id,v);})));
 b.appendChild(head);
 b.appendChild(h('div',{style:'margin:4px 0 8px'},score(o.match_score)));
 b.appendChild(h('span',{class:'tag '+o.recommendation,text:RECO[o.recommendation]||''}));
 if(o.cv_filename)b.appendChild(h('div',{class:'mut',style:'font-size:13px;margin-top:6px',text:'Noté avec : '+o.cv_filename}));
 if(o.applied_at)b.appendChild(h('div',{class:'mut',style:'font-size:13px',text:'Candidature le '+d(o.applied_at)}));
 [['Conseil',o.advice],['Points forts',o.strengths],['Écarts avec le CV',o.gaps]].forEach(function(x){
  if(x[1]){b.appendChild(h('h3',{text:x[0]}));b.appendChild(h('div',{class:'pre',text:x[1]}));}});
 b.appendChild(h('h3',{text:'Notes de suivi'}));
 var ta=h('textarea',{id:'f-note',rows:'3',placeholder:'Relance envoyée le…, contact, retour d\\'entretien…'});
 ta.value=o.notes||'';ta.style.width='100%';ta.style.font='inherit';ta.style.padding='7px 10px';
 ta.style.border='1px solid var(--line)';ta.style.borderRadius='8px';ta.style.background='var(--card)';ta.style.color='var(--fg)';
 var save=h('button',{class:'b',text:'Enregistrer la note',onclick:function(){o.notes=ta.value;lockUntil=Date.now()+1500;
  post('/api/offers/'+o.id+'/notes',{notes:ta.value},function(){lockUntil=0;last='';load();});
  save.textContent='Enregistré';setTimeout(function(){save.textContent='Enregistrer la note';},1200);}});
 b.appendChild(ta);b.appendChild(h('div',{style:'margin:6px 0'},save));
 b.appendChild(h('h3',{text:'Lettres de motivation'}));
 var ls=S.letters.filter(function(l){return l.offer_id===o.id;});
 if(!ls.length)b.appendChild(h('div',{class:'mut',text:'Aucune lettre. Demande-la à Claude :'}));
 ls.forEach(function(l){
  var cp=h('button',{class:'b',text:'Copier',onclick:function(){copy(l.content,cp);}});
  var rm=delBtn('Supprimer','Confirmer ?',function(){del('/api/letters/'+l.id);});
  b.appendChild(h('div',{class:'card'},h('div',{class:'bar'},h('span',{class:'mut',text:d(l.created_at)}),cp,rm),h('div',{class:'pre',text:l.content})));});
 var cvo=(S.cvs||[]).filter(function(x){return x.filename===o.cv_filename;})[0]
   ||(S.cvs||[]).filter(function(x){return x.is_active;})[0]||null;
 var ao=(S.audits||[]).filter(function(x){return x.offer_id===o.id;})[0]||null;
 b.appendChild(h('div',{class:'bar',style:'margin:8px 0'},
  actBtn('Rédiger une lettre','letter',{offer_id:o.id,title:o.title,company:o.company}),
  cvo?actBtn('Auditer mon CV pour cette offre','audit-cv',{cv_id:cvo.id,filename:cvo.filename,offer_id:o.id,title:o.title}):null,
  ao?auditTag(ao):null));
 if(ao&&ao.summary)b.appendChild(h('div',{class:'mut',style:'margin:-4px 0 8px',text:ao.summary}));
 b.appendChild(h('h3',{text:'Annonce complète'}));
 b.appendChild(h('div',{class:'pre',text:o.description||''}));
 b.appendChild(h('div',{class:'bar',style:'margin-top:18px;border-top:1px solid var(--line);padding-top:12px'},
  delBtn('Supprimer cette offre',ls.length?('Confirmer ? '+ls.length+' lettre(s) aussi'):'Confirmer ?',
   function(){del('/api/offers/'+o.id,function(){openId=null;});})));
 return true;
}

/* ---- onglet Historique ---- */
function vHist(m){
 if(!S.searches.length){m.appendChild(h('div',{class:'empty',text:'Aucune recherche lancée.'}));return;}
 var tb=h('tbody'),head=h('tr');
 ['Date','Poste recherché','Lieu','Contrat','Site','CV','Objectif','Annonces lues','Offres retenues','État'].forEach(function(t){head.appendChild(h('th',{text:t}));});
 S.searches.forEach(function(s){
  // "plafond atteint" = arret subi : on a lu tout le budget sans remplir l'objectif.
  var seen=s.offers_seen||0;
  var capped=s.max_seen!=null&&seen>=s.max_seen&&(s.target_count==null||s.offers_saved<s.target_count);
  var lues=h('td',{},h('span',{text:String(seen)+(s.max_seen!=null?' / '+s.max_seen:'')}),
   capped?h('div',{class:'mut',style:'font-size:12px',text:'plafond atteint'}):null);
  tb.appendChild(h('tr',{class:openSearchId===s.id?'on':'',onclick:function(){openSearchId=s.id;render();}},
   h('td',{class:'nw',text:d(s.started_at)}),h('td',{class:'cut',title:s.title,text:s.title}),h('td',{class:'cut',title:s.location,text:s.location}),
   h('td',{class:'nw mut',text:s.contract_wanted&&s.contract_wanted!=='tous'?nomContrat(s.contract_wanted):'tous'}),
   h('td',{class:'nw',text:nomSite(s.site)}),
   h('td',{class:'mut cut',title:s.cv_filename||'',text:s.cv_filename||''}),h('td',{text:String(s.target_count||'')}),lues,
   h('td',{text:String(s.offers_saved)}),h('td',{text:s.finished_at?'Terminée':'En cours'})));});
 var tblH=h('table',{},h('thead',{},head),tb);
 m.appendChild(h('div',{class:'wrap'},tblH));
 colonnesReglables(tblH,'historique2',[112,206,140,116,134,170,88,118,120,100]);
}
function pSearch(b){
 if(openSearchId==null)return false;
 var s=S.searches.filter(function(x){return x.id===openSearchId;})[0];
 if(!s){openSearchId=null;return false;}
 var head=h('div',{class:'panel-head'});
 head.appendChild(closeX(function(){openSearchId=null;render();}));
 head.appendChild(h('h2',{style:'padding-right:32px',text:'Recherche #'+s.id}));
 head.appendChild(h('div',{class:'mut',text:[s.title,s.location,
  s.contract_wanted&&s.contract_wanted!=='tous'?nomContrat(s.contract_wanted):null,
  nomSite(s.site)].filter(Boolean).join(' · ')}));
 b.appendChild(head);
 var seen=s.offers_seen||0;
 [['Lancée le',d(s.started_at)],['Terminée le',s.finished_at?d(s.finished_at):'en cours'],
  ['CV utilisé',s.cv_filename||'-'],['Objectif',String(s.target_count||'-')+' offre(s)'],
  ['Plafond de lecture',s.max_seen!=null?(seen+' / '+s.max_seen+' annonce(s)'):String(seen)],
  ['Offres retenues',String(s.offers_saved)]].forEach(function(x){
   b.appendChild(h('div',{class:'bar',style:'gap:6px;margin:2px 0'},h('span',{class:'mut',text:x[0]+' :'}),h('span',{text:x[1]})));});
 if(s.stats&&Object.keys(s.stats).length){
  b.appendChild(h('h3',{text:'Par site'}));
  Object.keys(s.stats).forEach(function(k){var v=s.stats[k]||{};
   b.appendChild(h('div',{class:'bar',style:'gap:6px;margin:2px 0'},h('span',{class:'mut',text:k+' :'}),
    h('span',{text:(v.seen!=null?v.seen+' lue(s)':'')+(v.saved!=null?' · '+v.saved+' retenue(s)':'')})));});}
 if(s.notes){b.appendChild(h('h3',{text:'Notes'}));b.appendChild(h('div',{class:'pre',text:s.notes}));}
 var os=S.offers.filter(function(o){return o.search_id===s.id;});
 b.appendChild(h('h3',{text:'Offres de cette recherche ('+os.length+')'}));
 if(!os.length)b.appendChild(h('div',{class:'mut',text:'Aucune.'}));
 os.forEach(function(o){b.appendChild(h('div',{class:'card',style:'cursor:pointer;padding:8px 10px',
   onclick:function(){openId=o.id;tab='offres';render();}},
  h('strong',{text:'#'+o.id+' '+o.title}),h('div',{class:'mut',text:[o.company,o.match_score+' %',STAT[o.status]||o.status].filter(Boolean).join(' · ')})));});
 return true;
}

/* ---- onglet CV ---- */
// Audit ATS : le bouton depose une action, le skill audit-cv-ats la traite et
// renvoie le resultat par save-audit. Le dashboard n'affiche que ce qui est en base.
function auditClass(s){return s>=15?'postuler':(s>=10?'a_etudier':'ne_pas_postuler');}
function auditTag(a){
 if(!a)return null;
 return h('span',{class:'tag '+auditClass(a.score),title:'Audit ATS du '+d(a.created_at),text:'ATS '+a.score+'/20'});
}
function vAudit(m,cur){
 var a=cur.last_audit;
 var box=h('div',{class:'card'});
 box.appendChild(h('div',{class:'bar',style:'margin:0'},h('h2',{text:'Audit ATS'}),auditTag(a)));
 if(!a){
  box.appendChild(h('div',{class:'mut',text:'Pas encore audité. Le bouton « Auditer pour les ATS » demande à Claude de passer ce CV au crible du skill audit-cv-ats : lisibilité par les parseurs, structure, mots-clés du marché, et une version optimisée.'}));
  box.appendChild(h('div',{class:'bar'},actBtn('Auditer pour les ATS','audit-cv',{cv_id:cur.id,filename:cur.filename})));
  m.appendChild(box);return;
 }
 box.appendChild(h('div',{class:'mut',text:'Audité le '+d(a.created_at)+(a.keywords_total?' · '+a.keywords_present+'/'+a.keywords_total+' mots-clés présents':'')}));
 if(a.summary)box.appendChild(h('p',{text:a.summary}));
 if(a.blockers&&a.blockers.length){
  box.appendChild(h('h3',{text:'Bloquants'}));
  a.blockers.forEach(function(b){box.appendChild(h('div',{class:'blk',
   text:typeof b==='string'?b:(b.message||JSON.stringify(b))}));});
 }
 // Colonne etroite : une ligne par critere, la note a droite, le correctif dessous.
 if(a.items&&a.items.length){
  box.appendChild(h('h3',{text:'Grille'}));
  a.items.forEach(function(it){
   var fix=it.fix||it.amelioration||'';
   box.appendChild(h('div',{class:'grid-row'},
    h('div',{class:'bar',style:'margin:0;justify-content:space-between;flex-wrap:nowrap;gap:8px'},
     h('span',{text:it.label||it.item||''}),
     h('span',{class:'tag '+auditClass((Number(it.note)||0)*4),text:(it.note==null?'-':it.note)+'/5'})),
    fix?h('div',{class:'mut',style:'font-size:13px;margin-top:2px',text:fix}):null));});
 }
 var bar=h('div',{class:'bar'});
 if(a.report_path)bar.appendChild(h('span',{class:'mut',style:'font-size:13px',text:'Rapport : '+a.report_path}));
 bar.appendChild(actBtn('Refaire l\\'audit','audit-cv',{cv_id:cur.id,filename:cur.filename}));
 box.appendChild(bar);
 m.appendChild(box);
}
// identifie par nom de fichier : un CV depose mais pas encore importe n'a pas d'id
function cvCurrent(){
 if(!S.cvs.length)return null;
 var c=S.cvs.filter(function(x){return x.filename===cvView;})[0];
 if(!c)c=S.cvs.filter(function(x){return x.is_active;})[0]||S.cvs[0];
 cvView=c.filename;return c;
}
function cvUrl(c){return c.id!=null?('/cv/file?id='+c.id):('/cv/file?file='+encodeURIComponent(c.filename));}
function vCvList(m){
 if(!S.cvs.length){m.appendChild(h('div',{class:'empty',text:'Aucun CV importé. Place un ou plusieurs PDF dans le dossier cv/ puis relance le skill.'}));return;}
 var cur=cvCurrent();
 S.cvs.forEach(function(c){
  var p=c.profile||{};
  var card=h('div',{class:'card pick'+(c.filename===cur.filename?' on':''),title:'Cliquer pour afficher ce CV',onclick:function(){cvView=c.filename;render();},style:'padding:10px 12px;margin-bottom:8px'});
  card.appendChild(h('div',{class:'bar',style:'margin:0 0 4px'},
   h('strong',{text:c.filename}),
   c.is_active?h('span',{class:'tag postuler',text:'CV actif'}):null,
   auditTag(c.last_audit),
   c.file_present?null:h('span',{class:'tag ne_pas_postuler',text:'fichier absent du dossier cv/'})));
  card.appendChild(h('div',{class:'mut',text:[p.name,p.headline,'importé le '+d(c.imported_at)].filter(Boolean).join(' · ')}));
  card.appendChild(h('div',{class:'mut',style:'font-size:13px',text:c.offers_count+' offre(s) notée(s) · '+c.searches_count+' recherche(s)'}));
  var bar=h('div',{class:'bar',style:'margin:8px 0 0'});
  // les boutons de la carte ne doivent pas declencher la selection du CV
  bar.addEventListener('click',function(e){e.stopPropagation();});
  if(!c.is_active&&c.id!=null)bar.appendChild(h('button',{class:'b',text:'Utiliser pour la prochaine recherche',onclick:function(){post('/api/cv/active',{cv_id:c.id});}}));
  if(c.needs_import)bar.appendChild(actBtn('Analyser ce CV','analyze-cv',{cv_id:c.id,filename:c.filename}));
  bar.appendChild(actBtn(c.last_audit?'Refaire l\\'audit ATS':'Auditer pour les ATS','audit-cv',{cv_id:c.id,filename:c.filename}));
  if(c.id!=null)bar.appendChild(delBtn('Oublier ce CV','Confirmer ? le PDF reste',function(){del('/api/cv/'+c.id,function(){cvView=null;});}));
  card.appendChild(bar);
  m.appendChild(card);});
 m.appendChild(h('div',{class:'bar'},actBtn('Rescanner le dossier cv/','scan-cv')));
 vAudit(m,cur);
 var p=cur.profile||{},c=h('div',{class:'card'},h('h2',{text:p.name||cur.filename}),
  h('div',{class:'mut',text:[p.headline,p.location,p.years_experience?p.years_experience+' ans d\\'expérience':null,'importé le '+d(cur.updated_at)].filter(Boolean).join(' · ')}));
 if(p.summary)c.appendChild(h('p',{text:p.summary}));
 [['Compétences',p.skills],['Langues',p.languages],['Certifications',p.certifications]].forEach(function(x){
  if(x[1]&&x[1].length){c.appendChild(h('h3',{text:x[0]}));var ch=h('div',{class:'chips'});
   x[1].forEach(function(s){ch.appendChild(h('span',{text:typeof s==='string'?s:JSON.stringify(s)}));});c.appendChild(ch);}});
 [['Expériences',p.experiences],['Formation',p.education]].forEach(function(x){
  if(x[1]&&x[1].length){c.appendChild(h('h3',{text:x[0]}));
   x[1].forEach(function(e){c.appendChild(h('div',{style:'margin-bottom:8px'},
    h('strong',{text:[e.title||e.degree,e.company||e.school].filter(Boolean).join(' - ')}),
    h('div',{class:'mut',text:e.period||e.year||''}),
    e.details?h('div',{class:'pre',text:Array.isArray(e.details)?e.details.join('\\n'):e.details}):null));});}});
 m.appendChild(c);
}
function pCv(b,p){
 var cur=cvCurrent();
 if(!cur)return false;
 p.classList.add('flush');
 var head=h('div',{class:'panel-head'});
 head.appendChild(h('strong',{text:cur.filename}));
 var bar=h('div',{class:'bar',style:'margin:6px 0 0'});
 if(cur.is_active)bar.appendChild(h('span',{class:'tag postuler',text:'CV actif'}));
 else if(cur.id!=null)bar.appendChild(h('button',{class:'b',text:'Définir comme CV actif',onclick:function(){post('/api/cv/active',{cv_id:cur.id});}}));
 head.appendChild(bar);
 b.appendChild(head);
 // Le PDF a disparu du dossier : on le dit dans le panneau plutot que de le
 // refermer sans explication apres un clic sur la carte.
 if(!cur.file_present){
  pdfToken++;pdfDoc=null;pdfKey=null;pdfUrl=null;
  document.getElementById('pdfbar').replaceChildren();
  var v=document.getElementById('pdfview');v.replaceChildren();
  v.appendChild(h('div',{class:'empty',style:'color:#ddd'},
   'Le fichier ' + cur.filename + ' n’est plus dans le dossier cv/. Le profil analysé reste consultable à gauche.'));
  return true;
 }
 pdfShow(cur.filename,cvUrl(cur));
 return true;
}

/* ---- onglet Lettres ---- */
function vDeps(m){
 var D=S.deps||{};
 var ordre=['node','script','base','vendor','cv','watcher','chrome','playwright','profil','hellowork','indeed','humanizer','audit_ats'];
 var LIB={ok:'fonctionnel',ko:'non fonctionnel',unknown:'non vérifié'};
 m.appendChild(h('div',{class:'bar'},
  actBtn('Revérifier les dépendances','check-deps'),
  h('span',{class:'mut',style:'font-size:13px',text:"Certaines cases ne peuvent être vérifiées que par Claude : elles restent grises tant qu'il n'a pas répondu."})));
 var g=h('div',{class:'deps'});
 ordre.forEach(function(k){
  var x=D[k];if(!x)return;
  g.appendChild(h('div',{class:'dep '+(x.status||'unknown')},
   h('span',{class:'s',text:LIB[x.status]||x.status}),
   h('b',{text:x.label||k}),
   h('div',{class:'d',text:x.detail||''}),
   x.checked_at?h('div',{class:'d',text:'vérifié le '+d(x.checked_at)}):null));
 });
 m.appendChild(g);
 var ko=ordre.filter(function(k){return D[k]&&D[k].status==='ko';});
 if(ko.length)m.appendChild(h('div',{class:'mut',style:'margin-top:14px',
  text:ko.length+" dépendance(s) en échec. Le skill ne pourra pas tout faire tant que ce n'est pas réglé."}));
 return;
}
/* ---- onglet Chat ---- */
/* Le message part dans la file d'actions, le watcher l'emet, Claude repond avec
   la commande say. Pas de streaming : la reponse arrive au sondage suivant.
   Attention : pas d'apostrophe inverse dans ce bloc, PAGE est un litteral gabarit. */
var chatSeen=0,chatScroll=0,chatEnvoi=false;
function vChat(m){
 m.className='chat-mode';
 var log=h('div',{id:'chatlog'});
 var msgs=S.messages||[];
 if(!msgs.length){
  log.appendChild(h('div',{class:'empty'},
   "Écris à Claude ici. Le message arrive dans sa session Claude Code, et sa réponse revient dans cette page."));
 }
 var qParMsg={};
 (S.questions||[]).forEach(function(q){if(q.message_id)qParMsg[q.message_id]=q;});
 msgs.forEach(function(x){
  var b=h('div',{class:'msg '+(x.role==='user'?'user':'claude')});
  b.appendChild(h('div',{class:'h',text:(x.role==='user'?'Toi':'Claude')+' · '+dHeure(x.created_at)}));
  b.appendChild(h('div',{text:x.content}));
  log.appendChild(b);
  var q=qParMsg[x.id];
  if(q&&q.status==='pending')log.appendChild(qbox(q));
 });
 // Le dernier message est de toi et son action n'est pas close : Claude planche.
 var last=msgs[msgs.length-1];
 var attente=!!(last&&last.role==='user'&&last.action_status&&last.action_status!=='done'&&last.action_status!=='failed');
 if(attente)log.appendChild(h('div',{class:'pending'},h('b'),document.createTextNode('Claude réfléchit...')));
 m.appendChild(log);

 var ta=h('textarea',{id:'f-chat',rows:'2',placeholder:"Écris ton message, Entrée pour envoyer, Maj+Entrée pour aller à la ligne"});
 var send=h('button',{class:'b',text:'Envoyer',onclick:function(){envoyer();}});
 if(!S.watcher_alive){
  ta.setAttribute('disabled','');send.setAttribute('disabled','');
  ta.setAttribute('placeholder',"Claude est hors ligne : lance le skill recherche-emploi dans Claude Code");
 }
 ta.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();envoyer();}
 });
 function envoyer(){
  var t=ta.value.trim();
  if(!t||chatEnvoi)return;
  chatEnvoi=true;ta.value='';
  fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:t})})
   .then(function(r){return r.json();})
   .then(function(j){
    chatEnvoi=false;
    if(j&&j.error){alert(j.error);ta.value=t;return;}
    chatSeen=0;last='';lockUntil=0;load();   // force le rendu et le defilement en bas
   },function(){chatEnvoi=false;ta.value=t;});
 }
 m.appendChild(h('div',{id:'chatbar'},ta,send));

 // Defilement : on colle en bas quand un message est arrive, sinon on garde
 // la position de lecture. Fait apres l'insertion dans le DOM.
 var dernier=last?last.id:0;
 setTimeout(function(){
  var l=document.getElementById('chatlog');if(!l)return;
  if(dernier!==chatSeen){chatSeen=dernier;l.scrollTop=l.scrollHeight;}
  else l.scrollTop=chatScroll;
  l.addEventListener('scroll',function(){chatScroll=l.scrollTop;});
 },0);
}
function dHeure(s){
 if(!s)return '';
 try{return new Date(s).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});}catch(e){return '';}
}
// Question posee par Claude : options cliquables sous sa bulle. Un clic envoie
// la reponse et reveille la session ; le choix s'affiche ensuite comme un message.
function qbox(q){
 var box=h('div',{class:'qbox'});
 box.appendChild(h('div',{class:'qt',text:q.multi?'Choix multiple':'À toi de choisir'}));
 var pris=[];
 var libre=null,valider=null;
 function majValider(){
  if(!valider)return;
  var ok=pris.length>0||(libre&&libre.value.trim());
  if(ok)valider.removeAttribute('disabled');else valider.setAttribute('disabled','');
 }
 q.options.forEach(function(o){
  var b=h('button',{class:'qopt'});
  b.appendChild(h('b',{text:o.label}));
  if(o.detail)b.appendChild(h('span',{text:o.detail}));
  b.addEventListener('click',function(){
   if(q.multi){
    var i=pris.indexOf(o.value);
    if(i>=0){pris.splice(i,1);b.classList.remove('sel');}
    else{pris.push(o.value);b.classList.add('sel');}
    majValider();
   }else{
    pris=[o.value];repondre(q,pris,'');
   }
  });
  box.appendChild(b);
 });
 if(q.allow_text){
  libre=h('input',{type:'text',placeholder:'Autre réponse...'});
  libre.addEventListener('input',majValider);
  libre.addEventListener('keydown',function(e){
   if(e.key==='Enter'&&libre.value.trim()){e.preventDefault();repondre(q,pris,libre.value.trim());}
  });
  box.appendChild(libre);
 }
 if(q.multi||q.allow_text){
  valider=h('button',{class:'b',style:'margin-top:8px',text:'Valider',onclick:function(){
   repondre(q,pris,libre?libre.value.trim():'');
  }});
  valider.setAttribute('disabled','');
  box.appendChild(h('div',{},valider));
 }
 if(!S.watcher_alive){
  [].forEach.call(box.querySelectorAll('button,input'),function(e){e.setAttribute('disabled','');});
  box.appendChild(h('div',{class:'mut',style:'font-size:13px;margin-top:6px',
   text:"Claude est hors ligne : la question reste en attente."}));
 }
 return box;
}
function repondre(q,valeurs,texte){
 fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({question_id:q.id,values:valeurs,text:texte})})
  .then(function(r){return r.json();})
  .then(function(j){
   if(j&&j.error){alert(j.error);return;}
   chatSeen=0;last='';lockUntil=0;load();
  });
}

function vLettres(m){
 var manque=S.offers.filter(function(o){return o.status==='a_postuler'&&!o.letters_count;}).length;
 m.appendChild(h('div',{class:'bar'},
  actBtn('Rédiger les lettres manquantes','letters-missing'),
  h('span',{class:'mut',style:'font-size:13px',text:manque+' offre(s) à postuler sans lettre'})));
 if(!S.letters.length){m.appendChild(h('div',{class:'empty',text:'Aucune lettre générée. Clique le bouton ci-dessus, ou ouvre une offre et demande une lettre à Claude.'}));return;}
 S.letters.forEach(function(l){
  var cp=h('button',{class:'b',text:'Copier',onclick:function(){copy(l.content,cp);}});
  var open=h('button',{class:'b',text:'Voir l\\'offre',onclick:function(){openId=l.offer_id;renderPanel();}});
  m.appendChild(h('div',{class:'card'},h('div',{class:'bar'},
   h('strong',{text:'#'+l.offer_id+' '+l.offer_title+(l.offer_company?' - '+l.offer_company:'')}),
   h('span',{class:'mut',text:d(l.created_at)}),cp,open),h('div',{class:'pre',text:l.content})));});
}

// --- couleurs de l'interface ---------------------------------------------
// Le choix est garde dans le navigateur, pas en base : c'est un reglage
// d'affichage, propre au poste, et il doit s'appliquer avant le premier rendu.
var THEMES=[['bleu','#2f6fed'],['violet','#6d45e8'],['vert','#0e8a5f'],
            ['ambre','#b4690e'],['rose','#c2255c'],['ardoise','#475569']];
var MODES=[['auto','Auto'],['clair','Clair'],['sombre','Sombre']];

function themeGet(k,def){try{return localStorage.getItem('jobsearch.'+k)||def;}catch(e){return def;}}
function themeSet(k,v){try{localStorage.setItem('jobsearch.'+k,v);}catch(e){}
 document.documentElement.dataset[k==='mode'?'mode':'theme']=v;themePop(true);}

function themePop(garde){
 var pop=document.getElementById('themepop');
 pop.replaceChildren();
 pop.appendChild(h('h4',{text:'Apparence'}));
 var mode=themeGet('mode','auto'),theme=themeGet('theme','bleu');
 var md=h('div',{class:'modes'});
 MODES.forEach(function(x){
  md.appendChild(h('button',{class:mode===x[0]?'on':'',text:x[1],onclick:function(){themeSet('mode',x[0]);}}));
 });
 pop.appendChild(md);
 pop.appendChild(h('h4',{text:'Couleur'}));
 var sw=h('div',{class:'swatches'});
 THEMES.forEach(function(x){
  sw.appendChild(h('button',{class:'sw'+(theme===x[0]?' on':''),title:x[0],
   style:'background:'+x[1],onclick:function(){themeSet('theme',x[0]);}}));
 });
 pop.appendChild(sw);
 if(!garde)pop.classList.toggle('on');
 if(pop.classList.contains('on')){
  var r=document.getElementById('themebtn').getBoundingClientRect();
  pop.style.top=(r.bottom+8)+'px';
  pop.style.left=Math.max(8,Math.min(r.right-238,window.innerWidth-246))+'px';
 }
}
document.getElementById('themebtn').addEventListener('click',function(e){e.stopPropagation();themePop(false);});
document.addEventListener('click',function(e){
 var pop=document.getElementById('themepop');
 if(pop.classList.contains('on')&&!pop.contains(e.target))pop.classList.remove('on');
});
document.addEventListener('keydown',function(e){
 if(e.key==='Escape')document.getElementById('themepop').classList.remove('on');
});
load();setInterval(function(){if(document.visibilityState==='visible')load();},5000);
</script></body></html>`;

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log('jobsearch ' + VERSION + ' - commandes : version, ' + Object.keys(commands).join(', '));
  process.exit(cmd ? 1 : 0);
}
commands[cmd](rest);
