import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MESSAGES_DB = path.join(
  os.homedir(),
  'Library',
  'Messages',
  'chat.db',
);

// macOS Cocoa epoch: 2001-01-01 00:00:00 UTC in Unix seconds
const COCOA_EPOCH_OFFSET = 978307200;
const POLL_MS = 2000;
const JID_SUFFIX = '@imessage';

function cocoaToIso(cocoaDate: number): string {
  // Modern macOS stores date in nanoseconds; older in seconds
  const secs = cocoaDate > 1e12 ? cocoaDate / 1e9 : cocoaDate;
  return new Date((secs + COCOA_EPOCH_OFFSET) * 1000).toISOString();
}

/** Escape text for an AppleScript double-quoted string. */
function appleScriptLiteral(text: string): string {
  const lines = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .split('\n');
  // Join multi-line text using AppleScript string concatenation
  return lines.map((l) => `"${l}"`).join(' & return & ');
}

export function chatGuidToJid(guid: string): string {
  return `${guid}${JID_SUFFIX}`;
}

export function jidToChatGuid(jid: string): string {
  return jid.endsWith(JID_SUFFIX) ? jid.slice(0, -JID_SUFFIX.length) : jid;
}

export interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Called when a message arrives from an unregistered JID.
   * If provided, the channel will auto-register the JID so it gets routed.
   */
  autoRegister?: (jid: string) => void;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private opts: IMessageChannelOpts;

  constructor(opts: IMessageChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Seed lastRowId to current max so we don't replay old history
    try {
      const db = new Database(MESSAGES_DB, {
        readonly: true,
        fileMustExist: true,
      });
      const row = db
        .prepare('SELECT MAX(ROWID) as maxId FROM message')
        .get() as { maxId: number | null };
      this.lastRowId = row?.maxId ?? 0;
      db.close();
    } catch (err) {
      logger.error(
        { err },
        'Cannot open Messages DB — grant Full Disk Access to Terminal/Node',
      );
      throw err;
    }

    this.connected = true;
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    logger.info({ lastRowId: this.lastRowId }, 'iMessage channel connected');
  }

  private poll(): void {
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(MESSAGES_DB, { readonly: true, fileMustExist: true });

      const rows = db
        .prepare(
          `SELECT
            m.ROWID          AS rowid,
            m.text,
            m.date,
            m.is_from_me,
            h.id             AS sender_id,
            c.guid           AS chat_guid,
            c.display_name   AS chat_name
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c               ON c.ROWID = cmj.chat_id
          LEFT JOIN handle h        ON h.ROWID = m.handle_id
          WHERE m.ROWID > ?
            AND m.text IS NOT NULL
            AND m.text != ''
          ORDER BY m.ROWID ASC`,
        )
        .all(this.lastRowId) as Array<{
        rowid: number;
        text: string;
        date: number;
        is_from_me: number;
        sender_id: string | null;
        chat_guid: string;
        chat_name: string | null;
      }>;

      db.close();
      db = null;

      for (const row of rows) {
        this.lastRowId = row.rowid;

        const jid = chatGuidToJid(row.chat_guid);
        const timestamp = cocoaToIso(row.date);
        const isGroup =
          row.chat_guid.includes(';+;') || !!row.chat_name;

        this.opts.onChatMetadata(
          jid,
          timestamp,
          row.chat_name || undefined,
          'imessage',
          isGroup,
        );

        let groups = this.opts.registeredGroups();
        if (!groups[jid]) {
          if (this.opts.autoRegister) {
            this.opts.autoRegister(jid);
            groups = this.opts.registeredGroups();
          }
          if (!groups[jid]) continue;
        }

        const fromMe = row.is_from_me === 1;
        const isBotMessage = fromMe && row.text.startsWith(`${ASSISTANT_NAME}:`);

        this.opts.onMessage(jid, {
          id: String(row.rowid),
          chat_jid: jid,
          sender: row.sender_id ?? 'me',
          sender_name: fromMe ? 'Me' : (row.sender_id ?? 'Unknown'),
          content: row.text,
          timestamp,
          is_from_me: fromMe,
          is_bot_message: isBotMessage,
        });
      }
    } catch (err) {
      logger.debug({ err }, 'iMessage poll error');
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatGuid = jidToChatGuid(jid);
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    const literal = appleScriptLiteral(prefixed);

    const script = `tell application "Messages"
  send ${literal} to chat id "${chatGuid}"
end tell`;

    const tmpScript = path.join(os.tmpdir(), `nanoclaw_send_${Date.now()}.scpt`);
    fs.writeFileSync(tmpScript, script, 'utf-8');

    return new Promise((resolve, reject) => {
      exec(`osascript ${JSON.stringify(tmpScript)}`, (err) => {
        fs.rmSync(tmpScript, { force: true });
        if (err) {
          logger.error({ err, jid }, 'Failed to send iMessage');
          reject(err);
        } else {
          logger.info({ jid, length: prefixed.length }, 'iMessage sent');
          resolve();
        }
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
