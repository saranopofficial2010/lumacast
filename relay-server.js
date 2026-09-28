const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const PORT = Number(process.env.PORT || 4173);
const bundledFFmpeg = path.join(ROOT, '.tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFMPEG = process.env.FFMPEG_PATH || (fs.existsSync(bundledFFmpeg) ? bundledFFmpeg : 'ffmpeg');
const ffmpegProbe = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', windowsHide: true });
const FFMPEG_AVAILABLE = !ffmpegProbe.error && ffmpegProbe.status === 0;
const sessions = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 8192) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function allowedHost(host) {
  const allow = (process.env.RTMP_ALLOWED_HOSTS || 'a.rtmp.youtube.com,b.rtmp.youtube.com,a.rtmps.youtube.com,b.rtmps.youtube.com').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return allow.some(rule => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule);
}
function getTarget(body) {
  if (process.env.RTMP_TARGET) {
    const target = new URL(process.env.RTMP_TARGET);
    if (!['rtmp:', 'rtmps:'].includes(target.protocol) || !allowedHost(target.hostname)) throw new Error('RTMP_TARGET host is not on RTMP_ALLOWED_HOSTS.');
    return target.toString();
  }
  if (!body.server || !body.key) throw new Error('Add RTMP_TARGET to the server .env file or select a custom ingest in Settings.');
  const server = new URL(String(body.server || ''));
  const key = String(body.key || '');
  if (!['rtmp:', 'rtmps:'].includes(server.protocol)) throw new Error('Use an RTMP or RTMPS server URL.');
  if (!allowedHost(server.hostname)) throw new Error('This RTMP host is not allowed. Add it to RTMP_ALLOWED_HOSTS in the server environment.');
  if (!/^[a-zA-Z0-9_-]{4,256}$/.test(key)) throw new Error('Stream key format is invalid.');
  server.pathname = `${server.pathname.replace(/\/+$/, '')}/${key}`;
  server.search = '';
  server.hash = '';
  return server.toString();
}
function stopSession(session, reason = 'stopped') {
  if (!session || session.stopping) return;
  session.stopping = true;
  clearTimeout(session.disconnectTimer);
  try { session.ffmpeg?.stdin?.end(); } catch {}
  const timer = setTimeout(() => session.ffmpeg?.kill('SIGTERM'), 2500);
  timer.unref();
  session.ffmpeg?.once('close', () => clearTimeout(timer));
  for (const socket of session.sockets) socket.endFrame(8, Buffer.alloc(0));
  sessions.delete(session.id);
  console.log(`Stream ${session.id.slice(0, 8)} ${reason}.`);
}
function ffmpegArgs(session) {
  const landscape = session.orientation !== 'Portrait';
  const width = landscape ? 1920 : 1080;
  const height = landscape ? 1080 : 1920;
  const fps = Math.max(20, Math.min(60, Number(session.fps) || 30));
  const bitrate = Math.max(1500, Math.min(15000, Number(session.bitrate) || 6000));
  return ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`, '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', session.target];
}
function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (data.length < 126) { head = Buffer.from([0x80 | opcode, data.length]); }
  else if (data.length <= 65535) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([head, data]);
}
function attachSocket(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const session = sessions.get(url.searchParams.get('session'));
  let sameOrigin = true;
  try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
  if (!session || session.stopping || !sameOrigin || !req.headers['sec-websocket-key'] || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let bytesIn = 0;
  const client = { endFrame: (op, data) => { if (!socket.destroyed) socket.write(wsFrame(op, data)); } };
  clearTimeout(session.disconnectTimer);
  session.sockets.add(client);
  const close = () => { session.sockets.delete(client); if (!session.sockets.size && !session.stopping) { session.disconnectTimer = setTimeout(() => stopSession(session, 'relay reconnect timed out'), 30000); session.disconnectTimer.unref(); } };
  socket.on('close', close);
  socket.on('error', close);
  const processData = data => {
    if (session.stopping || session.ffmpeg.stdin.destroyed) return;
    bytesIn += data.length;
    if (bytesIn > 2 * 1024 * 1024 * 1024) { stopSession(session, 'stream size limit reached'); return; }
    if (!session.ffmpeg.stdin.write(data) && session.ffmpeg.stdin.writableLength > 10 * 1024 * 1024) { socket.pause(); session.ffmpeg.stdin.once('drain', () => socket.resume()); }
  };
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0], b1 = buffer[1], fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > 16777216n) { socket.destroy(); return; } length = Number(n); offset = 10; }
      if (!masked || length > 16777216) { socket.destroy(); return; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + length);
      if (opcode === 8) { client.endFrame(8, payload); socket.end(); continue; }
      if (opcode === 9) { client.endFrame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 0) fragments.push(payload);
      else { fragmentOpcode = opcode; fragments = [payload]; }
      if (fin) { const message = Buffer.concat(fragments); if (fragmentOpcode === 2) processData(message); fragments = []; fragmentOpcode = 0; }
    }
  });
  socket.write(wsFrame(1, JSON.stringify({ type: 'relay-ready' })));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, FFMPEG_AVAILABLE ? 200 : 503, { ok: FFMPEG_AVAILABLE, ffmpeg: FFMPEG, error: FFMPEG_AVAILABLE ? undefined : `FFmpeg encoder not found (${FFMPEG}). Install FFmpeg or set FFMPEG_PATH in outputs/.env.` });
  if (req.method === 'POST' && url.pathname === '/api/stream/start') {
    if (sessions.size) return send(res, 409, { error: 'A stream is already active on this relay.' });
    if (!FFMPEG_AVAILABLE) return send(res, 503, { error: `FFmpeg encoder not found (${FFMPEG}). Install FFmpeg or set FFMPEG_PATH in outputs/.env before starting a stream.` });
    try {
      const body = await readJson(req);
      const target = getTarget(body);
      const id = crypto.randomBytes(24).toString('hex');
      const session = { id, target, orientation: body.orientation === 'Portrait' ? 'Portrait' : 'Landscape', fps: body.fps, bitrate: body.bitrate, sockets: new Set(), stopping: false, ffmpeg: null };
      session.disconnectTimer = setTimeout(() => stopSession(session, 'media connection timed out'), 30000);
      session.disconnectTimer.unref();
      sessions.set(id, session);
      return send(res, 201, { session: id, websocket: `/relay?session=${id}`, orientation: session.orientation });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/stream/stop') {
    try { const { session: id } = await readJson(req); const session = sessions.get(id); if (session) stopSession(session); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/relay?')) { socket.destroy(); return; }
  const url = new URL(req.url, 'http://localhost');
  const session = sessions.get(url.searchParams.get('session'));
  if (!session || session.sockets.size) { socket.destroy(); return; }
  if (!session.ffmpeg) {
    const ff = spawn(FFMPEG, ffmpegArgs(session), { stdio: ['pipe', 'ignore', 'pipe'] });
    session.ffmpeg = ff;
    let log = '';
    ff.stderr.on('data', b => { log = (log + b.toString()).slice(-1800); });
    ff.on('error', e => { console.error(`FFmpeg failed to start: ${e.message}`); stopSession(session, 'encoder unavailable'); });
    ff.on('close', code => { if (!session.stopping) console.error(`FFmpeg exited (${code}): ${log.split(session.target).join('[RTMP_TARGET]').trim()}`); stopSession(session, `encoder exited ${code}`); });
  }
  attachSocket(req, socket, head);
});
server.listen(PORT, () => console.log(`LumaCast relay ready at http://localhost:${PORT}`));
process.on('SIGINT', () => { for (const s of sessions.values()) stopSession(s, 'server shutdown'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { for (const s of sessions.values()) stopSession(s, 'server shutdown'); server.close(() => process.exit(0)); });
