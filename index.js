const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const http   = require('http');
const https  = require('https');
const QRCode = require('qrcode');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT          = process.env.PORT || 3000;
const SELF_URL      = process.env.RENDER_EXTERNAL_URL || '';
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const HISTORY_DIR   = path.join(DATA_DIR, 'history');
const SESSION_DIR   = path.join(DATA_DIR, 'sessions');
const CAMPAIGN_DIR  = path.join(DATA_DIR, 'campaigns');

// Ensure dirs exist
[HISTORY_DIR, SESSION_DIR, CAMPAIGN_DIR].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Multi-Account Bot instances ──────────────────────────────────────────────
// bots Map: accountId → { sock, status, qr, reconnDelay, reconnTimer, userId }
const bots = new Map();

// ── Active auth sessions: token → { userId, name, email, role } ──────────────
const sessions = new Map();

const ROLES = {
    SUPERADMIN: 'superadmin',
    ADMIN:      'admin',
    MANAGER:    'manager',
    AGENT:      'agent'
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const hash  = s => crypto.createHash('sha256').update(s).digest('hex');
const mkTok = () => crypto.randomBytes(24).toString('hex');

function json(res, data, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
function parseBody(req) {
    return new Promise((ok, err) => {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { err(e); } });
    });
}

function loadJSON(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function saveJSON(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {} }

const loadUsers    = () => loadJSON(USERS_FILE, []);
const saveUsers    = d  => saveJSON(USERS_FILE, d);
const loadAccounts = () => loadJSON(ACCOUNTS_FILE, []);
const saveAccounts = d  => saveJSON(ACCOUNTS_FILE, d);

function userHistoryFile(userId)  { return path.join(HISTORY_DIR, `${userId}.json`); }
function userCampaignFile(userId) { return path.join(CAMPAIGN_DIR, `${userId}.json`); }
function accountSessionDir(accId) { return path.join(SESSION_DIR, accId); }

function hasPermission(role, requiredRole) {
    const weights = { [ROLES.SUPERADMIN]: 4, [ROLES.ADMIN]: 3, [ROLES.MANAGER]: 2, [ROLES.AGENT]: 1 };
    return weights[role] >= weights[requiredRole];
}

function addHistoryRecord(userId, number, message, status, accId = 'default') {
    const file = userHistoryFile(userId);
    const hist = loadJSON(file, []);
    hist.push({ 
        id: Date.now().toString(36), userId, number, message, status, 
        sentAt: new Date().toISOString(), accId 
    });
    saveJSON(file, hist);
    const c = getOrCreateCampaign(userId);
    c.lastUpdate = Date.now();
}

// ── Campaign per user ─────────────────────────────────────────────────────────
const campaigns = new Map(); 

function getOrCreateCampaign(userId) {
    if (!campaigns.has(userId)) {
        campaigns.set(userId, {
            running:false, numbers:[], messages:[], currentIndex:0,
            intervalMs:15000, timer:null, log:[], totalSent:0,
            totalFailed:0, startTime:null, userId,
            autoReplyEnabled: false, autoReplyText: "",
            keywords: [], 
            nextRunAt: 0, remainingMs: 0,
            selectedAccounts: [], // [accId1, accId2]
            currentAccountIdx: 0
        });
    }
    return campaigns.get(userId);
}

function addLog(userId, msg) {
    const c = getOrCreateCampaign(userId);
    const t = new Date().toLocaleTimeString('en-IN', { hour12: true });
    c.log.unshift(`[${t}] ${msg}`);
    if (c.log.length > 300) c.log.length = 300;
    console.log(`[${userId.slice(0,6)}] ${msg}`);
    saveCampaignState(userId);
}

function saveCampaignState(userId) {
    const c = getOrCreateCampaign(userId);
    if (!c.numbers.length) return;
    saveJSON(userCampaignFile(userId), {
        running:c.running, numbers:c.numbers, messages:c.messages,
        currentIndex:c.currentIndex, intervalMs:c.intervalMs,
        totalSent:c.totalSent, totalFailed:c.totalFailed,
        startTime:c.startTime, log:c.log.slice(0, 50),
        autoReplyEnabled: c.autoReplyEnabled,
        autoReplyText: c.autoReplyText,
        keywords: c.keywords || [],
        nextRunAt: c.nextRunAt,
        remainingMs: c.remainingMs,
        selectedAccounts: c.selectedAccounts || [],
        currentAccountIdx: c.currentAccountIdx || 0
    });
}

function scheduleNext(userId, delay) {
    const c = getOrCreateCampaign(userId);
    if (c.timer) clearTimeout(c.timer);
    c.remainingMs = delay;
    c.nextRunAt = Date.now() + delay;
    c.timer = setTimeout(() => sendNext(userId), delay);
    saveCampaignState(userId);
}

function loadCampaignState(userId) {
    const s = loadJSON(userCampaignFile(userId), null);
    if (!s || !s.numbers || s.currentIndex >= s.numbers.length) return;
    const c = getOrCreateCampaign(userId);
    Object.assign(c, { ...s, timer: null });
    addLog(userId, `📂 Resuming: ${s.numbers.length - s.currentIndex} numbers remaining`);
    if (c.running) {
        const now = Date.now();
        const wait = Math.max(1000, c.nextRunAt - now);
        scheduleNext(userId, wait);
    }
}

// ── Bulk sender ───────────────────────────────────────────────────────────────
async function sendNext(userId) {
    const c = getOrCreateCampaign(userId);
    if (!c.running) return;

    if (c.currentIndex >= c.numbers.length) {
        c.running = false; c.timer = null;
        c.nextRunAt = 0; c.remainingMs = 0;
        addLog(userId, `🎉 Campaign Complete! ✅${c.totalSent} ❌${c.totalFailed}`);
        try { fs.unlinkSync(userCampaignFile(userId)); } catch {}
        return;
    }

    if (!c.selectedAccounts?.length) {
        addLog(userId, '❌ Error: No accounts selected for campaign');
        c.running = false; return;
    }

    // Round-robin account selection
    const accId = c.selectedAccounts[c.currentAccountIdx % c.selectedAccounts.length];
    c.currentAccountIdx++;

    const num = String(c.numbers[c.currentIndex]).replace(/\D/g, '');
    const jid = (num.length === 10 ? '91' + num : num) + '@s.whatsapp.net';
    const msg = c.messages[Math.floor(Math.random() * c.messages.length)];
    const idx = c.currentIndex + 1;

    try {
        await sendMessageSafe(userId, accId, jid, msg);
        c.totalSent++;
        addLog(userId, `✅ [${idx}/${c.numbers.length}] Sent via Acc:${accId.slice(0,4)} → +${num}`);
        addHistoryRecord(userId, num, msg, 'sent', accId);
    } catch (e) {
        c.totalFailed++;
        addLog(userId, `❌ [${idx}/${c.numbers.length}] Fail (Acc:${accId.slice(0,4)}): ${e.message}`);
        addHistoryRecord(userId, num, msg, 'failed', accId);
    }

    c.currentIndex++;
    saveCampaignState(userId);

    if (c.currentIndex < c.numbers.length && c.running) {
        const delay = 5000 + Math.random() * 10000;
        scheduleNext(userId, delay);
    } else if (c.running) {
        c.running = false; c.timer = null;
        addLog(userId, `🏁 All done! ✅${c.totalSent} ❌${c.totalFailed}`);
    }
}

// ── Bot handling ──────────────────────────────────────────────────────────────
async function startBotForAccount(userId, accId) {
    let bot = bots.get(accId);
    if (!bot) { 
        bot = { sock:null, status:'waiting', qr:null, reconnDelay:3000, reconnTimer:null, userId, accId }; 
        bots.set(accId, bot); 
    }

    try {
        const sessDir = accountSessionDir(accId);
        fs.mkdirSync(sessDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessDir);
        const { version }          = await fetchLatestBaileysVersion();

        bot.sock = makeWASocket({
            version, auth: state, printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['CRM System', 'Chrome', '1.0.0'],
            syncFullHistory: false
        });

        bot.sock.ev.on('connection.update', update => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { bot.qr = qr; bot.status = 'waiting'; }
            if (connection === 'open') {
                bot.qr = null; bot.status = 'connected'; bot.reconnDelay = 3000;
                const accounts = loadAccounts();
                const acc = accounts.find(a => a.id === accId);
                if (acc) { acc.status = 'active'; saveAccounts(accounts); }
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                bot.status = 'disconnected'; bot.sock = null;
                const accounts = loadAccounts();
                const acc = accounts.find(a => a.id === accId);
                if (acc && code === DisconnectReason.loggedOut) { 
                    acc.status = 'logged_out'; saveAccounts(accounts); 
                    return; 
                }
                bot.reconnDelay = Math.min(bot.reconnDelay * 1.5, 30000);
                if (bot.reconnTimer) clearTimeout(bot.reconnTimer);
                bot.reconnTimer = setTimeout(() => startBotForAccount(userId, accId), bot.reconnDelay);
            }
        });
        bot.sock.ev.on('creds.update', saveCreds);

        bot.sock.ev.on('messages.upsert', async m => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;
                const remoteNum = jid.split('@')[0];
                const incoming = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
                addHistoryRecord(userId, remoteNum, incoming, 'received', accId);
                addLog(userId, `📩 Reply on Account ${accId.slice(0,4)} from +${remoteNum}`);
            }
        });
    } catch (err) {
        bot.reconnTimer = setTimeout(() => startBotForAccount(userId, accId), 5000);
    }
}

