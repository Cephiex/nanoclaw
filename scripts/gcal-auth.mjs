#!/usr/bin/env node
/**
 * One-time Google Calendar OAuth 2.0 setup.
 * Writes GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN to .env
 *
 * Usage: node scripts/gcal-auth.mjs
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import readline from 'readline';
import { exec } from 'child_process';
import querystring from 'querystring';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

const SCOPES       = 'https://www.googleapis.com/auth/calendar';
const REDIRECT_PORT = 9876;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('\n=== Google Calendar OAuth Setup ===\n');

  // Accept credentials as CLI args: node gcal-auth.mjs <clientId> <clientSecret>
  let clientId     = process.argv[2]?.trim() || '';
  let clientSecret = process.argv[3]?.trim() || '';

  if (!clientId || !clientSecret) {
    console.log('Prerequisites:');
    console.log('  1. Go to https://console.cloud.google.com/');
    console.log('  2. Create a project (or select one)');
    console.log('  3. Enable "Google Calendar API" under APIs & Services');
    console.log('  4. Go to Credentials → Create Credentials → OAuth 2.0 Client IDs');
    console.log('  5. Application type: Desktop app');
    console.log('  6. Copy the Client ID and Client Secret shown\n');
    clientId     = (await ask('Client ID:     ')).trim();
    clientSecret = (await ask('Client Secret: ')).trim();
  }
  rl.close();

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams}`;

  console.log('\nOpening browser...');
  exec(`open "${authUrl}"`);
  console.log('If the browser did not open, visit:\n' + authUrl + '\n');

  // Catch the OAuth callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1 style="font-family:sans-serif">Authorized! You can close this tab.</h1>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error: ${error}</h1>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
      }
    });
    server.listen(REDIRECT_PORT, () =>
      console.log(`Waiting for authorization callback on port ${REDIRECT_PORT}...`));
    setTimeout(() => { server.close(); reject(new Error('Timed out waiting for authorization')); }, 120000);
  });

  console.log('Authorization received, exchanging for tokens...');

  const tokenBody = querystring.stringify({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokens = await new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenBody),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(tokenBody);
    req.end();
  });

  if (tokens.error) {
    console.error('Token exchange failed:', tokens.error_description || tokens.error);
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    console.error('No refresh_token received. Revoke app access at https://myaccount.google.com/permissions and try again.');
    process.exit(1);
  }

  // Write credentials to .env
  let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
  const updates = {
    GOOGLE_CLIENT_ID:     clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
  };
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(env)) {
      env = env.replace(re, `${key}=${value}`);
    } else {
      if (!env.endsWith('\n') && env.length > 0) env += '\n';
      env += `${key}=${value}\n`;
    }
  }
  fs.writeFileSync(ENV_FILE, env);

  console.log('\n✓ Credentials saved to .env');
  console.log('\nOptional: set GOOGLE_CALENDAR_ID=<id> in .env to use a non-primary calendar.');
  console.log('Run "node scripts/gcal-auth.mjs" again if you ever need to re-authorize.\n');
  console.log('Next steps:');
  console.log('  1. ./container/build.sh    (rebuilds image with gcal script)');
  console.log('  2. Restart NanoClaw        (launchctl kickstart -k gui/$(id -u)/com.nanoclaw)');
}

main().catch(e => { console.error(e.message); process.exit(1); });
