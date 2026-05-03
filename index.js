const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const http   = require('http');
const QRCode = require('qrcode');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const connectDB = require('./db');
const { User, Account, Batch, BatchItem, Campaign, History, ContactMaster, Inbox, Message, Assignment } = require('./models');

// ── CONFIG & DIRECTORIES ─────────────────────────────────────────────────────
try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    env.split(/\r?\n/).forEach(line => {
        const i = line.indexOf('=');
        if (i > 0) {
            const k = line.substring(0, i).trim();
            const v = line.substring(i + 1).trim();
            process.env[k] = v;
        }
    });
} catch(e) {}

const PORT          = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET || 'wa_pro_ultra_secure_secret_2026';
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DIR   = path.join(DATA_DIR, 'sessions');

[DATA_DIR, SESSION_DIR].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── SHARED STATE ─────────────────────────────────────────────────────────────
const bots = new Map();
const activeV2Jobs = new Map();
const ROLES = { SUPERADMIN: 'superadmin', ADMIN: 'admin', MANAGER: 'manager', AGENT: 'agent' };

// ── CORE UTILS ───────────────────────────────────────────────────────────────
const mkId  = () => crypto.randomBytes(12).toString('hex');
function json(res, data, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function parseBody(req) { return new Promise((ok, err) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { err(e); } }); }); }

// ── AUTH SYSTEM (JWT) ────────────────────────────────────────────────────────
const signToken = (user) => jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
const verifyToken = (token) => { try { return jwt.verify(token, JWT_SECRET); } catch(e) { return null; } };

// ── SERVICE: MULTI-ACCOUNT ───────────────────────────────────────────────────
async function initBot(userId, accId) {
    let bot = bots.get(accId);
    if (!bot) { bot = { status:'waiting', userId, accId }; bots.set(accId, bot); }
    if (bot.isInitializing) return;
    bot.isInitializing = true;
    console.log(`[SYSTEM] Initializing Bot: ${accId}`);

    try {
        if (bot.sock) { bot.sock.ev.removeAllListeners(); try { bot.sock.ws.close(); } catch(e) {} }
        const sessDir = path.join(SESSION_DIR, accId);
        const { state, saveCreds } = await useMultiFileAuthState(sessDir);
        let version = [2, 2332, 15];
        try { const { version: v } = await fetchLatestBaileysVersion(); version = v; } catch(e) {}
        
        bot.sock = makeWASocket({
            version, auth: state, 
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
        });

        bot.sock.ev.on('creds.update', saveCreds);
        bot.sock.ev.on('connection.update', async (upd) => {
            const { connection, lastDisconnect, qr } = upd;
            if (qr) { bot.qr = qr; bot.status = 'waiting'; bot.isInitializing = false; }
            if (connection === 'open') { 
                bot.status = 'active'; bot.qr = null; bot.isInitializing = false;
                bot.phoneNumber = bot.sock.user.id.split(':')[0];
                bot.lastActive = new Date();
                await Account.findOneAndUpdate({ id: accId }, { phoneNumber: bot.phoneNumber, status: 'active', lastActive: bot.lastActive });
                console.log(`[SYSTEM] Bot Connected: ${accId} (${bot.phoneNumber})`);
            }
            if (connection === 'close') {
                bot.isInitializing = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                bot.status = code === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected';
                await Account.findOneAndUpdate({ id: accId }, { status: bot.status });
                if (code !== DisconnectReason.loggedOut) setTimeout(() => initBot(userId, accId), 10000);
            }
        });
        bot.sock.ev.on('messages.upsert', async m => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const from = msg.key.remoteJid;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                await new Inbox({ id: mkId(), userId, accId, from, text }).save();
            }
        });
    } catch (e) { bot.isInitializing = false; setTimeout(() => initBot(userId, accId), 15000); }
}

