# LedgerBot

**An invisible AI accountant that lives inside WhatsApp.**

LedgerBot lets small business owners — kirana stores, small manufacturers, coaching centres, retailers — keep real, tallied, double-entry books just by sending the WhatsApp messages, voice notes, and photos they already send today.

---

## Current phase

**Single AI agent (no slash commands):** send plain text, voice, bill photos, or supplier/stock PDFs. LedgerBot classifies intent, shows a confirmation, and on **YES** either posts a **journal entry** (sales/bills) or upserts **products** (supplier/stock lists).

---

## Tech stack

- **Backend:** Node.js, Express
- **Frontend:** React + Vite (`frontend/`) — login/register/dashboard (local auth for now)
- **Database:** Supabase (Postgres) via `@supabase/supabase-js`
- **Messaging:** Meta WhatsApp Cloud API
- **LLM:** Groq API (OCR + intent extraction)

---

## Project layout

```
backend/          # WhatsApp webhook + AI agent
frontend/         # React web UI (college teammate)
migrations/       # Postgres schema
start.bat         # Starts backend + frontend + ngrok
```

---

## 1. Run the SQL migration (Supabase)

1. Create a project at [https://supabase.com](https://supabase.com).
2. Open **SQL Editor** → paste [`migrations/001_init.sql`](migrations/001_init.sql) → Run.

Or with `psql`:

```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres" -f migrations/001_init.sql
```

---

## 2. Environment variables

```bash
cd backend
cp .env.example .env
```

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Project URL → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server only; bypasses RLS) |
| `WHATSAPP_TOKEN` | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose (must match Meta dashboard) |
| `GROQ_API_KEY` | Groq API key (later phases) |
| `PORT` | HTTP port (default `3000`) |

---

## 3. Start the server locally

```bash
cd backend
npm install
npm start
```

### Frontend (React)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** — register / login / dashboard.

Or run everything with `start.bat` (backend + frontend + ngrok).

- Health: `GET http://localhost:3000/` → `{ "status": "ok" }`
- Webhook verify: `GET http://localhost:3000/webhook?...` (configured by Meta)
- Webhook inbound: `POST http://localhost:3000/webhook`

---

## 4. WhatsApp Cloud API setup (Meta)

### A. Create a Meta developer app

1. Go to [https://developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**.
2. Choose **Business** (or Other → Business), name it e.g. `LedgerBot`.
3. In the app dashboard, add the **WhatsApp** product → **API Setup**.

### B. Temporary test token + phone number ID

1. On **WhatsApp → API Setup**, copy:
   - **Temporary access token** → `WHATSAPP_TOKEN` (expires in ~24h; replace with a permanent System User token for production)
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
2. Paste both into `backend/.env`.

### C. Add test recipient numbers

1. Under **To**, click **Manage phone number list**.
2. Add your personal WhatsApp number and complete the SMS/voice verification code.
3. Only numbers on this allowlist can message / be messaged while using the test number.

### D. Run the backend + expose it with ngrok

```bash
# Terminal 1 — API
cd backend
npm start

# Terminal 2 — public HTTPS tunnel to local :3000
ngrok http 3000
```

Copy the HTTPS forwarding URL, e.g. `https://abc123.ngrok-free.app`.

### E. Configure the webhook in Meta

1. In the WhatsApp product, open **Configuration** (or API Setup → Webhook).
2. **Callback URL:** `https://abc123.ngrok-free.app/webhook`
3. **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN` in `.env` (e.g. `manya123`).
4. Click **Verify and save**. Meta sends `GET /webhook` with `hub.mode`, `hub.verify_token`, and `hub.challenge`; the server returns the challenge when the token matches.
5. Subscribe to the **messages** field under webhook fields.

### F. End-to-end smoke test

1. From your allowlisted phone, send a WhatsApp text to the Meta test number.
2. You should receive an echo: `Received: <your text>`.
3. In Supabase **Table Editor → vendors**, confirm a new row whose `phone` matches your WhatsApp `wa_id` (first contact only creates; later messages reuse the same row).
4. Voice notes reply `Received voice note`; images reply `Received image`.

---

## Notes

- `POST /webhook` always returns **200 immediately**, then processes (vendor upsert + reply) asynchronously so Meta never times out or retries from slow work.
- Meta API and Supabase errors are logged; they never crash the process or change the webhook HTTP status.
- The service-role key bypasses RLS; keep it server-side only.

---

## Common measure reference (billing shorthand)

LedgerBot normalizes frequent handwritten/billing units so short forms are interpreted consistently.

| Bill text example | Meaning | Normalized parse |
|---|---|---|
| `1 kilo`, `1 kg`, `1 ki` | 1 kilogram | `quantity: 1, unit: KG` |
| `ardho kilo` | half kilo | `quantity: 0.5, unit: KG` |
| `pono kilo` | three-quarter kilo | `quantity: 0.75, unit: KG` |
| `sava kilo` | one-and-quarter kilo | `quantity: 1.25, unit: KG` |
| `dodh kilo` | one-and-half kilo | `quantity: 1.5, unit: KG` |
| `1 pav` | quarter kilo | `quantity: 250, unit: GM` |
| `2 pav` | half kilo total | `quantity: 500, unit: GM` |
| `1 tola` | traditional jewelry weight | `quantity: 11.66, unit: GM` |
| `1 mann` | traditional bulk farm unit | `quantity: 1, unit: MANN` |
| `1 liter`, `1 ltr` | 1 liter liquid | `quantity: 1, unit: L` |
| `500 ml` | 500 milliliters | `quantity: 500, unit: ML` |

The source of truth for this mapping is:
- `backend/src/utils/gujarati.js` → `COMMON_MEASURE_REFERENCE`
- `backend/src/utils/gujarati.js` → `parseWeightText()`
