import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { WebSocket, WebSocketServer } from 'ws';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from '../config.js';
import { getMessagesSince } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export const WEBCHAT_JID = 'webchat@web';
export const WEBCHAT_PORT = parseInt(process.env.WEB_CHAT_PORT || '3001', 10);

const JID_SUFFIX = '@web';

function getLocalIp(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function chatHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Narrova AI</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f0f2f5;
    --surface: #ffffff;
    --user-bubble: #0084ff;
    --bot-bubble: #e4e6eb;
    --bot-text: #1c1e21;
    --header: #1c1e21;
    --border: #ddd;
    --input-bg: #f0f2f5;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); height: 100dvh; display: flex; flex-direction: column; }
  header { background: var(--header); color: #fff; padding: 14px 20px;
           display: flex; align-items: center; gap: 12px; flex-shrink: 0;
           box-shadow: 0 1px 4px rgba(0,0,0,.3); }
  .avatar { width: 38px; height: 38px; border-radius: 50%; background: #0084ff;
            display: flex; align-items: center; justify-content: center;
            font-size: 18px; font-weight: 600; color: #fff; flex-shrink: 0; }
  header h1 { font-size: 17px; font-weight: 600; }
  header .status { font-size: 12px; opacity: .7; }
  #messages { flex: 1; overflow-y: auto; padding: 16px;
              display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 72%; padding: 10px 14px; border-radius: 18px;
         font-size: 15px; line-height: 1.45; word-break: break-word;
         animation: fadein .15s ease; }
  @keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
  .msg.user { align-self: flex-end; background: var(--user-bubble); color: #fff;
              border-bottom-right-radius: 4px; }
  .msg.bot  { align-self: flex-start; background: var(--bot-bubble); color: var(--bot-text);
              border-bottom-left-radius: 4px; }
  .msg.system { align-self: center; font-size: 12px; color: #888;
                background: none; padding: 2px 8px; }
  .msg pre { white-space: pre-wrap; font-family: 'SF Mono', monospace; font-size: 13px; }
  .msg img.inline-thumb { max-width: 100%; max-height: 200px; border-radius: 8px;
                          display: block; margin-top: 6px; }
  .typing { align-self: flex-start; padding: 12px 16px; background: var(--bot-bubble);
            border-radius: 18px; border-bottom-left-radius: 4px;
            display: none; gap: 4px; align-items: center; }
  .typing.visible { display: flex; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #888;
         animation: bounce 1.4s infinite ease-in-out; }
  .dot:nth-child(2) { animation-delay: .2s; }
  .dot:nth-child(3) { animation-delay: .4s; }
  @keyframes bounce { 0%,80%,100% { transform: scale(0); } 40% { transform: scale(1); } }
  .attach-bar { padding: 6px 16px 0; background: var(--surface);
                border-top: 1px solid var(--border); display: none;
                align-items: center; gap: 8px; flex-shrink: 0; }
  .attach-bar.visible { display: flex; }
  .attach-chip { display: inline-flex; align-items: center; gap: 6px;
                 background: var(--input-bg); border: 1px solid var(--border);
                 border-radius: 16px; padding: 4px 10px; font-size: 13px; max-width: 260px; }
  .attach-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach-chip .clear-btn { background: none; border: none; cursor: pointer; color: #888;
                             font-size: 14px; padding: 0 2px; line-height: 1;
                             width: auto; height: auto; border-radius: 0; }
  .attach-thumb { max-height: 48px; border-radius: 6px; object-fit: contain; display: none; }
  form { display: flex; gap: 8px; padding: 10px 16px;
         background: var(--surface); border-top: 1px solid var(--border); flex-shrink: 0; }
  textarea { flex: 1; background: var(--input-bg); border: none; border-radius: 22px;
             padding: 10px 16px; font-size: 15px; font-family: inherit; resize: none;
             max-height: 140px; outline: none; line-height: 1.4; }
  button { width: 42px; height: 42px; border-radius: 50%; border: none;
           background: var(--user-bubble); color: #fff; cursor: pointer;
           font-size: 20px; display: flex; align-items: center; justify-content: center;
           flex-shrink: 0; align-self: flex-end; transition: opacity .15s; }
  button:disabled { opacity: .4; cursor: default; }
  button:hover:not(:disabled) { opacity: .85; }
  .attach-btn { background: var(--input-bg); color: #555; border: 1px solid var(--border);
                font-size: 18px; }
  .attach-btn:hover:not(:disabled) { background: var(--border); opacity: 1; }
  .offline-banner { background: #e74c3c; color: #fff; text-align: center;
                    font-size: 13px; padding: 6px; display: none; }
  .offline-banner.visible { display: block; }
</style>
</head>
<body>
<input type="file" id="fileInput" style="display:none"
  accept="image/*,.pdf,.txt,.csv,.json,.md,.docx,.xlsx,.py,.js,.ts,.html,.css">
<header>
  <div class="avatar">N</div>
  <div>
    <h1>Narrova AI</h1>
    <div class="status" id="status">Connecting\u2026</div>
  </div>
</header>
<div class="offline-banner" id="offlineBanner">Reconnecting\u2026</div>
<div id="messages"></div>
<div class="typing" id="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
<div class="attach-bar" id="attachBar">
  <div class="attach-chip">
    <span id="attachName"></span>
    <button type="button" class="clear-btn" id="attachClear" title="Remove attachment">\u2715</button>
  </div>
  <img class="attach-thumb" id="attachThumb" alt="">
</div>
<form id="form">
  <button type="button" class="attach-btn" id="attachBtn" title="Attach file">&#x1F4CE;</button>
  <textarea id="input" placeholder="Message Narrova AI\u2026" rows="1"></textarea>
  <button type="submit" id="sendBtn">&#x27A4;</button>
</form>
<script>
const messagesEl  = document.getElementById('messages');
const inputEl     = document.getElementById('input');
const sendBtn     = document.getElementById('sendBtn');
const typing      = document.getElementById('typing');
const statusEl    = document.getElementById('status');
const banner      = document.getElementById('offlineBanner');
const fileInput   = document.getElementById('fileInput');
const attachBtn   = document.getElementById('attachBtn');
const attachBar   = document.getElementById('attachBar');
const attachName  = document.getElementById('attachName');
const attachClear = document.getElementById('attachClear');
const attachThumb = document.getElementById('attachThumb');

let ws, reconnectTimer;
let pendingAttachment = null;

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;');
}

