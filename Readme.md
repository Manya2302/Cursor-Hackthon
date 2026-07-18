# LedgerBot

**An invisible AI accountant that lives inside WhatsApp.**

LedgerBot lets small business owners — kirana stores, small manufacturers, coaching centres, retailers — keep real, tallied, double-entry books just by sending the WhatsApp messages, voice notes, and photos they already send today. No new app to learn, no dashboard to maintain, no behavior change. Behind every message, a proper accounting engine silently keeps the books, and on request produces real, downloadable financial statements — in English, Hindi, or Gujarati.

---

## Current phase

**Phase 1 — foundation only:** Postgres schema (tables, constraints, journal-balance trigger, indexes, RLS) and a booting Express server. No business logic yet.

---

## Tech stack

- **Backend:** Node.js, Express
- **Database:** Supabase (Postgres) via `@supabase/supabase-js`
- **LLM:** Groq API (wired later)
- **Messaging:** Meta WhatsApp Cloud API (wired later)

---

## Project layout (backend)

```
backend/
├── server.js                 # Entry point
├── package.json
├── .env.example
├── src/
│   ├── app.js                # Express middleware wiring
│   ├── config/
│   │   └── supabase.js       # Supabase JS client (service role)
│   └── routes/
│       └── health.js         # GET / → { status: 'ok' }
migrations/
└── 001_init.sql              # Schema, trigger, indexes, RLS
```

---

## 1. Run the SQL migration (Supabase)

1. Create a project at [https://supabase.com](https://supabase.com).
2. Open **SQL Editor** in the Supabase dashboard.
3. Paste the contents of [`migrations/001_init.sql`](migrations/001_init.sql) and run it.

Or with `psql` (replace with your database URL from **Project Settings → Database**):

```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres" -f migrations/001_init.sql
```

The migration creates:

- Tables: `vendors`, `parties`, `accounts`, `journal_entries`, `journal_lines`, `products`, `stock_ledger`, `raw_extractions`
- Unique party names per vendor (case-insensitive): `(vendor_id, lower(name))`
- Trigger `check_journal_balance()` so every journal entry’s debits must equal credits
- Indexes and Row Level Security policies (placeholder `auth.uid()` vendor scoping)

---

## 2. Environment variables

```bash
cd backend
cp .env.example .env
```

Fill in `backend/.env`:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Project URL from Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only; never expose to clients) |
| `WHATSAPP_TOKEN` | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verify token you choose |
| `GROQ_API_KEY` | Groq API key |
| `PORT` | HTTP port (default `3000`) |

---

## 3. Start the server locally

```bash
cd backend
npm install
npm start
# or: node server.js
```

Health check: `GET http://localhost:3000/` → `{ "status": "ok" }`

---

## Notes

- The service-role key **bypasses RLS**. RLS policies are in place for a future per-vendor frontend session using `auth.uid()`.
- The journal balance trigger is **deferrable** so you can insert multiple `journal_lines` in one transaction; balance is checked at commit.
- Do not put business logic in this phase — posting, webhooks, and statements come later.
