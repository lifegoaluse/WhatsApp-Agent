import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeInMemoryStore, 
    jidDecode 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';

// Handle __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SECRET_KEY = process.env.SECRET_KEY || 'whatsapp-agent-ultra-secret';

// Ensure directories exist
[DATA_DIR, SESSIONS_DIR, CAMPAIGNS_DIR, HISTORY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

// Express & Socket.io Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Global State
const sessions = new Map(); // userId -> { sock, qr, status }
const campaigns = new Map(); // campaignId -> { data, interval, status }

// --- Auth Helpers ---
const getUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// --- WhatsApp Logic ---
async function startWhatsApp(userId, socketId = null) {
    const userSessionDir = path.join(SESSIONS_DIR, userId);
    const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Agent', 'Chrome', '1.0.0']
    });

    sessions.set(userId, { sock, status: 'connecting', qr: null });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrDataURL = await qrcode.toDataURL(qr);
            sessions.get(userId).qr = qrDataURL;
            if (socketId) io.to(socketId).emit('qr', { userId, qr: qrDataURL });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut : true;
            
            console.log(`Connection closed for ${userId}. Reconnecting: ${shouldReconnect}`);
            sessions.get(userId).status = 'disconnected';
            io.emit('session-update', { userId, status: 'disconnected' });

            if (shouldReconnect) {
                startWhatsApp(userId);
            } else {
                if (fs.existsSync(userSessionDir)) fs.rmSync(userSessionDir, { recursive: true, force: true });
                sessions.delete(userId);
            }
        } else if (connection === 'open') {
            console.log(`WhatsApp connected for ${userId}`);
            sessions.get(userId).status = 'connected';
            sessions.get(userId).qr = null;
            io.emit('session-update', { userId, status: 'connected' });
        }
    });

    // Message handling (Auto-reply & Keywords)
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();

        // Load auto-reply settings (Simplified for now)
        const keywords = {
            'hello': 'Hi there! How can I help you today?',
            'price': 'Our pricing starts at $10/month. Visit our website for more details.',
            'help': 'I am an automated assistant. Type "price" or "hello" for more info.'
        };

        for (const [key, reply] of Object.entries(keywords)) {
            if (text.includes(key)) {
                await sock.sendMessage(from, { text: reply });
                break;
            }
        }
    });

    return sock;
}

// --- Routes ---
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'User exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), username, password: hashedPassword };
    users.push(newUser);
    saveUsers(users);
    res.json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, SECRET_KEY);
    res.json({ token, user: { id: user.id, username: user.username } });
});

// --- Socket.io Events ---
io.on('connection', (socket) => {
    socket.on('init-session', async ({ userId }) => {
        if (sessions.has(userId) && sessions.get(userId).status === 'connected') {
            socket.emit('session-update', { userId, status: 'connected' });
        } else {
            await startWhatsApp(userId, socket.id);
        }
    });

    socket.on('logout-session', async ({ userId }) => {
        const session = sessions.get(userId);
        if (session && session.sock) {
            await session.sock.logout();
            sessions.delete(userId);
            const userSessionDir = path.join(SESSIONS_DIR, userId);
            if (fs.existsSync(userSessionDir)) fs.rmSync(userSessionDir, { recursive: true, force: true });
            socket.emit('session-update', { userId, status: 'logged-out' });
        }
    });

    socket.on('validate-numbers', async ({ userId, numbers }) => {
        const session = sessions.get(userId);
        if (!session || session.status !== 'connected') return socket.emit('error', 'WhatsApp not connected');

        const results = [];
        for (const num of numbers) {
            const jid = num.includes('@s.whatsapp.net') ? num : `${num.replace(/\D/g, '')}@s.whatsapp.net`;
            try {
                const [result] = await session.sock.onWhatsApp(jid);
                results.push({ number: num, exists: !!result?.exists, jid: result?.jid });
            } catch (err) {
                results.push({ number: num, exists: false, error: err.message });
            }
        }
        socket.emit('validator-results', results);
    });

    socket.on('start-campaign', async (campaignData) => {
        const { userId, name, contacts, message, delay } = campaignData;
        const session = sessions.get(userId);
        if (!session || session.status !== 'connected') return socket.emit('error', 'WhatsApp not connected');

        const campaignId = Date.now().toString();
        let currentIndex = 0;

        const campaign = {
            id: campaignId,
            name,
            total: contacts.length,
            sent: 0,
            failed: 0,
            status: 'running',
            results: []
        };

        campaigns.set(campaignId, campaign);

        const runNext = async () => {
            if (currentIndex >= contacts.length) {
                campaign.status = 'completed';
                io.emit('campaign-update', campaign);
                return;
            }

            const contact = contacts[currentIndex];
            const jid = contact.includes('@s.whatsapp.net') ? contact : `${contact.replace(/\D/g, '')}@s.whatsapp.net`;

            try {
                // Spin-tax logic here if needed
                await session.sock.sendMessage(jid, { text: message });
                campaign.sent++;
                campaign.results.push({ contact, status: 'success' });
            } catch (err) {
                campaign.failed++;
                campaign.results.push({ contact, status: 'failed', error: err.message });
            }

            currentIndex++;
            io.emit('campaign-progress', { campaignId, sent: campaign.sent, failed: campaign.failed, total: campaign.total });
            
            setTimeout(runNext, delay * 1000);
        };

        runNext();
    });
});

// Auto-resume sessions
const resumeSessions = async () => {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const userDirs = fs.readdirSync(SESSIONS_DIR);
    for (const userId of userDirs) {
        console.log(`Resuming session for ${userId}`);
        await startWhatsApp(userId);
    }
};

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    resumeSessions();
});
