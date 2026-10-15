// Croc : sert index.html et enregistre les comptes rendus sur le serveur.
// Aucune dépendance : Node 18+ suffit.
//
//   PORT           port d'écoute (fourni par Railway)
//   DATA_DIR       dossier des données (volume Railway monté sur /data)
//   CROC_SETUP_CODE  code demandé pour créer le tout premier compte (à défaut : CROC_PASSWORD)
//
// Accès : on se connecte avec un compte. Le premier compte se crée avec le code
// d'installation ; les suivants avec un lien d'invitation généré depuis le site.
// Tous les comptes voient tous les comptes rendus.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SETUP_CODE = process.env.CROC_SETUP_CODE || process.env.CROC_PASSWORD || '';
const INDEX = path.join(__dirname, 'index.html');
const MAX_JSON = 30 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;

const DIRS = {reports: path.join(DATA, 'reports'), summaries: path.join(DATA, 'summaries'), settings: path.join(DATA, 'settings'), blobs: path.join(DATA, 'blobs')};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, {recursive: true});

const USERS = path.join(DATA, 'users.json'), INVITES = path.join(DATA, 'invites.json'), SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), {mode: 0o600});
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const SESSION_DAYS = 30, INVITE_DAYS = 7, COOKIE = 'croc_session';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_TYPES = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif'};

class HttpError extends Error { constructor(status, code){ super(code); this.status = status; this.code = code; } }

async function writeAtomic(file, data){
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
async function readJSON(file){
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const rmIfAny = file => fsp.rm(file, {force: true});

function readBody(req, limit){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit){ reject(new HttpError(413, 'too_big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req){
  try { return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'invalid_json'); }
}

function send(res, status, body, headers = {}){
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}, headers));
  res.end(data);
}

