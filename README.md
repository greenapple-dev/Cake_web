# Cake SMP Console

Login-protected web console for your Minecraft server.
Sign in with email + password, then enter the 6-digit code emailed to the admin Gmail.

There are two ways to run this. Pick one:

- **A) On your own PC** — edit `config.json` (simplest, nothing to deploy).
- **B) On GitHub, hosted online (e.g. Render)** — no `config.json` at all; settings come from
  environment variables you type into the host's dashboard, so no password ever gets committed
  to the repo. This is what lets you (or anyone with the link) open the console from a browser
  without your PC needing to be on.

Both talk to your Minecraft server the same way: **RCON** for commands/players, and either the
local disk or **SFTP** for the log and file browser. Since your server is Folium-hosted, use SFTP.

---

## A) Run it on your own PC

1. In `server.properties` on the Minecraft server:
   ```
   enable-rcon=true
   rcon.port=25575
   rcon.password=pick-a-strong-password
   ```
   Restart the Minecraft server once after changing this.
2. Copy `config.example.json` to `config.json` and fill it in:
   - `sftp.host` / `sftp.username` / `sftp.password` — Folium panel → **Settings → Launch SFTP**
   - `rcon.password` — same value as in `server.properties` above
   - `admin.email` — the Gmail the code gets sent to
   - `admin.passwordHash` — run `npm run hash -- "your password"` and paste the result
   - `smtp.pass` — a Gmail **App Password** (Google Account → Security → 2-Step Verification →
     App passwords). Your normal Gmail password will not work here.
3. ```
   npm install
   npm start
   ```
   (On Windows you can just double-click `start.bat`.)
4. Open **http://localhost:8080**. Do not open `index.html` directly — it needs the server
   running behind it, otherwise you'll see "Can't reach the console server".

Testing without email: set `"printCodeToConsole": true` in `config.json` — the code is printed
in the terminal instead of emailed. Turn it off afterwards.

---

## B) Put it on GitHub and host it online (Render)

### 1. Push this folder to GitHub
```
git init
git add .
git commit -m "Cake SMP console"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```
`config.json` is listed in `.gitignore`, so if you made one for local testing it will **not**
be pushed. Only `config.example.json` (no real passwords) goes to GitHub.

### 2. Create the web service on Render
GitHub itself only stores files — it doesn't run them. [Render](https://render.com) is a free
host that runs a Node app straight from a GitHub repo.

1. Sign up at render.com and connect your GitHub account.
2. **New → Web Service**, pick this repo. If it detects `render.yaml`, it fills in the settings
   for you (click **Apply**) and lists every setting below for you to type in. Otherwise set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
3. Under **Environment**, add these variables:

| Variable | Value |
|---|---|
| `CAKE_SERVER_NAME` | `Cake SMP` |
| `CAKE_PUBLIC_ADDRESS` | `e-mep-1.folium.host:25140` |
| `CAKE_STORAGE` | `sftp` |
| `CAKE_ADMIN_EMAIL` | your Gmail |
| `CAKE_ADMIN_PASSWORD_HASH` | output of `npm run hash -- "your password"` (run that locally) |
| `CAKE_RCON_HOST` | your Folium node hostname, e.g. `e-mep-1.folium.host` |
| `CAKE_RCON_PORT` | `25575` (or whatever `rcon.port` is) |
| `CAKE_RCON_PASSWORD` | same as `rcon.password` in `server.properties` |
| `CAKE_SFTP_HOST` | Folium panel → Settings → Launch SFTP |
| `CAKE_SFTP_PORT` | `2022` |
| `CAKE_SFTP_USERNAME` | shown next to Launch SFTP |
| `CAKE_SFTP_PASSWORD` | your Folium panel account password |
| `CAKE_SFTP_ROOT` | `/` |
| `CAKE_SMTP_USER` | your Gmail |
| `CAKE_SMTP_PASS` | a Gmail **App Password** (not your normal password) |

   `PORT` is set by Render automatically — don't add it yourself.
4. **Create Web Service.** First deploy takes a minute or two. Render gives you a URL like
   `https://cake-smp-console.onrender.com` — that's your console, reachable from any browser.

### 3. Open the RCON port
Render needs to reach your Minecraft server from the internet. On the Folium panel, open the
RCON port under **Network → Ports** (or similar) so it isn't blocked. SFTP is already reachable
from the internet by design, nothing to change there.

### Notes for the hosted (Render) version
- **Free plan sleeps.** After ~15 minutes with no visitors, the service spins down; the next
  visit takes 30–60 seconds to wake up. That's normal, not a bug — if the page seems stuck
  loading right after a while away, just wait a bit and reload.
- HTTPS and cookies are handled automatically (the app detects it's running on a host and turns
  on secure cookies by itself).
- To change the password later without redeploying code: run `hash.js` locally again and update
  the `CAKE_ADMIN_PASSWORD_HASH` variable in Render's dashboard.

---

## Every environment variable (used by B, optional overrides for A)

| Variable | Same as in config.json | Default |
|---|---|---|
| `PORT` | `port` | `8080` |
| `HOST` | `host` | `0.0.0.0` when deployed, `127.0.0.1` locally |
| `CAKE_SERVER_NAME` | `serverName` | `Cake SMP` |
| `CAKE_PUBLIC_ADDRESS` | `publicAddress` | *(empty)* |
| `CAKE_SECURE_COOKIES` | `secureCookies` | on when deployed |
| `CAKE_TRUST_PROXY` | `trustProxy` | on when deployed |
| `CAKE_STORAGE` | `storage` | `local` |
| `CAKE_LOG_FILE` | `logFile` | `logs/latest.log` |
| `CAKE_MINECRAFT_DIR` | `minecraftDir` | `.` (only used when storage is `local`) |
| `CAKE_RCON_HOST` / `_PORT` / `_PASSWORD` | `rcon.*` | — |
| `CAKE_SFTP_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` / `_ROOT` | `sftp.*` | port `2022`, root `/` |
| `CAKE_ADMIN_EMAIL` / `CAKE_ADMIN_PASSWORD_HASH` | `admin.*` | — |
| `CAKE_SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASS` | `smtp.*` | Gmail defaults |
| `CAKE_PRINT_CODE` | `printCodeToConsole` | `false` |
| `CAKE_START_COMMAND` / `CAKE_RESTART_COMMAND` | `startCommand` / `restartCommand` | *(empty — leave unset on Render, there's no local Minecraft process to launch)* |

A variable always overrides the matching `config.json` field when both are present.
