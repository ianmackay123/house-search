// server.js — local dev server
// Serves static files + SSE scrape endpoints
// Run with: npm run serve
// Then open http://localhost:8080

import http from 'http';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css':  'text/css',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

let activeChild = null; // only one scrape at a time

const server = http.createServer(async (req, res) => {
  // ── Scrape endpoint: GET /scrape?source=all|airbnb|kateandtoms|groupaccommodation
  if (req.url.startsWith('/scrape')) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const source = params.get('source') || 'all';

    if (activeChild) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('A scrape is already running');
      return;
    }

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const args = ['scrape.js'];
    if (source !== 'all') args.push(`--only=${source}`);

    console.log(`[server] Starting scrape: ${source}`);
    activeChild = spawn('node', args, { cwd: __dirname });

    function sendLine(line) {
      if (line.trim()) res.write(`data: ${JSON.stringify(line.trimEnd())}\n\n`);
    }

    let stdoutBuf = '';
    activeChild.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep incomplete line buffered
      lines.forEach(sendLine);
    });

    activeChild.stderr.on('data', chunk => {
      chunk.toString().split('\n').forEach(l => {
        if (l.trim()) sendLine('[err] ' + l);
      });
    });

    activeChild.on('close', code => {
      if (stdoutBuf.trim()) sendLine(stdoutBuf);
      res.write(`data: ${JSON.stringify('__done__:' + code)}\n\n`);
      res.end();
      activeChild = null;
      console.log(`[server] Scrape finished (exit ${code})`);
    });

    req.on('close', () => {
      if (activeChild) { activeChild.kill(); activeChild = null; }
    });

    return;
  }

  // ── Kill endpoint: POST /scrape/kill
  if (req.url === '/scrape/kill' && req.method === 'POST') {
    if (activeChild) { activeChild.kill(); activeChild = null; }
    res.writeHead(200); res.end('killed');
    return;
  }

  // ── Static file serving
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = join(__dirname, urlPath);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found: ' + urlPath);
  }
});

server.listen(PORT, () => {
  console.log(`\nDev server running at http://localhost:${PORT}\n`);
  console.log('Scrape endpoints:');
  console.log('  GET /scrape?source=all');
  console.log('  GET /scrape?source=kateandtoms');
  console.log('  GET /scrape?source=airbnb');
  console.log('  GET /scrape?source=groupaccommodation\n');
});
