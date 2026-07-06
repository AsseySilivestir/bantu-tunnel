#!/usr/bin/env node
/**
 * Bantu Tunnel Server
 * -------------------
 * A self-hostable tunnel server (think ngrok / localtunnel) that runs on Render.
 *
 * Clients connect via WebSocket to /ws and request a tunnel id (subdomain).
 * Public HTTP requests are then forwarded through that WebSocket to the client,
 * which proxies them to localhost:<port> and ships the response back.
 *
 * Routing strategy (auto-detected at runtime):
 *   - Subdomain mode:  https://<tunnel>.<BASE_DOMAIN>/path
 *     Requires BASE_DOMAIN env var and wildcard DNS *.BASE_DOMAIN -> Render app.
 *   - Path mode (default): https://<app>.onrender.com/t/<tunnel>/path
 *     Works out of the box on Render free tier, no custom DNS required.
 *
 * Env vars:
 *   PORT           HTTP/WS listen port (Render sets this automatically).
 *   BASE_DOMAIN    Root domain for subdomain routing, e.g. "tunnels.example.com".
 *                  If unset, server falls back to path-based routing.
 *   AUTH_TOKEN     If set, clients must send ?token=<AUTH_TOKEN> on the WS handshake.
 *   MAX_TUNNELS    Max simultaneous tunnels (default 200).
 */

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_DOMAIN = process.env.BASE_DOMAIN || '';        // e.g. tunnels.example.com
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';          // optional shared secret
const MAX_TUNNELS = parseInt(process.env.MAX_TUNNELS || '200', 10);
const SUBDOMAIN_MODE = Boolean(BASE_DOMAIN);
const REQUEST_TIMEOUT_MS = 60_000;                        // per-request timeout

// tunnelId -> { ws, pending: Map<requestId, {res, timer}>, createdAt, requests }
const tunnels = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateTunnelId() {
  // Short, URL-friendly, ~1 in 4 billion collision chance
  return crypto.randomBytes(4).toString('hex');
}

