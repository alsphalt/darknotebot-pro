# DARKNOTE NEXUS integration

This control center can report to **DARKNOTE NEXUS** (`/api/bot/v1/*`). The two
projects stay independent: separate repos, separate databases, separate
deployments. This repo only *pushes* state and *relays* work; NEXUS is the source
of truth for accounts, permissions and the paired-number list.

```
WhatsApp process (Pterodactyl)  ──status file / panel──▶  Control Center
                                                             │ HTTPS + bot token
                                                             ▼
                                                    DARKNOTE NEXUS API
                                                             │ Prisma
                                                             ▼
                                                       Postgres (truth)
                                                             │ SSE
                                                             ▼
                                                       Nexus dashboard
```

## 1. Pair this control center with Nexus

1. In Nexus: **Bots → New bot** (e.g. `darknote-prod`) → **Details** → *Generate pairing code*.
2. On the control center host:

   ```bash
   curl -X POST https://<nexus>/api/bots/pair \
     -H 'content-type: application/json' \
     -d '{"code":"AB12CD34","version":"1.0.0"}'
   ```

3. Store `token` (shown once) as `NEXUS_BOT_TOKEN`. Never commit it; the token is
   hashed in Nexus and can be revoked from the dashboard.

## 2. Environment

| Variable | Purpose |
| --- | --- |
| `NEXUS_URL` | Base URL of the Nexus deployment, e.g. `https://darknote.nexus.app` |
| `NEXUS_BOT_TOKEN` | `dnx_…` token from pairing (required) |
| `NEXUS_BOT_PAIR_URL` | HTTP endpoint **on the bot process** that calls Baileys `requestPairingCode(phone)` |
| `NEXUS_BOT_COMMAND_URL` | Optional endpoint on the bot process for `restart` / `logout` |
| `NEXUS_TIMEOUT_MS` | Request timeout, default 8000 |
| `NEXUS_AUTO_SYNC` | `false` disables the monitor-triggered sync |
| `CRON_SECRET` | Enables `GET /api/nexus/cron` for scheduled sync |
| `DARKNOTE_BOT_STATUS_PATH` | The status file the bot writes (existing setting) |

## 3. What is synchronised

Each pass sends one snapshot built from what this app can really observe:

- `bot_status.whatsapp_state` (`connected`, `disconnected`, `qr_pending`, `logged_out`) → `CONNECTED / DISCONNECTED / PAIRING_CODE / LOGGED_OUT`
- container state → a stopped container is always `DISCONNECTED`
- `DARKNOTE_BOT_STATUS_PATH` JSON: if it contains `sessions: […]`, those rows are
  used verbatim (id, phone, status, connectedAt, pairingCode) — the most precise source
- sessions this app no longer sees are deleted in Nexus, so removing a number is reflected

Trigger points:

- `GET /api/monitor` (operator has the panel open) — debounced 10 s, never blocking
- `POST /api/nexus` — manual "Sync now" from the UI/API
- `GET /api/nexus/cron` — scheduler (Vercel Cron / systemd timer / Pterodactyl startup)

## 4. Pairing codes

A pairing code can only come from the process that owns the Baileys socket. The
control center therefore relays: Nexus queues a request → this app POSTs the
phone to `NEXUS_BOT_PAIR_URL` → the bot answers with the code → it is reported
back and appears in the dashboard instantly.

The bot must expose a tiny authenticated endpoint. Drop this into the bot's
existing HTTP layer (it uses the socket the bot already has):

```js
// bot: POST /nexus/pair   { phone: "447700900123" }
app.post("/nexus/pair", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.NEXUS_BOT_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "phone required" });

  // `sock` is the existing Baileys socket. The code can only be requested once
  // the websocket handshake has completed (Baileys emits a QR challenge then).
  if (!sock?.authState?.creds?.registered) {
    await new Promise((resolve) => sock.ev.once("connection.update", (u) => (u.qr ? resolve() : null)));
  }
  try {
    const code = await sock.requestPairingCode(phone);
    res.json({ code, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
```

Without `NEXUS_BOT_PAIR_URL` the request stays queued in Nexus and the dashboard
says so — no fake codes are ever shown.

## 5. Commands

`restart` / `unlink` pressed in Nexus become rows in `BotCommand`. This app pulls
them from `/api/bot/v1/commands` and, when `NEXUS_BOT_COMMAND_URL` is set, POSTs
`{ action, session, phone }` to it, then acks the result. With no command endpoint
configured the command is acknowledged as **ERROR** with the reason, so the UI
never claims an action that did not happen.

## 6. Watching that it works

```bash
curl -s https://<nexus>/api/bot/v1/ping -H "authorization: Bearer $NEXUS_BOT_TOKEN"
npm run nexus:sync          # one pass, prints the summary
```

`GET /api/nexus` (signed-in operator) returns the connector state and the last
sync summary. `POST /api/nexus` forces a pass.
