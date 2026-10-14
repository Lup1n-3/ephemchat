'use strict';

/**
 * EphemChat — chat efímero por salas.
 * Node.js + WebSockets. TODO en RAM, nada se escribe a disco, sin logs.
 *
 * - Cada ruta es una sala: /hola  -> sala "hola".
 * - Los mensajes se retransmiten en vivo a quien esté conectado y NO se guardan:
 *   quien entra después no ve lo escrito antes.
 * - Los archivos viven en memoria y se borran al cancelar o al desconectar el dueño.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');

const PORT = process.env.PORT || 8080;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT = 10000;
const MAX_NICK = 32;
const FILE_GRACE_MS = 20000; // 20 s de gracia tras desconexión antes de borrar archivos
const MAX_FILES_PER_TOKEN = 20;

/* ------------------------- estado en RAM (efímero) ------------------------- */

const rooms = new Map();          // sala -> Set<ws>
const files = new Map();          // shareId -> { buffer, meta }
const filesByToken = new Map();   // token -> Set<shareId>
const pendingDeletion = new Map();// token -> timeout
const liveTokens = new Map();     // token -> nº de conexiones WS activas

/* ------------------------------ saneamiento ------------------------------ */

function sanitizeRoom(r) {
    r = String(r || '').trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(r) ? r : null;
}
function sanitizeToken(t) {
    t = String(t || '').replace(/[^A-Za-z0-9_-]/g, '');
    return t.length <= 128 ? t : t.slice(0, 128);
}
function sanitizeNick(n) {
    n = String(n || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!n) n = 'anon';
    return n.length > MAX_NICK ? n.slice(0, MAX_NICK) : n;
}
function sanitizeText(t) {
    t = String(t || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return t.trim();
}
function sanitizeName(n) {
    n = path.basename(String(n || 'archivo'));
    n = n.replace(/[\x00-\x1f\x7f]/g, '');
    return n || 'archivo';
}

/* ------------------------------- HTTP (API) ------------------------------- */

const app = express();
app.disable('x-powered-by');
app.disable('etag');

app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; " +
        "media-src 'self'; form-action 'self'; base-uri 'self'");
    next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/rooms', (req, res) => {
    const out = [];
    for (const [room, set] of rooms) {
        if (set.size > 0) out.push({ name: room, online: set.size });
    }
    res.json({ rooms: out });
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 }
});

app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(413).json({ error: 'archivo demasiado grande o inválido' });
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'sin archivo' });

        const room = sanitizeRoom(req.body.room);
        const token = sanitizeToken(req.body.token);
        const nick = sanitizeNick(req.body.nick);
        if (!room || !token) return res.status(400).json({ error: 'parámetros inválidos' });

        if (filesByToken.has(token) && filesByToken.get(token).size >= MAX_FILES_PER_TOKEN) {
            return res.status(429).json({ error: 'demasiados archivos compartidos' });
        }

        const shareId = crypto.randomBytes(16).toString('hex');
        const meta = {
            name: sanitizeName(file.originalname),
            size: file.size,
            mime: file.mimetype || 'application/octet-stream',
            token,
            room
        };
        files.set(shareId, { buffer: file.buffer, meta });

        if (!filesByToken.has(token)) filesByToken.set(token, new Set());
        filesByToken.get(token).add(shareId);

        broadcast(room, { type: 'file', nick, shareId, name: meta.name, size: meta.size });
        res.json({ ok: true, shareId, name: meta.name, size: meta.size });
    });
});