function publicUrlFor(tunnelId, req) {
  if (SUBDOMAIN_MODE) {
    return `https://${tunnelId}.${BASE_DOMAIN}`;
  }
  // Path mode — derive scheme + host from incoming request headers (Render
  // terminates TLS and proxies through X-Forwarded-* headers).
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}/t/${tunnelId}`;
}

function resolveTunnelIdFromReq(req) {
  if (SUBDOMAIN_MODE) {
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    const root = (BASE_DOMAIN || '').toLowerCase();
    if (host.endsWith('.' + root)) {
      return host.slice(0, -(root.length + 1));
    }
    return null;
  }
  // Path mode: match /t/<tunnelId>(/...)?
  const parsed = url.parse(req.url);
  const m = parsed.pathname.match(/^\/t\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  return m ? m[1] : null;
}

function rewritePathForClient(req, tunnelId) {
  if (SUBDOMAIN_MODE) return req.url;
  // Strip the /t/<tunnelId> prefix so the local app sees the real path
  const parsed = url.parse(req.url);
  const m = parsed.pathname.match(/^\/t\/[a-zA-Z0-9_-]+(\/.*)?$/);
  const newPath = (m && m[1]) || '/';
  return newPath + (parsed.search || '');
}

// ---------------------------------------------------------------------------
// Landing page / dashboard
// ---------------------------------------------------------------------------

function sendLandingPage(req, res) {
  const active = tunnels.size;
  const list = Array.from(tunnels.entries()).slice(0, 50).map(([id, t]) => {
    const age = Math.round((Date.now() - t.createdAt) / 1000);
    return `<tr><td><code>${id}</code></td><td>${t.requests}</td><td>${age}s</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bantu Tunnel Server</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 16px;
    padding: 2.5rem;
    max-width: 640px;
    width: 100%;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
  }
  h1 { margin: 0 0 0.5rem; font-size: 1.8rem; color: #38bdf8; }
  p.subtitle { margin: 0 0 1.5rem; color: #94a3b8; font-size: 0.95rem; }
  .mode-pill {
    display: inline-block;
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    background: #0ea5e9;
    color: #f0f9ff;
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  pre {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 1rem;
    overflow-x: auto;
    color: #a5f3fc;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  code { background: #334155; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
  .stat { display: flex; gap: 2rem; margin: 1.5rem 0; }
  .stat .num { font-size: 1.75rem; font-weight: 700; color: #4ade80; }
  .stat .label { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #334155; }
  th { color: #94a3b8; font-weight: 600; }
  a { color: #38bdf8; }
</style>
</head>
<body>
  <div class="card">
    <span class="mode-pill">${SUBDOMAIN_MODE ? 'Subdomain mode' : 'Path mode'}</span>
    <h1>🚇 Bantu Tunnel Server</h1>
    <p class="subtitle">A self-hosted tunnel service — expose your local dev server to the public internet.</p>

    <div class="stat">
      <div><div class="num">${active}</div><div class="label">Active tunnels</div></div>
      <div><div class="num">${MAX_TUNNELS}</div><div class="label">Max tunnels</div></div>
    </div>

    <h3>Quick start</h3>
    <p>Install the client on your local machine:</p>
    <pre>npm install -g bantu-tunnel</pre>
    <p>Or run directly with npx:</p>
    <pre>npx bantu-tunnel --port 3000 --server ${publicUrlFor('__TUNNEL__', req).replace('/t/__TUNNEL__', '')}</pre>
    <p>With a custom subdomain:</p>
    <pre>npx bantu-tunnel --port 3000 --server ${publicUrlFor('__TUNNEL__', req).replace('/TUNNEL__', '').replace('/t/__TUNNEL__', '')} --subdomain myapp</pre>

    ${SUBDOMAIN_MODE ? `<p>💡 Subdomain mode: tunnels are reachable at <code>https://&lt;id&gt;.${BASE_DOMAIN}</code></p>` : `<p>💡 Path mode: tunnels are reachable at <code>https://&lt;this-host&gt;/t/&lt;id&gt;/</code></p>`}

    ${active > 0 ? `
      <h3>Active tunnels</h3>
      <table>
        <thead><tr><th>Tunnel ID</th><th>Requests served</th><th>Uptime</th></tr></thead>
        <tbody>${list}</tbody>
      </table>
    ` : ''}
  </div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const tunnelId = resolveTunnelIdFromReq(req);

  // No tunnel match -> landing page
  if (!tunnelId) {
    // Health check endpoint
    if (req.url === '/health' || req.url === '/_health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tunnels: tunnels.size, mode: SUBDOMAIN_MODE ? 'subdomain' : 'path' }));
      return;
    }
    sendLandingPage(req, res);
    return;
  }

  const tunnel = tunnels.get(tunnelId);
  if (!tunnel || tunnel.ws.readyState !== tunnel.ws.OPEN) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Tunnel "${tunnelId}" not found or disconnected.\n`);
    return;
  }

  // Collect request body
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => {
    if (!res.writableEnded) {
      res.writeHead(400);
      res.end('Bad request');
    }
  });
  req.on('end', () => {
    const requestId = crypto.randomUUID();
    const clientPath = rewritePathForClient(req, tunnelId);

    const payload = {
      type: 'request',
      id: requestId,
      method: req.method,
      path: clientPath,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('base64'),
    };

    const timer = setTimeout(() => {
      const p = tunnel.pending.get(requestId);
      if (p) {
        tunnel.pending.delete(requestId);
        if (!p.res.writableEnded) {
          p.res.writeHead(504, { 'Content-Type': 'text/plain' });
          p.res.end('Gateway Timeout — local client did not respond in time.');
        }
      }
    }, REQUEST_TIMEOUT_MS);

    tunnel.pending.set(requestId, { res, timer });
    tunnel.requests++;

    try {
      tunnel.ws.send(JSON.stringify(payload));
    } catch (err) {
      clearTimeout(timer);
      tunnel.pending.delete(requestId);
      if (!res.writableEnded) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Failed to forward request to tunnel client.');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket server — clients connect here to register a tunnel
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const parsed = url.parse(req.url, true);
  const query = parsed.query || {};

  // Auth check
  if (AUTH_TOKEN && query.token !== AUTH_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or missing auth token.' }));
    ws.close(4001, 'unauthorized');
    return;
  }

  if (tunnels.size >= MAX_TUNNELS) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server at max tunnel capacity. Try again later.' }));
    ws.close(1013, 'try again later');
    return;
  }

  // Sanitize requested subdomain: lowercase, strip non-url-safe chars, cap length
  let requested = '';
  if (query.subdomain) {
    requested = String(query.subdomain)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32);
  }
  const tunnelId = requested || generateTunnelId();

  if (tunnels.has(tunnelId)) {
    ws.send(JSON.stringify({ type: 'error', message: `Tunnel id "${tunnelId}" is already in use.` }));
    ws.close(4002, 'tunnel id taken');
    return;
  }

  const tunnel = {
    id: tunnelId,
    ws,
    pending: new Map(),
    createdAt: Date.now(),
    requests: 0,
  };
  tunnels.set(tunnelId, tunnel);

  const publicUrl = publicUrlFor(tunnelId, req);
  ws.send(JSON.stringify({
    type: 'connected',
    tunnelId,
    url: publicUrl,
    mode: SUBDOMAIN_MODE ? 'subdomain' : 'path',
    timestamp: Date.now(),
  }));

  console.log(`[tunnel] + ${tunnelId} -> ${publicUrl}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
      return;
    }

    if (msg.type === 'response') {
      const pending = tunnel.pending.get(msg.id);
      if (!pending) return; // already timed out / closed
      clearTimeout(pending.timer);
      tunnel.pending.delete(msg.id);

      try {
        const body = msg.body ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0);
        const headers = msg.headers || { 'Content-Type': 'text/plain' };
        // Strip headers that the http server wants to manage itself
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        pending.res.writeHead(msg.status || 200, headers);
        pending.res.end(body);
      } catch (e) {
        // Socket may have already closed
      }
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    }
  });

  ws.on('close', () => {
    tunnels.delete(tunnelId);
    console.log(`[tunnel] - ${tunnelId} (closed, ${tunnel.pending.size} pending)`);

    for (const [, p] of tunnel.pending) {
      clearTimeout(p.timer);
      try {
        if (!p.res.writableEnded) {
          p.res.writeHead(502, { 'Content-Type': 'text/plain' });
          p.res.end('Tunnel client disconnected.');
        }
      } catch (e) { /* noop */ }
    }
    tunnel.pending.clear();
  });

  ws.on('error', (err) => {
    console.error(`[tunnel] ws error on ${tunnelId}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Bantu Tunnel Server                                      ║`);
  console.log(`║  Listening:           http://0.0.0.0:${PORT}                       `);
  console.log(`║  Routing mode:        ${SUBDOMAIN_MODE ? 'subdomain' : 'path      '}`);
  if (SUBDOMAIN_MODE) {
    console.log(`║  Base domain:         ${BASE_DOMAIN.padEnd(36)}║`);
  }
  console.log(`║  Auth token required: ${AUTH_TOKEN ? 'yes' : 'no '.padEnd(34)}║`);
  console.log(`║  Max tunnels:         ${String(MAX_TUNNELS).padEnd(34)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] shutting down...`);
  for (const [, t] of tunnels) {
    try { t.ws.close(1001, 'server shutting down'); } catch (e) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
