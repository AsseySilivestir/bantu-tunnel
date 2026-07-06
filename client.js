#!/usr/bin/env node
/**
 * Bantu Tunnel Client
 * ------------------
 * Connects to a Bantu Tunnel Server (or any compatible server) over WebSocket
 * and exposes a local port to the public internet through that server.
 *
 * Usage:
 *   node client.js --port 3000 --server https://your-app.onrender.com
 *   node client.js --port 8080 --server wss://your-app.onrender.com --subdomain myapp
 *   node client.js -p 3000 -s https://tunnels.example.com -d myapp --token s3cret
 *
 * The client keeps the connection alive with periodic pings and automatically
 * reconnects (with backoff) if the WebSocket drops.
 */

'use strict';

const WebSocket = require('ws');
const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = {
    port: null,
    server: process.env.TUNNEL_SERVER || null,
    subdomain: '',
    token: process.env.TUNNEL_TOKEN || '',
    host: 'localhost',
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-p':
      case '--port':
        args.port = parseInt(argv[++i], 10);
        break;
      case '-s':
      case '--server':
        args.server = argv[++i];
        break;
      case '-d':
      case '--subdomain':
        args.subdomain = argv[++i];
        break;
      case '--token':
        args.token = argv[++i];
        break;
      case '--host':
        args.host = argv[++i];
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!args.port) {
    console.error('Error: --port is required (the local port to expose).');
    printHelp();
    process.exit(1);
  }
  if (!args.server) {
    console.error('Error: --server is required (the deployed tunnel server URL).');
    printHelp();
    process.exit(1);
  }

  return args;
}

function printHelp() {
  console.log(`
bantu-tunnel client — expose a local port through a Bantu Tunnel server.

Usage:
  node client.js --port <local-port> --server <server-url> [options]

Required:
  -p, --port <number>          Local port to expose (e.g. 3000, 8080).
  -s, --server <url>           Deployed tunnel server URL.
                               Accepts http(s):// or ws(s):// forms.
                               Example: https://my-tunnel.onrender.com

Optional:
  -d, --subdomain <name>       Request a specific tunnel id/subdomain.
                               If omitted, the server assigns a random one.
      --token <secret>         Auth token (only if server requires AUTH_TOKEN).
      --host <hostname>        Host header for the local server (default: localhost).
  -h, --help                   Show this help.

Environment variables (also supported):
  TUNNEL_SERVER                Same as --server
  TUNNEL_TOKEN                 Same as --token

Examples:
  node client.js -p 3000 -s https://my-tunnel.onrender.com
  node client.js -p 8080 -s https://my-tunnel.onrender.com -d myapp
  node client.js -p 3000 -s https://tunnels.example.com -d blog --token s3cret
`);
}

// ---------------------------------------------------------------------------
// Normalize server URL -> ws/wss URL
// ---------------------------------------------------------------------------

