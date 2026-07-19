# Gamma / PPT Prompt — NIRVHA (Interview Deck)

> **How to use:** Copy everything inside the box below → paste into [Gamma.app](https://gamma.app) (or ChatGPT / Beautiful.ai) and ask it to generate an **8-slide interview presentation**.  
> Project name in code/docs: **NIRVHA** (also referred to as LedgerBot in demos).

---

## PASTE THIS PROMPT INTO GAMMA

```
Create a professional, interview-ready pitch deck (exactly 8 slides) about my hackathon / college project named NIRVHA.

Audience: technical interviewer / hackathon judges / recruiters.
Tone: clear, confident, product + engineering depth — not fluffy marketing.
Visual style: clean modern tech deck, dark navy / teal accents, minimal icons, one idea per slide, readable from 3 meters away. Avoid purple AI clichés and emoji spam.
Language: English. Optionally note that the product supports Gujarati + English.

Slide count: exactly 8 slides.
Each slide must have: a short title, 4–7 bullet points max, and one “talking point” line at the bottom for the presenter (labeled “Say this:”).

========================
PROJECT FACTS (use these — do not invent false claims)
========================

PRODUCT NAME: NIRVHA
ONE-LINER: An invisible AI accountant that lives inside WhatsApp for Indian kirana / small retailers.

PROBLEM:
- Small shop owners already run their business on WhatsApp (orders, bills, voice notes, photos).
- They do not use Tally/Zoho daily — too heavy, English-heavy, desktop-bound.
- Handwritten bills, Gujarati speech, and messy stock lists never become proper double-entry books.
- Price mistakes and unknown products cause silent losses.

SOLUTION:
- Merchant sends WhatsApp text / Gujarati voice / bill photo / CSV-PDF stock file.
- Single AI agent classifies intent (no slash commands).
- Shows confirmation → merchant replies YES / NO / UPDATE PRICE / ADD PRODUCTS.
- On YES: posts double-entry journal, Product Master, stock movement, and profit — money math is done in SQL/JS, never by the LLM.

WHO IT’S FOR:
- Kirana stores, small retailers, coaching centres, small manufacturers in India (bilingual EN + Gujarati).

========================
FEATURES TO HIGHLIGHT (cover across slides)
========================

1. WhatsApp-native bookkeeping (Meta WhatsApp Cloud API webhook)
2. Multimodal input: text, image (handwritten bill OCR), voice (Sarvam Saaras STT + Groq fallback), documents (CSV / Excel / PDF stock)
3. Single AI agent intent routing: sale/purchase, inventory bulk, product query, statements, chat
4. Product Master (source of truth): aliases EN/GU (Sugar ↔ ખાંડ, Maggi ↔ Maggie), selling/purchase price, stock, reorder
5. Bill verification against Product Master: unit rate × qty, price mismatch alerts, unknown product auto-add on YES
6. Double-entry ledger: journal entries, parties (customers/suppliers), cash / debtor / creditor, UNDO within 2 minutes
7. Profit & statements: today’s profit, P&L, balance sheet, cash flow, account ledger — WhatsApp text + PDF; frontend Statements viewer
8. Bilingual UX: English + Gujarati labels/voice; OTP register + dashboard on React web app
9. One-click local demo: start.bat launches backend + frontend + ngrok for Meta webhook

========================
TECH STACK (must appear clearly)
========================

Frontend:
- React 19 + Vite + React Router
- Auth UI (register / OTP / login / dashboard / statements)

Backend:
- Node.js (≥20) + Express 5
- WhatsApp webhook (verify + async process, always 200 to Meta)
- Services: productMaster, priceVerify, transactions, ledger, statements, inventory import

AI / ML APIs:
- Groq (LLM): intent extraction, vision OCR for bills, chat replies, optional Whisper STT fallback
- Sarvam AI Saaras v3: Gujarati / Indian speech-to-text for voice notes

Data:
- Supabase (PostgreSQL): vendors, parties, accounts, journal_entries, product_master, product_aliases, sales_transactions, inventory_movements, verification_results, auth tables
- Migrations for Product Master + cascades

Infra / Dev:
- ngrok static HTTPS tunnel for Meta webhook
- Render-ready (Node web service for backend; static site for frontend)
- dotenv, CORS, PDF (pdfkit), CSV/XLSX parsers

Architecture principle to emphasize:
“LLM understands language & documents; deterministic JS/SQL owns money, stock, and verification.”

========================
SLIDE OUTLINE (follow strictly — 8 slides)
========================

SLIDE 1 — Title / Hook
- NIRVHA
- Tagline: Invisible AI accountant inside WhatsApp
- Subtitle: Double-entry books from the messages shopkeepers already send
- Team / hackathon context line (leave placeholder: Your Name · College / Hackathon)
- Say this: “We didn’t ask kiranas to learn accounting software — we put accounting into WhatsApp.”

SLIDE 2 — Problem & Opportunity
- WhatsApp-first India MSME reality
- Paper bills + Gujarati voice = no books
- Wrong prices / missing catalog = silent loss
- Gap between chat habits and formal GST-ready records
- Say this: “The opportunity is huge because the behavior already exists; the ledger doesn’t.”

SLIDE 3 — Solution & User Journey
- End-to-end flow diagram in bullets:
  Input (text/voice/photo/CSV) → AI intent → Confirmation → YES → Ledger + Product Master + Stock + Profit
- Human-in-the-loop (never silent auto-post without confirm)
- Bilingual EN/GU
- Say this: “Confirmation is the trust layer — AI proposes, merchant approves.”

SLIDE 4 — Feature Deep Dive (Product)
- Product Master + aliases
- Bill OCR + price verification vs master
- YES / UPDATE PRICE / ADD PRODUCTS
- Stock decrement on sale
- Voice (Sarvam) + Gujarati lexicon
- Statements + PDF + today profit
- React dashboard / statements UI
- Say this: “This is not a chatbot — it’s an ops system with a WhatsApp UI.”

SLIDE 5 — Tech Stack
- Full stack table/list: React+Vite | Node+Express | Supabase Postgres | Meta WhatsApp | Groq | Sarvam | ngrok/Render
- Why each choice in one short clause
- Say this: “We picked boring reliable infrastructure and sharp AI APIs where language is hard.”

SLIDE 6 — System Architecture
- Boxes: WhatsApp → ngrok → Express webhook → Groq/Sarvam → Postgres (Product Master + Journals) → reply WhatsApp + optional PDF
- Frontend talks to same Express /api
- Money math never in LLM
- Say this: “Separation of concerns is our safety story for interviewers.”

SLIDE 7 — Demo / Impact / Traction (hackathon)
- Demo path: Hi → Add products → Bill photo → YES → Profit / Statement PDF
- Impact: books without changing daily habit; fewer pricing mistakes; bilingual
- Honest note: AI statements for visibility / GST-prep — CA review before formal filing
- Say this: “In under two minutes a handwritten Maggi line becomes stock movement and profit.”

SLIDE 8 — Closing / Interview Q&A bait
- What we built vs what’s next (permanent Meta token, email OTP, multi-store, GST export)
- Role I owned (placeholder: backend AI agent / Product Master / WhatsApp pipeline — fill your role)
- Contact / GitHub / live webhook note
- Thank you + “Questions?”
- Say this: “Happy to walk through bill verification math or the YES confirmation state machine.”

========================
OUTPUT RULES FOR GAMMA
========================
- Exactly 8 slides.
- Prefer bullets over paragraphs.
- Include the “Say this:” presenter line on every slide.
- Do not invent metrics (downloads, revenue, users) unless marked as placeholders.
- Use product name NIRVHA consistently.
- Title the deck: “NIRVHA — WhatsApp-Native AI Bookkeeping”
```

---

## Optional: shorter 1-line Gamma prompt

If Gamma asks for a short prompt first:

```
8-slide interview deck for NIRVHA: WhatsApp AI accountant for Indian kiranas — problem, solution, features (OCR bills, Gujarati voice, Product Master, double-entry, profit/PDF), tech stack (React, Node, Supabase, Meta WhatsApp, Groq, Sarvam, ngrok), architecture, demo, closing. Professional tech style, bilingual EN/GU note, no fake metrics.
```

---

## Fill-in before you present

| Placeholder | Your answer |
|---|---|
| Your name / team | |
| Your role on the project | |
| College / hackathon name | |
| GitHub URL | https://github.com/Manya2302/Cursor-Hackthon |
| Live demo tip | `start.bat` + Meta webhook + fresh `WHATSAPP_TOKEN` |

---

## Suggested 60-second verbal pitch (memorize)

> “NIRVHA is an invisible AI accountant inside WhatsApp. Kirana owners already send bills, voice notes, and stock lists on chat — we turn those into real double-entry books. Groq and Sarvam handle language and OCR; Postgres and our Product Master own prices, stock, and profit so the LLM never invents rupees. Merchant always confirms with YES. I’d love to show you a Maggi bill photo going to verified sale and stock decrease.”