// ── SERVICE: CAMPAIGN V2 ─────────────────────────────────────────────────────
async function processV2Campaign(campId) {
    const c = await Campaign.findOne({ id: campId });
    if (!c || c.status !== 'running') return;
    if (c.currentIndex >= c.contacts.length) { 
        c.status = 'completed'; 
        await c.save(); 
        console.log(`[CAMPAIGN] Completed: ${c.name}`);
        return; 
    }

    const accs = await Account.find({ id: { $in: c.accountIds } }).lean();
    const activeAccs = accs.filter(a => bots.get(a.id)?.status === 'active');
    
    if (!activeAccs.length) { 
        console.warn(`[CAMPAIGN] Paused due to NO ACTIVE ACCOUNTS: ${c.name}`);
        c.status = 'paused'; 
        await c.save(); 
        return; 
    }

    const targetAcc = activeAccs[c.currentIndex % activeAccs.length];
    const contact = c.contacts[c.currentIndex];
    const jid = String(contact.number).replace(/\D/g, '') + '@s.whatsapp.net';
    const message = c.template.replace(/{name}/g, contact.name || 'Friend');

    try {
        const bot = bots.get(targetAcc.id);
        if (bot && bot.sock && bot.status === 'active') {
            await bot.sock.sendMessage(jid, { text: message });
            c.sentCount++;
            await new History({ id: mkId(), num: contact.number, msg: message, status: 'sent', accId: targetAcc.id, campName: c.name, userId: c.createdBy }).save();
        } else {
            // Account went offline during process, skip this turn but don't increment index yet to retry with another
            const delay = 5000;
            activeV2Jobs.set(campId, setTimeout(() => processV2Campaign(campId), delay));
            return;
        }
    } catch (e) {
        c.failCount++;
        await new History({ id: mkId(), num: contact.number, msg: message, status: 'failed', accId: targetAcc.id, campName: c.name, userId: c.createdBy }).save();
    }

    c.currentIndex++; 
    await c.save();
    const delay = (c.minDelay + Math.random() * (c.maxDelay - c.minDelay)) * 1000;
    activeV2Jobs.set(campId, setTimeout(() => processV2Campaign(campId), delay));
}