/* ---------- Comptes ---------- */
const sameStr = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const hashPassword = (password, salt) => new Promise((res, rej) => crypto.scrypt(password, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const loadUsers = async () => (await readJSON(USERS)) || [];
const publicUser = u => ({id: u.id, name: u.name, email: u.email});

// Écritures des comptes et invitations une par une, pour ne rien perdre
let accountsChain = Promise.resolve();
const withAccounts = fn => (accountsChain = accountsChain.then(fn, fn));

const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function sessionCookie(req, userId){
  const exp = Date.now() + SESSION_DAYS * 864e5, v = `${userId}.${exp}`;
  const secure = (req.headers['x-forwarded-proto'] || '').startsWith('https') ? '; Secure' : '';
  return `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
async function currentUser(req){
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return null;
  const [id, exp, sig] = m[1].split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now() || !sameStr(sig, sign(`${id}.${exp}`))) return null;
  return (await loadUsers()).find(u => u.id === id) || null;
}

async function validInvite(token){
  if (!token || !ID.test(token)) return null;
  return ((await readJSON(INVITES)) || []).find(i => i.token === token && i.expiresAt > Date.now()) || null;
}

// Limite les essais de mot de passe : 10 échecs par adresse IP et par quart d'heure
const failures = new Map();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function checkRate(req){
  const f = failures.get(clientIp(req));
  if (f && f.until > Date.now() && f.n >= 10) throw new HttpError(429, 'rate_limited');
}
function fail(req, status, code){
  const ip = clientIp(req), f = failures.get(ip);
  if (f && f.until > Date.now()) f.n++; else failures.set(ip, {n: 1, until: Date.now() + 15 * 60e3});
  throw new HttpError(status, code);
}

async function auth(req, res, action, user){
  const m = req.method;
  if (action === 'state' && m === 'GET'){
    const users = await loadUsers(), invite = new URL(req.url, 'http://x').searchParams.get('invite');
    const headers = user ? {'Set-Cookie': sessionCookie(req, user.id)} : {};
    return send(res, 200, {user: user ? publicUser(user) : null, needsSetup: !users.length, setupCode: !users.length && !!SETUP_CODE, inviteValid: !!(await validInvite(invite))}, headers);
  }
  if (action === 'login' && m === 'POST'){
    checkRate(req);
    const {email, password} = await readJSONBody(req);
    const u = (await loadUsers()).find(x => x.email === String(email || '').trim().toLowerCase());
    const hash = await hashPassword(String(password || ''), u ? u.salt : 'x');
    if (!u || !sameStr(hash, u.hash)) fail(req, 401, 'bad_credentials');
    failures.delete(clientIp(req));
    return send(res, 200, {user: publicUser(u)}, {'Set-Cookie': sessionCookie(req, u.id)});
  }
  if (action === 'signup' && m === 'POST'){
    checkRate(req);
    const body = await readJSONBody(req);
    const name = String(body.name || '').trim().slice(0, 80), email = String(body.email || '').trim().toLowerCase(), password = String(body.password || ''), invite = String(body.invite || '');
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, 'invalid_fields');
    if (password.length < 8) throw new HttpError(400, 'weak_password');
    const salt = crypto.randomBytes(16).toString('hex'), hash = await hashPassword(password, salt);
    const u = await withAccounts(async () => {
      const users = await loadUsers();
      if (!users.length){
        if (SETUP_CODE && !sameStr(invite, SETUP_CODE)) fail(req, 403, 'bad_invite');
      } else if (!(await validInvite(invite))) fail(req, 403, 'bad_invite');
      if (users.some(x => x.email === email)) throw new HttpError(409, 'email_taken');
      const nu = {id: crypto.randomBytes(9).toString('base64url'), name, email, salt, hash, createdAt: Date.now()};
      await writeAtomic(USERS, JSON.stringify([...users, nu], null, 1));
      if (users.length) await writeAtomic(INVITES, JSON.stringify(((await readJSON(INVITES)) || []).filter(i => i.token !== invite && i.expiresAt > Date.now())));
      return nu;
    });
    return send(res, 200, {user: publicUser(u)}, {'Set-Cookie': sessionCookie(req, u.id)});
  }
  if (action === 'logout' && m === 'POST') return send(res, 200, {ok: true}, {'Set-Cookie': clearCookie});
  if (action === 'invite' && m === 'POST'){
    if (!user) throw new HttpError(401, 'not_signed_in');
    const inv = {token: crypto.randomBytes(18).toString('base64url'), by: user.id, createdAt: Date.now(), expiresAt: Date.now() + INVITE_DAYS * 864e5};
    await withAccounts(async () => writeAtomic(INVITES, JSON.stringify([...((await readJSON(INVITES)) || []).filter(i => i.expiresAt > Date.now()), inv])));
    return send(res, 200, {token: inv.token, expiresAt: inv.expiresAt});
  }
  throw new HttpError(404, 'not_found');
}

async function listSummaries(){
  const names = (await fsp.readdir(DIRS.summaries)).filter(n => n.endsWith('.json'));
  const all = (await Promise.all(names.map(n => readJSON(path.join(DIRS.summaries, n)).catch(() => null)))).filter(Boolean);
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function findBlob(id){
  for (const [type, ext] of Object.entries(IMAGE_TYPES)){
    const file = path.join(DIRS.blobs, id + ext);
    try { await fsp.access(file); return {file, type}; } catch (e) {}
  }
  return null;
}

async function api(req, res, parts){
  const [kind, id] = parts, m = req.method;
  if (id !== undefined && !ID.test(id)) throw new HttpError(400, 'invalid_id');

  if (kind === 'summaries' && !id && m === 'GET') return send(res, 200, await listSummaries());

  if (kind === 'reports' && id){
    const file = path.join(DIRS.reports, id + '.json'), sum = path.join(DIRS.summaries, id + '.json');
    if (m === 'GET'){
      const r = await readJSON(file);
      return r ? send(res, 200, r) : send(res, 404, {error: 'not_found'});
    }
    if (m === 'PUT'){
      const {report, summary} = await readJSONBody(req);
      if (!report || typeof report !== 'object' || report.id !== id || !summary || summary.id !== id) throw new HttpError(400, 'invalid_argument');
      await writeAtomic(file, JSON.stringify(report));
      await writeAtomic(sum, JSON.stringify(summary));
      return send(res, 200, {ok: true});
    }
    if (m === 'DELETE'){
      await rmIfAny(sum); await rmIfAny(file);
      return send(res, 200, {ok: true});
    }
  }

  if (kind === 'settings' && id){
    const file = path.join(DIRS.settings, id + '.json');
    if (m === 'GET') return send(res, 200, {value: await readJSON(file)});
    if (m === 'PUT'){ await writeAtomic(file, JSON.stringify(await readJSONBody(req))); return send(res, 200, {ok: true}); }
  }

  throw new HttpError(404, 'not_found');
}

async function blobs(req, res, id){
  const m = req.method;
  if (m === 'POST' && !id){
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) throw new HttpError(415, 'unsupported_type');
    const data = await readBody(req, MAX_IMAGE);
    if (!data.length) throw new HttpError(400, 'empty');
    const newId = crypto.randomBytes(12).toString('hex');
    await writeAtomic(path.join(DIRS.blobs, newId + IMAGE_TYPES[type]), data);
    return send(res, 200, {id: newId, url: '/_blob/' + newId});
  }
  if (!id || !ID.test(id)) throw new HttpError(404, 'not_found');
  const found = await findBlob(id);
  if (m === 'GET'){
    if (!found) throw new HttpError(404, 'not_found');
    return send(res, 200, await fsp.readFile(found.file), {'Content-Type': found.type, 'Cache-Control': 'private, max-age=31536000, immutable'});
  }
  if (m === 'DELETE'){
    if (found) await rmIfAny(found.file);
    return send(res, 200, {ok: true});
  }
  throw new HttpError(405, 'method_not_allowed');
}

const originHost = o => { try { return new URL(o).host; } catch (e) { return ''; } };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const isData = parts[0] === 'api' || parts[0] === '_blob';
    // Les écritures ne viennent que du site lui-même
    if (isData && req.method !== 'GET' && req.headers.origin && originHost(req.headers.origin) !== req.headers.host) throw new HttpError(403, 'bad_origin');
    if (parts[0] === 'api' && parts[1] === 'health') return send(res, 200, {ok: true});
    if (parts[0] === 'api' && parts[1] === 'auth') return await auth(req, res, parts[2], await currentUser(req));
    if (isData && !(await currentUser(req))) throw new HttpError(401, 'not_signed_in');
    if (parts[0] === 'api') return await api(req, res, parts.slice(1));
    if (parts[0] === '_blob') return await blobs(req, res, parts[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    const html = await fsp.readFile(INDEX);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, {error: e.code || 'server_error'});
    else res.end();
  }
});
server.listen(PORT, () => console.log(`Croc sur le port ${PORT}, données dans ${DATA}${SETUP_CODE ? ', code d\'installation défini' : ''}`));
