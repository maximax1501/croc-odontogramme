// Croc : sert index.html et enregistre les comptes rendus sur le serveur.
// Aucune dépendance : Node 18+ suffit.
//
//   PORT           port d'écoute (fourni par Railway)
//   DATA_DIR       dossier des données (volume Railway monté sur /data)
//   CROC_PASSWORD  mot de passe unique demandé à l'ouverture du site (sans lui, le site est ouvert)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PASSWORD = process.env.CROC_PASSWORD || '';
const INDEX = path.join(__dirname, 'index.html');
const MAX_JSON = 30 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;

const DIRS = {reports: path.join(DATA, 'reports'), summaries: path.join(DATA, 'summaries'), settings: path.join(DATA, 'settings'), blobs: path.join(DATA, 'blobs')};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, {recursive: true});

const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), {mode: 0o600});
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const SESSION_DAYS = 30, COOKIE = 'croc_session';

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

/* ---------- Accès par mot de passe ---------- */
const sameStr = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
// La signature dépend du mot de passe : le changer dans Railway déconnecte tout le monde
const sign = v => crypto.createHmac('sha256', SECRET).update(`${v}:${PASSWORD}`).digest('base64url');
function sessionCookie(req){
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const secure = (req.headers['x-forwarded-proto'] || '').startsWith('https') ? '; Secure' : '';
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
function signedIn(req){
  if (!PASSWORD) return true;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && sameStr(sig, sign(exp));
}

// Limite les essais : 10 mauvais mots de passe par adresse IP et par quart d'heure
const failures = new Map();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

async function auth(req, res, action){
  const m = req.method;
  if (action === 'state' && m === 'GET'){
    const ok = signedIn(req);
    return send(res, 200, {signedIn: ok, open: !PASSWORD}, ok && PASSWORD ? {'Set-Cookie': sessionCookie(req)} : {});
  }
  if (action === 'login' && m === 'POST'){
    const ip = clientIp(req), f = failures.get(ip);
    if (f && f.until > Date.now() && f.n >= 10) throw new HttpError(429, 'rate_limited');
    const {password} = await readJSONBody(req);
    if (PASSWORD && !sameStr(password || '', PASSWORD)){
      if (f && f.until > Date.now()) f.n++; else failures.set(ip, {n: 1, until: Date.now() + 15 * 60e3});
      throw new HttpError(401, 'bad_password');
    }
    failures.delete(ip);
    return send(res, 200, {ok: true}, PASSWORD ? {'Set-Cookie': sessionCookie(req)} : {});
  }
  if (action === 'logout' && m === 'POST') return send(res, 200, {ok: true}, {'Set-Cookie': clearCookie});
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
    if (parts[0] === 'api' && parts[1] === 'auth') return await auth(req, res, parts[2]);
    if (isData && !signedIn(req)) throw new HttpError(401, 'not_signed_in');
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
server.listen(PORT, () => console.log(`Croc sur le port ${PORT}, données dans ${DATA}${PASSWORD ? ', protégé par mot de passe' : ', sans mot de passe (CROC_PASSWORD non défini)'}`));