// ── API ROUTES ───────────────────────────────────────────────────────────────
const requestHandler = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-auth-token,authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];
    if (url === '/ping') return json(res, { success: true, message: 'pong' });
    
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        return fs.readFile(path.join(__dirname, 'index.html'), (e, d) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d); });
    }

    if (url === '/api/signup' && req.method === 'POST') {
        const { email, password, name } = await parseBody(req);
        const exists = await User.findOne({ email });
        if (exists) return json(res, { error: 'Email already registered' }, 400);
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        const user = new User({ email, password: hashedPassword, name, role: ROLES.AGENT });
        await user.save();
        return json(res, { success: true });
    }

    if (url === '/api/login' && req.method === 'POST') {
        const { email, password } = await parseBody(req);
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASS) {
            const token = signToken({ userId: 'admin', name: 'Master Admin', role: ROLES.SUPERADMIN });
            return json(res, { success: true, token, name: 'Master Admin', role: ROLES.SUPERADMIN });
        }
        const user = await User.findOne({ email, password: hashedPassword });
        if (user) {
            const token = signToken({ userId: user._id, name: user.name, role: user.role });
            return json(res, { success: true, token, name: user.name, role: user.role });
        }
        return json(res, { error: 'Invalid credentials' }, 401);
    }

    const authHeader = req.headers['x-auth-token'] || req.headers['authorization']?.split(' ')[1] || '';
    const me = verifyToken(authHeader);
    if (!me) return json(res, { error: 'Unauthorized access' }, 401);

    // Accounts
    if (url === '/api/v2/accounts' && req.method === 'GET') {
        const query = me.role === ROLES.SUPERADMIN ? {} : { userId: me.userId, isVisible: true };
        const accs = await Account.find(query).lean();
        const today = new Date().setHours(0,0,0,0);
        const result = await Promise.all(accs.map(async a => {
            const bot = bots.get(a.id);
            const sentToday = await History.countDocuments({ accId: a.id, time: { $gte: today }, status: 'sent' });
            return { ...a, status: bot?.status || a.status || 'waiting', sentToday };
        }));
        return json(res, result);
    }
    if (url === '/api/v2/accounts/add' && req.method === 'POST') {
        const { name } = await parseBody(req);
        const accId = mkId().slice(0,8);
        await new Account({ id: accId, name, userId: me.userId }).save();
        initBot(me.userId, accId);
        return json(res, { success: true, id: accId });
    }
    if (url === '/api/v2/account/status' && req.method === 'POST') {
        const { id, status } = await parseBody(req);
        await Account.findOneAndUpdate({ id }, { status });
        const bot = bots.get(id); if(bot) bot.status = status;
        return json(res, { success: true });
    }
    if (url === '/api/v2/account/visibility' && req.method === 'POST') {
        const { id, isVisible } = await parseBody(req);
        if (me.role !== ROLES.SUPERADMIN) return json(res, { error: 'Forbidden' }, 403);
        await Account.findOneAndUpdate({ id }, { isVisible });
        return json(res, { success: true });
    }

    if (url === '/api/v2/account/delete' && req.method === 'POST') {
        const { id } = await parseBody(req);
        await Account.findOneAndDelete({ id });
        const bot = bots.get(id); 
        if (bot?.sock) {
            try { await bot.sock.logout(); } catch(e) {}
            try { bot.sock.ws.close(); } catch(e) {}
        }
        bots.delete(id);
        
        // Remove session directory
        const sessDir = path.join(SESSION_DIR, id);
        if (fs.existsSync(sessDir)) {
            try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch(e) { console.error(`[SYSTEM] Failed to delete session dir: ${sessDir}`, e); }
        }
        
        return json(res, { success: true });
    }
    if (url === '/api/v2/accounts/qr' && req.method === 'GET') {
        const id = new URL(req.url, `http://${req.headers.host}`).searchParams.get('id');
        const bot = bots.get(id);
        if (bot?.qr) return json(res, { qr: await QRCode.toDataURL(bot.qr) });
        return json(res, { status: bot?.status || 'waiting' });
    }

    if (url === '/api/v2/batch/upload' && req.method === 'POST') {
        const { name, contacts, batchSize } = await parseBody(req);
        const batchId = mkId().slice(0,8);
        const numbers = contacts.map(c => String(c.number).replace(/\D/g, ''));
        const existing = new Set((await ContactMaster.find({ number: { $in: numbers } }).select('number').lean()).map(n => n.number));
        let valid = [], masterEntries = [];
        for (const c of contacts) {
            const num = String(c.number).replace(/\D/g, '');
            if (num && num.length >= 8 && !existing.has(num)) {
                existing.add(num);
                masterEntries.push({ number: num, assigned: true, userId: me.userId, batchId });
                valid.push({ id: mkId(), batchId, number: num, name: c.name || '', status: 'pending' });
            }
        }
        if (!valid.length) return json(res, { error: 'No new unique numbers' }, 400);
        await ContactMaster.insertMany(masterEntries, { ordered: false }).catch(() => {});
        const size = parseInt(batchSize);
        const count = Math.ceil(valid.length / size);
        const batchEntries = [], itemEntries = [];
        for (let i = 0; i < count; i++) {
            const chunk = valid.slice(i * size, (i + 1) * size);
            const subId = `${batchId}_${i+1}`;
            batchEntries.push({ id: subId, parentBatchId: batchId, name: `${name} - Part ${i+1}`, total: chunk.length, createdBy: me.userId });
            chunk.forEach(c => itemEntries.push({ ...c, batchId: subId }));
        }
        await Batch.insertMany(batchEntries);
        await BatchItem.insertMany(itemEntries);
        return json(res, { success: true, count: valid.length, batches: count });
    }

    if (url === '/api/v2/numbers/check' && req.method === 'POST') {
        const { accId, numbers } = await parseBody(req);
        const bot = bots.get(accId);
        if (!bot || bot.status !== 'active') return json(res, { error: 'Account not active or not found' }, 400);
        
        const results = [];
        // Baileys onWhatsApp can take an array, but we'll do it in chunks to be safe
        for (let i = 0; i < numbers.length; i += 20) {
            const chunk = numbers.slice(i, i + 20).map(n => n.replace(/\D/g, '') + '@s.whatsapp.net');
            try {
                const exists = await bot.sock.onWhatsApp(...chunk);
                const existSet = new Set(exists.map(e => e.jid.split('@')[0]));
                numbers.slice(i, i + 20).forEach(num => {
                    const cleanNum = num.replace(/\D/g, '');
                    results.push({ number: num, exists: existSet.has(cleanNum) });
                });
            } catch (e) {
                console.error(`[FILTER] Error checking chunk:`, e);
                numbers.slice(i, i + 20).forEach(num => results.push({ number: num, exists: false, error: true }));
            }
        }
        return json(res, { success: true, results });
    }

    if (url === '/api/v2/campaigns/start' && req.method === 'POST') {
        const data = await parseBody(req);
        const campId = mkId();
        await new Campaign({ id: campId, ...data, createdBy: me.userId }).save();
        processV2Campaign(campId);
        return json(res, { success: true, id: campId });
    }

    if (url === '/api/v2/campaign/control' && req.method === 'POST') {
        const { id, action } = await parseBody(req);
        const c = await Campaign.findOne({ id });
        if (c) {
            if (action === 'pause') { c.status = 'paused'; clearTimeout(activeV2Jobs.get(id)); }
            if (action === 'resume') { c.status = 'running'; processV2Campaign(id); }
            if (action === 'delete') { clearTimeout(activeV2Jobs.get(id)); await Campaign.findOneAndDelete({ id }); }
            else await c.save();
            return json(res, { success: true });
        }
        return json(res, { error: 'Not found' }, 404);
    }

    if (url === '/api/v2/history' && req.method === 'GET') {
        const limit = parseInt(new URL(req.url, `http://${req.headers.host}`).searchParams.get('limit')) || 1000;
        const hist = await History.find(me.role === ROLES.SUPERADMIN ? {} : { userId: me.userId }).sort({ time: -1 }).limit(limit).lean();
        return json(res, hist);
    }
    if (url === '/api/v2/inbox' && req.method === 'GET') {
        const inbox = await Inbox.find(me.role === ROLES.SUPERADMIN ? {} : { userId: me.userId }).sort({ time: -1 }).lean();
        return json(res, inbox);
    }
    if (url === '/api/v2/inbox/reply' && req.method === 'POST') {
        const { accId, from, text } = await parseBody(req);
        const bot = bots.get(accId);
        if (!bot || bot.status !== 'active') return json(res, { error: 'Account not active' }, 400);
        await bot.sock.sendMessage(from, { text });
        return json(res, { success: true });
    }

    if (url === '/api/v2/batch/reset' && req.method === 'POST') {
        await ContactMaster.deleteMany(me.role === ROLES.SUPERADMIN ? {} : { userId: me.userId });
        await Batch.deleteMany(me.role === ROLES.SUPERADMIN ? {} : { createdBy: me.userId });
        await BatchItem.deleteMany({}); // Items are usually cleared via parent batch, but we can wipe all if needed
        return json(res, { success: true });
    }

    if (url === '/api/v2/history/clear' && req.method === 'POST') {
        await History.deleteMany(me.role === ROLES.SUPERADMIN ? {} : { userId: me.userId });
        return json(res, { success: true });
    }

    if (url === '/api/v2/campaigns' && req.method === 'GET') {
        const camps = await Campaign.find(me.role === ROLES.SUPERADMIN ? {} : { createdBy: me.userId }).sort({ createdAt: -1 }).lean();
        return json(res, camps);
    }

    res.writeHead(404); res.end();
};

const server = http.createServer(requestHandler);
server.listen(PORT, async () => {
    console.log(`🚀 MASTER CRM V4.1.0 [USERS + DB + JWT] PORT: ${PORT}`);
    await connectDB();
    (await Account.find({})).forEach(a => initBot(a.userId, a.id));
    (await Campaign.find({ status: 'running' })).forEach(c => processV2Campaign(c.id));

    // ── RENDER 24/7 PING ──────────────────────────────────────────────────────
    const URL_TO_PING = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
    if (URL_TO_PING) {
        console.log(`[SYSTEM] Self-ping started for: ${URL_TO_PING}`);
        setInterval(() => {
            http.get(`${URL_TO_PING}/ping`, (res) => {
                console.log(`[PING] Status: ${res.statusCode} at ${new Date().toISOString()}`);
            }).on('error', (err) => {
                console.error(`[PING] Error: ${err.message}`);
            });
        }, 8 * 60 * 1000); // Ping every 8 minutes
    } else {
        console.warn("[SYSTEM] RENDER_EXTERNAL_URL not found. Skipping self-ping.");
    }
});