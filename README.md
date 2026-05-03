# 🚀 WhatsApp Bulk Automation Platform

A production-ready, multi-user WhatsApp bulk messaging service with background task management, persistence, and data visualization.

![UI Screenshot](https://img.icons8.com/color/144/whatsapp--v1.png)

## ✨ Key Features

- **🔐 Multi-User Authentication**: Secure registration and login system.
- **📱 Individual WhatsApp Sessions**: Each user links their own WhatsApp account via unique QR codes.
- **📡 Background Messaging**: Campaigns continue running on the server even if you logout or close the browser.
- **🔄 Auto-Resume**: Smart persistence detects pending campaigns on login or server restart.
- **📊 Real-time Dashboard**: Track sent, failed, and remaining messages with a live progress bar.
- **📋 Bulk Input**: Upload Excel/CSV files or paste raw numbers in any format.
- **📝 Message Templates**: Add multiple message variations; the system picks one randomly for each number.
- **📤 Data Export**: Generate professional PDF reports and Excel logs of your messaging history.
- **⚡ Performance**: Built with `@whiskeysockets/baileys` for a fast and stable connection.

## 🛠 Tech Stack

- **Backend**: Node.js (HTTP, FileSystem, Crypto)
- **WhatsApp Engine**: Baileys
- **Frontend**: Vanilla HTML5, CSS3 (Glassmorphism), JavaScript (ES6+)
- **Libraries**: 
  - `SheetJS` (Excel Parsing)
  - `jsPDF` + `AutoTable` (PDF Generation)
  - `Pino` (Logging)
  - `QRCode` (QR Generation)

## 🚀 Quick Start (Local)

1. **Clone the repository**
   ```bash
   git clone https://github.com/Siddhantnaik909/WhatsApp-automation-.git
   cd WhatsApp-automation-
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **Access the app**
   Open `http://localhost:3000` in your browser.

## 🌐 Deployment (Render)

This project is pre-configured for **Render**.

1. Connect this GitHub repo to your Render dashboard.
2. Render will automatically detect the `render.yaml` file.
3. **Important**: If using the Free Tier, the server will sleep after 15 mins. The app includes a "Self-Ping" mechanism, but for 100% uptime, use a "Starter" plan with a "Persistent Disk" mounted to `/sessions`.

## 📁 Project Structure

- `index.js`: Core server, authentication, and WhatsApp bot logic.
- `index.html`: Modern dashboard UI with tabs and exports.
- `sessions/`: (Auto-generated) Stores encrypted WhatsApp login states.
- `campaigns/`: (Auto-generated) Stores active background task states.
- `history/`: (Auto-generated) Stores user messaging logs.
- `users.json`: (Auto-generated) Encrypted user database.

## 🛡️ Security

- Passwords are hashed using **SHA-256**.
- Sessions are isolated; users cannot see each other's data or WhatsApp connections.
- `.gitignore` prevents sensitive data from being uploaded to public repositories.

---
Developed with ❤️ by Siddhant Naik
