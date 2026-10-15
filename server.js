// Croc : sert index.html et enregistre les comptes rendus sur le serveur.
// Aucune dépendance : Node 18+ suffit.
//
//   PORT           port d'écoute (fourni par Railway)
//   DATA_DIR       dossier des données (volume Railway monté sur /data)
//   CROC_PASSWORD  si défini, le site demande ce mot de passe (identifiant libre)

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

function authorized(req){
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(pass).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
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

  if (kind === 'health' && m === 'GET') return send(res, 200, {ok: true});
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

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)){
      res.writeHead(401, {'WWW-Authenticate': 'Basic realm="Croc", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8'});
      return res.end('Mot de passe requis.');
    }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
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
server.listen(PORT, () => console.log(`Croc sur le port ${PORT}, données dans ${DATA}${PASSWORD ? ', protégé par mot de passe' : ''}`));