function renderText(t) {
  return t
    .replace(/\`\`\`([\s\S]*?)\`\`\`/g, (_,c) => '<pre>' + escapeHtml(c.trim()) + '</pre>')
    .replace(/!\\[([^\\]]*?)\\]\\(([^)]+?)\\)/g, (_,alt,src) => '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" style="max-width:100%;max-height:400px;border-radius:8px;display:block;margin-top:6px;" loading="lazy">')
    .replace(/\\[([^\\]]+?)\\]\\(([^)]+?)\\)/g, (_,text,href) => '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(text) + '</a>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/\\n/g, '<br>');
}

function addMessage(role, text, prepend, imageDataUrl) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = renderText(text);
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'inline-thumb';
    img.src = imageDataUrl;
    div.appendChild(img);
  }
  if (prepend) {
    messagesEl.insertBefore(div, messagesEl.firstChild);
  } else {
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function clearAttachment() {
  pendingAttachment = null;
  attachBar.classList.remove('visible');
  attachThumb.style.display = 'none';
  attachThumb.src = '';
  attachName.textContent = '';
}

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    pendingAttachment = { filename: file.name, mimeType: file.type, data: base64, previewUrl: dataUrl };
    attachName.textContent = file.name;
    attachBar.classList.add('visible');
    if (file.type.startsWith('image/')) {
      attachThumb.src = dataUrl;
      attachThumb.style.display = 'block';
    } else {
      attachThumb.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

attachClear.addEventListener('click', clearAttachment);

function connect() {
  ws = new WebSocket('ws://' + location.host);
  ws.onopen = () => {
    statusEl.textContent = 'Online';
    banner.classList.remove('visible');
    sendBtn.disabled = false;
  };
  ws.onclose = () => {
    statusEl.textContent = 'Offline';
    banner.classList.add('visible');
    sendBtn.disabled = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'history') {
      msg.messages.forEach(m => addMessage(m.is_bot ? 'bot' : 'user', m.content, true));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (msg.type === 'message') {
      typing.classList.remove('visible');
      addMessage(msg.is_bot ? 'bot' : 'user', msg.content);
    } else if (msg.type === 'typing') {
      typing.classList.toggle('visible', msg.active);
      if (msg.active) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };
}

document.getElementById('form').addEventListener('submit', e => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text && !pendingAttachment) return;
  if (ws.readyState !== WebSocket.OPEN) return;

  const outMsg = { type: 'message', content: text, attachment: null };
  let imagePreview = null;
  if (pendingAttachment) {
    outMsg.attachment = {
      filename: pendingAttachment.filename,
      mimeType: pendingAttachment.mimeType,
      data: pendingAttachment.data,
    };
    if (pendingAttachment.mimeType.startsWith('image/')) {
      imagePreview = pendingAttachment.previewUrl;
    }
  }

  ws.send(JSON.stringify(outMsg));

  const displayText = text || pendingAttachment.filename;
  addMessage('user', escapeHtml(displayText), false, imagePreview);

  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearAttachment();
  typing.classList.add('visible');
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('form').requestSubmit();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
});

connect();
</script>
</body>
</html>`;
}

export interface WebChatChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WebChatChannel implements Channel {
  name = 'webchat';

  private server!: http.Server;
  private wss!: WebSocketServer;
  private clients = new Set<WebSocket>();
  private connected = false;
  private opts: WebChatChannelOpts;

  constructor(opts: WebChatChannelOpts) {
    this.opts = opts;
  }

  private getUploadDir(): string {
    const groupFolder = resolveGroupFolderPath(MAIN_GROUP_FOLDER);
    const dir = path.join(groupFolder, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async connect(): Promise<void> {
    const html = chatHtml();

    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (req.url?.startsWith('/uploads/')) {
        // Serve generated/uploaded files from the group uploads folder
        const filename = path.basename(req.url.slice('/uploads/'.length));
        const filePath = path.join(this.getUploadDir(), filename);
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const ext = path.extname(filename).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
            '.pdf': 'application/pdf', '.txt': 'text/plain',
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      // Send recent message history
      const history = getMessagesSince(WEBCHAT_JID, '', ASSISTANT_NAME).slice(-50);
      ws.send(
        JSON.stringify({
          type: 'history',
          messages: history.map((m) => ({
            content: m.content,
            is_bot: m.is_bot_message,
          })),
        }),
      );

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            content?: string;
            attachment?: { filename: string; mimeType: string; data: string };
          };
          if (msg.type !== 'message') return;

          let content = msg.content?.trim() || '';

          // Save attachment to group uploads folder (mounted at /workspace/group/uploads/ in container)
          if (msg.attachment?.data) {
            const safe = msg.attachment.filename
              .replace(/[^a-zA-Z0-9._-]/g, '_')
              .slice(0, 100);
            const filename = `${Date.now()}_${safe}`;
            const filePath = path.join(this.getUploadDir(), filename);
            fs.writeFileSync(filePath, Buffer.from(msg.attachment.data, 'base64'));
            const containerPath = `/workspace/group/uploads/${filename}`;
            const note = `[Attached file: ${containerPath}]`;
            content = content ? `${content}\n\n${note}` : note;
            logger.info({ filename, mimeType: msg.attachment.mimeType }, 'Webchat attachment saved');
          }

          if (!content) return;

          const timestamp = new Date().toISOString();
          const inbound: NewMessage = {
            id: `web-${Date.now()}`,
            chat_jid: WEBCHAT_JID,
            sender: 'user@web',
            sender_name: 'User',
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
          };

          this.opts.onChatMetadata(WEBCHAT_JID, timestamp, 'Web Chat', 'webchat', false);
          this.opts.onMessage(WEBCHAT_JID, inbound);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    await new Promise<void>((resolve, reject) => {
      this.server.listen(WEBCHAT_PORT, '0.0.0.0', () => resolve());
      this.server.on('error', reject);
    });

    this.connected = true;
    const ip = getLocalIp();
    logger.info(
      { port: WEBCHAT_PORT, url: `http://${ip}:${WEBCHAT_PORT}` },
      `Web chat available at http://${ip}:${WEBCHAT_PORT}`,
    );
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    // Strip "Sydney: " prefix — the UI already knows who is speaking
    const stripped = text.startsWith(`${ASSISTANT_NAME}: `)
      ? text.slice(ASSISTANT_NAME.length + 2)
      : text;

    const payload = JSON.stringify({ type: 'message', content: stripped, is_bot: true });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    const payload = JSON.stringify({ type: 'typing', active: isTyping });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const client of this.clients) client.close();
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