app.get('/api/download/:shareId', (req, res) => {
    const shareId = String(req.params.shareId || '').replace(/[^a-f0-9]/g, '');
    const entry = files.get(shareId);
    if (!entry) return res.status(404).end();

    const { buffer, meta } = entry;
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(buffer.length));
    res.set('Content-Disposition', 'attachment; filename="' + meta.name.replace(/["\\]/g, '_') + '"');
    res.set('Cache-Control', 'no-store');
    res.end(buffer);
});

app.use(express.static(path.join(__dirname, 'public'), { index: false, etag: false, lastModified: false }));

// Cualquier ruta no-API es una sala (o la portada): servimos la SPA.
app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------ utilidades WS ------------------------------ */

function broadcast(room, payload) {
    const set = rooms.get(room);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
}

function sendTo(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastUsers(room) {
    const set = rooms.get(room);
    if (!set) return;
    const counts = new Map();
    for (const ws of set) {
        const n = ws.nick || 'anon';
        counts.set(n, (counts.get(n) || 0) + 1);
    }
    const users = Array.from(counts.entries())
        .map(([nick, count]) => ({ nick, count }))
        .sort((a, b) => a.nick.localeCompare(b.nick));
    broadcast(room, { type: 'users', users });
}

function deleteFile(shareId) {
    const entry = files.get(shareId);
    if (!entry) return;
    files.delete(shareId);
    const set = filesByToken.get(entry.meta.token);
    if (set) {
        set.delete(shareId);
        if (set.size === 0) filesByToken.delete(entry.meta.token);
    }
    broadcast(entry.meta.room, { type: 'file-removed', shareId });
}

/* ------------------------------ WebSocket ------------------------------ */

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = '/'; }
    if (pathname !== '/ws') {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
    let params;
    try { params = new URL(req.url, 'http://localhost').searchParams; }
    catch { params = new URLSearchParams(''); }

    const room = sanitizeRoom(params.get('room'));
    if (!room) { ws.close(4000, 'bad room'); return; }

    ws.room = room;
    ws.token = sanitizeToken(params.get('token')) || crypto.randomBytes(16).toString('hex');
    ws.nick = sanitizeNick(params.get('nick'));
    ws.isAlive = true;

    liveTokens.set(ws.token, (liveTokens.get(ws.token) || 0) + 1);

    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(ws);

    broadcastUsers(room);

    // Reconexión: si este token tenía archivos a punto de borrarse, los conserva.
    if (ws.token && pendingDeletion.has(ws.token)) {
        clearTimeout(pendingDeletion.get(ws.token));
        pendingDeletion.delete(ws.token);
    }

    sendTo(ws, { type: 'system', text: 'Conectado a /' + room + ' — chat efímero, sin registro.' });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        handleClientMessage(ws, msg);
    });

    ws.on('close', () => {
        const set = rooms.get(ws.room);
        if (set) {
            set.delete(ws);
            if (set.size === 0) rooms.delete(ws.room);
        }
        const n = (liveTokens.get(ws.token) || 1) - 1;
        if (n <= 0) liveTokens.delete(ws.token); else liveTokens.set(ws.token, n);
        broadcastUsers(ws.room);
        // Borra los archivos del dueño tras un breve periodo de gracia (si era su última conexión).
        if (n <= 0 && ws.token && filesByToken.has(ws.token) && !pendingDeletion.has(ws.token)) {
            pendingDeletion.set(ws.token, setTimeout(() => {
                pendingDeletion.delete(ws.token);
                const ids = filesByToken.get(ws.token);
                if (ids) { Array.from(ids).forEach(deleteFile); }
            }, FILE_GRACE_MS));
        }
    });
});

function handleClientMessage(ws, msg) {
    switch (msg.type) {
        case 'message': {
            const nick = sanitizeNick(msg.nick);
            let text = sanitizeText(msg.text);
            const kind = (msg.kind === 'code') ? 'code' : 'md';
            if (!text) return;
            if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
            broadcast(ws.room, { type: 'message', nick, text, kind });
            break;
        }
        case 'file-cancel': {
            const shareId = String(msg.shareId || '').replace(/[^a-f0-9]/g, '');
            const entry = files.get(shareId);
            if (entry && entry.meta.token === ws.token) deleteFile(shareId);
            break;
        }
        case 'setnick': {
            ws.nick = sanitizeNick(msg.nick);
            broadcastUsers(ws.room);
            break;
        }
        default:
            break;
    }
}

/* ------------------------- keepalive (detecta muertos) ------------------------- */

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* noop */ }
    });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// Red de seguridad: borra archivos cuyo dueño no tiene conexión activa ni gracia pendiente.
const orphanSweep = setInterval(() => {
    const toSweep = [];
    for (const [token] of filesByToken) {
        if (!liveTokens.has(token) && !pendingDeletion.has(token)) toSweep.push(token);
    }
    for (const token of toSweep) {
        const ids = filesByToken.get(token);
        if (ids) Array.from(ids).forEach(deleteFile);
    }
}, 60000);
wss.on('close', () => clearInterval(orphanSweep));

server.listen(PORT, () => {
    // Sin logs de contenido; solo arranque.
    process.stdout.write('EphemChat escuchando en puerto ' + PORT + '\n');
});
