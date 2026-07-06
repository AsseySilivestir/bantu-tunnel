# 🚇 Bantu Tunnel

A self-hostable tunnel server (think **ngrok** / **localtunnel**) you can deploy on **Render** for free, then use to expose your local dev projects to the public internet.

The project has two parts:

| Part | File | Purpose |
|------|------|---------|
| **Server** | `server.js` | HTTP + WebSocket server. Receives public requests and forwards them through a WebSocket to your local client. |
| **Client** | `client.js` | CLI tool that runs on your machine, opens a WebSocket to the server, and proxies incoming requests to `http://localhost:<port>`. |

## How it works

```
                       ┌───────────────────────────────────┐
                       │   Render (your tunnel server)     │
  Public browser  ───► │   https://your-app.onrender.com   │
   https://.../t/abc/  │            │                      │
                       │            ▼ WebSocket /ws        │
                       └────────────┼──────────────────────┘
                                    │ tunnel 'abc' assigned
                                    ▼
                       ┌───────────────────────────────────┐
                       │   Your machine (client.js)        │
                       │   ws ↔ http://localhost:3000      │
                       └───────────────────────────────────┘
```

1. You run the **client** locally: `node client.js -p 3000 -s https://your-app.onrender.com`
2. The client opens a WebSocket to the server and gets back a public URL like `https://your-app.onrender.com/t/abc123/`
3. Anyone visiting that URL gets proxied through the WebSocket to your local `localhost:3000`
4. The response flows back the same way

## Deploy the server on Render

### Option A — One-click deploy button

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bantugateway/bantu-tunnel)

### Option B — Blueprint

1. Push this folder to a new GitHub repo (e.g. `bantu-tunnel`).
2. Go to the Render dashboard → **New** → **Blueprint**.
3. Pick your repo. Render detects `render.yaml` and creates the service automatically.
4. Wait for the build to finish. You'll get a URL like `https://bantu-tunnel-xxxx.onrender.com`.

### Option C — Manual web service

1. Push this folder to a GitHub repo.
2. In Render: **New** → **Web Service** → pick the repo.
3. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `node server.js`
   - **Plan:** Free (works fine; will spin down after 15 min idle) or Starter ($7/mo for always-on)
4. Deploy. Note the public URL Render assigns.

### Server environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` (Render auto-sets) | HTTP/WS listen port. |
| `BASE_DOMAIN` | *(empty)* | If set, enables **subdomain mode** (`https://<tunnel>.<BASE_DOMAIN>`). Requires wildcard DNS pointing at your Render app. |
| `AUTH_TOKEN` | *(empty)* | If set, clients must pass `--token <value>` to connect. |
| `MAX_TUNNELS` | `200` | Max simultaneous tunnels. |

**Path mode** (default) routes tunnels at `https://<app>.onrender.com/t/<tunnel-id>/path`. Works on Render free tier out of the box.

**Subdomain mode** routes tunnels at `https://<tunnel-id>.<BASE_DOMAIN>/path`. Cleaner URLs but requires:
- A custom domain in Render (Settings → Custom Domains)
- A wildcard DNS record: `*.tunnels.example.com CNAME bantu-tunnel.onrender.com`
- Set `BASE_DOMAIN=tunnels.example.com` in the service's env vars

## Use the client

### Run directly with `npx` (no install)

```bash
npx --yes https://github.com/bantugateway/bantu-tunnel \
  --port 3000 \
  --server https://bantu-tunnel-xxxx.onrender.com
```

### Or install from source

```bash
git clone https://github.com/bantugateway/bantu-tunnel.git
cd bantu-tunnel
npm install
npm link   # makes `bantu-tunnel` and `bantu-tunnel-server` available globally
```

Then from any project:

```bash
# Expose whatever is running on localhost:3000
bantu-tunnel --port 3000 --server https://bantu-tunnel-xxxx.onrender.com

# Request a specific subdomain (must be unique on the server)
bantu-tunnel --port 3000 --server https://bantu-tunnel-xxxx.onrender.com --subdomain myapp

# With auth (if you set AUTH_TOKEN on the server)
bantu-tunnel --port 3000 --server https://bantu-tunnel-xxxx.onrender.com --token s3cret
```

### Output example

```
[client] connecting to wss://bantu-tunnel-xxxx.onrender.com/ws...
[client] websocket connected — waiting for tunnel assignment...

╔══════════════════════════════════════════════════════════╗
║  🚇 Tunnel established!                                   ║
║  Public URL:  https://bantu-tunnel-xxxx.onrender.com/t/a1b2c3d4
║  Forwarding:  http://localhost:3000                       ║
║  Mode:        path                                         ║
╚══════════════════════════════════════════════════════════╝

Press Ctrl+C to stop the tunnel.
```

Anyone visiting `https://bantu-tunnel-xxxx.onrender.com/t/a1b2c3d4/` will now hit your local `localhost:3000`.

## Local development & testing

You can run both server and client on your own machine to verify the setup:

```bash
# Terminal 1 — start the tunnel server
cd /path/to/bantu-tunnel
npm install
npm start
# → Listening on http://0.0.0.0:3000

# Terminal 2 — start a dummy local app
python3 -m http.server 8080

# Terminal 3 — start the client
node client.js --port 8080 --server http://localhost:3000

# Visit the printed URL (e.g. http://localhost:3000/t/abc123/) in a browser
```

## Endpoints exposed by the server

| Path | Description |
|------|-------------|
| `GET /` | Landing page with usage info + active tunnel list. |
| `GET /health` | JSON health check (`{ ok, tunnels, mode }`). |
| `WS  /ws` | WebSocket endpoint clients connect to. |
| `*   /t/<tunnel-id>/...` | Forwarded to the matching tunnel client (path mode). |
| `*   <tunnel-id>.<BASE_DOMAIN>/...` | Forwarded to the matching tunnel client (subdomain mode). |

## Security notes

- **Free Render tier spins down** the web service after 15 min of inactivity. The first request after spin-down takes ~30s to wake it up. Use the Starter plan for always-on tunnels.
- **The tunnel is publicly accessible.** Anyone with the URL can hit your local app. Don't use this to expose sensitive services without auth.
- **Set `AUTH_TOKEN`** to prevent strangers from creating tunnels through your server. Clients then pass `--token <value>`.
- **Tunnel IDs are random 8-char hex** by default — not guessable, but also not secret. Treat the full URL as the secret.
- **Rate limits / abuse prevention** are not built in. For production use, add Render's built-in rate limiting or put it behind Cloudflare.

## Limitations

- Only HTTP/HTTPS is supported (no raw TCP — Render doesn't expose TCP ports on the free tier).
- WebSocket upgrade requests through the tunnel work, but very large uploads (>5 MB) may hit Render's request body size limit.
- Each tunnel is single-client. To load-balance, run multiple clients with the same subdomain behind a separate load balancer.

## License

MIT — do whatever you want with it.