async function sendMessageSafe(userId, accId, jid, content, options = {}) {
    const bot = bots.get(accId);
    if (!bot || bot.status !== 'connected') throw new Error('Account not connected');

    // Anti-ban: Typing simulation
    await bot.sock.presenceSubscribe(jid);
    await bot.sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    await bot.sock.sendPresenceUpdate('paused', jid);

    let msgData = {};
    if (typeof content === 'string') {
        msgData = { text: content };
    } else if (content.image) {
        msgData = { image: content.image, caption: content.caption };
    } else if (content.video) {
        msgData = { video: content.video, caption: content.caption };
    } else if (content.document) {
        msgData = { document: content.document, fileName: content.fileName, caption: content.caption };
    }

    return await bot.sock.sendMessage(jid, msgData, options);
}

// ── HTTP Server Logic ─────────────────────────────────────────────────────────
const requestHandler = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-auth-token');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    if (url === '/ping') { res.writeHead(200); res.end('pong'); return; }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); res.end('Error'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(data);
        }); return;
    }

    // POST /api/register
    if (req.method === 'POST' && url === '/api/register') {
        try {
            const { name, email, password } = await parseBody(req);
            const users = loadUsers();
            if (users.find(u => u.email === email.toLowerCase())) return json(res, { error: 'Email already registered' }, 409);
            const user = { id: Date.now().toString(36), name, email: email.toLowerCase(), password: hash(password), role: ROLES.ADMIN, createdAt: new Date().toISOString() };
            users.push(user); saveUsers(users);
            const token = mkTok(); sessions.set(token, { userId: user.id, name: user.name, email: user.email, role: user.role });
            return json(res, { success: true, token, name: user.name });
        } catch (e) { return json(res, { error: e.message }, 400); }
    }

    // POST /api/login
    if (req.method === 'POST' && url === '/api/login') {
        try {
            const { email, password } = await parseBody(req);
            const admE = process.env.ADMIN_EMAIL;
            const admP = process.env.ADMIN_PASS;
            if (admE && admP && email.toLowerCase() === admE.toLowerCase() && password === admP) {
                const token = mkTok();
                sessions.set(token, { userId: 'admin', name: 'Master Admin', email: admE, role: ROLES.SUPERADMIN });
                loadCampaignState('admin');
                return json(res, { success: true, token, name: 'Master Admin' });
            }
            const users = loadUsers();
            const user  = users.find(u => u.email === email.toLowerCase() && u.password === hash(password));
            if (!user) return json(res, { error: 'Wrong email or password' }, 401);
            const token = mkTok(); sessions.set(token, { userId: user.id, name: user.name, email: user.email, role: user.role || ROLES.ADMIN });
            loadCampaignState(user.id);
            return json(res, { success: true, token, name: user.name });
        } catch (e) { return json(res, { error: e.message }, 400); }
    }

    // Auth Middleware
    const me = sessions.get(req.headers['x-auth-token'] || '');
    if (!me) return json(res, { error: 'Unauthorized' }, 401);
    const { userId, role } = me;

    // GET /api/accounts
    if (req.method === 'GET' && url === '/api/accounts') {
        const accounts = loadAccounts().filter(a => a.userId === userId || role === ROLES.SUPERADMIN);
        const list = accounts.map(a => {
            const bot = bots.get(a.id);
            return { ...a, botStatus: bot ? bot.status : 'waiting' };
        });
        return json(res, list);
    }

    // POST /api/accounts/add
    if (req.method === 'POST' && url === '/api/accounts/add') {
        const { name } = await parseBody(req);
        const accounts = loadAccounts();
        const acc = { id: mkTok().slice(0,8), name: name || 'Account', userId, status: 'waiting', createdAt: new Date().toISOString() };
        accounts.push(acc);
        saveAccounts(accounts);
        startBotForAccount(userId, acc.id);
        return json(res, { success: true, accountId: acc.id });
    }

    // DELETE /api/accounts/delete
    if (req.method === 'POST' && url === '/api/accounts/delete') {
        const { accountId } = await parseBody(req);
        let accounts = loadAccounts();
        accounts = accounts.filter(a => a.id !== accountId);
        saveAccounts(accounts);
        const bot = bots.get(accountId);
        if (bot && bot.sock) bot.sock.logout();
        bots.delete(accountId);
        fs.rmSync(accountSessionDir(accountId), { recursive: true, force: true });
        return json(res, { success: true });
    }

    // GET /api/accounts/qr
    if (req.method === 'GET' && url === '/api/accounts/qr') {
        const { accountId } = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
        const bot = bots.get(accountId);
        if (!bot) return json(res, { status: 'waiting', qr: null });
        if (bot.status === 'connected') return json(res, { status: 'connected', qr: null });
        if (bot.qr) {
            const img = await QRCode.toDataURL(bot.qr, { width: 280, margin: 2 });
            return json(res, { status: bot.status, qr: img });
        }
        return json(res, { status: bot.status || 'waiting', qr: null });
    }

    // GET /api/bulk/status
    if (req.method === 'GET' && url === '/api/bulk/status') {
        const c = getOrCreateCampaign(userId);
        return json(res, {
            running:c.running, total:c.numbers.length, currentIndex:c.currentIndex,
            totalSent:c.totalSent, totalFailed:c.totalFailed,
            remaining:c.numbers.length - c.currentIndex,
            log:c.log.slice(0,80), lastUpdate: c.lastUpdate || 0,
            selectedAccounts: c.selectedAccounts || []
        });
    }

    // POST /api/bulk/start
    if (req.method === 'POST' && url === '/api/bulk/start') {
        try {
            const { numbers, messages, accountIds } = await parseBody(req);
            if (!numbers?.length || !messages?.length || !accountIds?.length) return json(res, { error: 'Invalid input' }, 400);
            const c = getOrCreateCampaign(userId);
            if (c.timer) clearTimeout(c.timer);
            Object.assign(c, {
                running:true, numbers, messages, currentIndex:0,
                totalSent:0, totalFailed:0, startTime:new Date().toISOString(), 
                selectedAccounts: accountIds, currentAccountIdx: 0, log: []
            });
            addLog(userId, `🚀 Campaign Started: ${numbers.length} contacts across ${accountIds.length} accounts`);
            scheduleNext(userId, 2000);
            return json(res, { success:true });
        } catch (e) { return json(res, { error:e.message }, 400); }
    }

    // GET /api/history
    if (req.method === 'GET' && url === '/api/history') {
        return json(res, loadJSON(userHistoryFile(userId), []).reverse());
    }

    // POST /api/history/delete-bulk
    if (req.method === 'POST' && url === '/api/history/delete-bulk') {
        const { timestamps } = await parseBody(req);
        let hist = loadJSON(userHistoryFile(userId), []);
        hist = hist.filter(h => !timestamps.includes(h.sentAt));
        saveJSON(userHistoryFile(userId), hist);
        return json(res, { success: true });
    }

    // POST /api/bulk/stop
    if (req.method === 'POST' && url === '/api/bulk/stop') {
        const c = getOrCreateCampaign(userId);
        if (c.timer) { clearTimeout(c.timer); c.timer = null; c.remainingMs = Math.max(0, c.nextRunAt - Date.now()); }
        c.running = false;
        addLog(userId, `⏹️ Paused`);
        saveCampaignState(userId);
        return json(res, { success:true });
    }

    res.writeHead(404); res.end('Not found');
};

const server = http.createServer(requestHandler);
server.listen(PORT, () => {
    console.log(`🚀 CRM Server running on port ${PORT}`);
    const accounts = loadAccounts();
    accounts.forEach(acc => { if (acc.status === 'active') startBotForAccount(acc.userId, acc.id); });
});