function toWebSocketUrl(serverUrl) {
  let u;
  try { u = new URL(serverUrl); } catch (e) {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return serverUrl;
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else throw new Error(`Unsupported server protocol: ${u.protocol}`);
  u.pathname = (u.pathname === '/' ? '' : u.pathname) + '/ws';
  return u.toString();
}

// ---------------------------------------------------------------------------
// Forwarding: incoming WebSocket request -> local HTTP server
// ---------------------------------------------------------------------------

function forwardRequestToLocal(reqData, args, sendResponse) {
  const body = reqData.body ? Buffer.from(reqData.body, 'base64') : Buffer.alloc(0);

  const urlObj = new URL(reqData.path, `http://${args.host}:${args.port}`);
  const options = {
    hostname: args.host,
    port: args.port,
    path: urlObj.pathname + urlObj.search,
    method: reqData.method,
    headers: { ...reqData.headers },
  };
  // Rewrite the Host header so the local app sees its own host
  options.headers.host = `${args.host}:${args.port}`;
  // Remove hop-by-hop headers
  delete options.headers['connection'];
  delete options.headers['upgrade'];
  delete options.headers['proxy-connection'];

  const lib = options.port === 443 || args.host === 'https' ? https : http;
  const proxyReq = lib.request(options, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      sendResponse({
        type: 'response',
        id: reqData.id,
        status: proxyRes.statusCode || 200,
        headers: proxyRes.headers,
        body: Buffer.concat(chunks).toString('base64'),
      });
    });
    proxyRes.on('error', () => {
      sendResponse({
        type: 'response',
        id: reqData.id,
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
        body: Buffer.from('Local server response error.').toString('base64'),
      });
    });
  });

  proxyReq.on('error', (err) => {
    sendResponse({
      type: 'response',
      id: reqData.id,
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from(
        `Cannot reach local server at http://${args.host}:${args.port} — ${err.message}\n` +
        `Make sure your local dev server is running on port ${args.port}.`
      ).toString('base64'),
    });
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ---------------------------------------------------------------------------
// Connection management with auto-reconnect
// ---------------------------------------------------------------------------

function startClient(args) {
  const wsUrl = toWebSocketUrl(args.server);
  let ws = null;
  let pingInterval = null;
  let reconnectAttempts = 0;
  let currentUrl = null;
  let shuttingDown = false;

  function connect() {
    if (shuttingDown) return;
    console.log(`\n[client] connecting to ${wsUrl}${args.subdomain ? ` (subdomain: ${args.subdomain})` : ''}...`);

    const wsUrlWithParams = new URL(wsUrl);
    if (args.subdomain) wsUrlWithParams.searchParams.set('subdomain', args.subdomain);
    if (args.token) wsUrlWithParams.searchParams.set('token', args.token);

    ws = new WebSocket(wsUrlWithParams.toString());

    ws.on('open', () => {
      reconnectAttempts = 0;
      console.log('[client] websocket connected — waiting for tunnel assignment...');
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (e) {}
        }
      }, 30_000);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      if (msg.type === 'connected') {
        currentUrl = msg.url;
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log(`║  🚇 Tunnel established!                                   ║`);
        console.log(`║  Public URL:  ${msg.url.padEnd(43)}║`);
        console.log(`║  Forwarding:  http://${args.host}:${String(args.port).padEnd(34)}║`);
        console.log(`║  Mode:        ${msg.mode.padEnd(43)}║`);
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('Press Ctrl+C to stop the tunnel.');
      } else if (msg.type === 'request') {
        forwardRequestToLocal(msg, args, (resp) => {
          try { ws.send(JSON.stringify(resp)); } catch (e) {}
        });
      } else if (msg.type === 'pong') {
        // keepalive ack
      } else if (msg.type === 'error') {
        console.error(`[client] server error: ${msg.message}`);
        if (msg.message.includes('already in use') || msg.message.includes('subdomain')) {
          // For subdomain conflicts, do not retry indefinitely
          console.error('[client] subdomain unavailable — pick another with --subdomain, or omit to get a random one.');
          shuttingDown = true;
          if (ws) ws.close();
          process.exit(1);
        }
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(pingInterval);
      pingInterval = null;
      if (shuttingDown) return;
      const reasonStr = reason ? ` (${reason.toString()})` : '';
      console.warn(`[client] connection closed [${code}]${reasonStr}`);
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      // close handler will trigger reconnect
      if (reconnectAttempts === 0) {
        console.error(`[client] websocket error: ${err.message}`);
      }
    });
  }

  function scheduleReconnect() {
    if (shuttingDown) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 30_000);
    const jitter = delay * (0.5 + Math.random() * 0.5);
    console.log(`[client] reconnecting in ${Math.round(jitter / 1000)}s (attempt ${reconnectAttempts})...`);
    setTimeout(() => {
      if (!shuttingDown) connect();
    }, jitter);
  }

  process.on('SIGINT', () => {
    shuttingDown = true;
    console.log('\n[client] shutting down tunnel...');
    clearInterval(pingInterval);
    if (ws) {
      try { ws.close(1000, 'client shutdown'); } catch (e) {}
    }
    setTimeout(() => process.exit(0), 500).unref();
  });
  process.on('SIGTERM', () => {
    shuttingDown = true;
    clearInterval(pingInterval);
    if (ws) try { ws.close(); } catch (e) {}
    process.exit(0);
  });

  connect();
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const args = parseArgs();
startClient(args);
