# LedgerBot — Live Demo Script

> AI-generated statements are for **internal visibility and GST-prep**.
> Have a Chartered Accountant review them before formal filing.

**Prep (once):**
1. Refresh Meta temporary WhatsApp token in `backend/.env` if older than ~20h.
2. Confirm Meta webhook URL: `https://king-snowstorm-roundworm.ngrok-free.dev/webhook` (verify token `manya123`).
3. Run backend + frontend + ngrok: `start.bat`.
4. Seed demo books (optional but recommended for judges):
   ```bash
   cd backend
   node scripts/seedDemoData.js <your_whatsapp_number_with_country_code>
   ```
5. Open frontend: `http://localhost:5173` → register/login with the same phone → Dashboard + Statements.

---

## WhatsApp flow (send in order)

| # | You send | Expected result |
|---|----------|-----------------|
| 1 | `hi` | Friendly chat reply from LedgerBot |
| 2 | `Add Sugar` / `Set Sugar price to 50 per kg` | Product Master confirm |
| 3 | Bill photo in format:\n`Name:` / `Number:` / `Ghee1kg-6-3000` | Verification: unit price = total÷count vs master; unknowns → *ADD PRODUCTS* (name → stock → price for one) |
| 4 | Reply `YES` / `UPDATE PRICE` / `ADD PRODUCTS` | Save with profit, or update master, or wizard-add then re-verify |
| 5 | `today profit` / `આજનો નફો` | Today's sales profit sum |
| 9 | `sample_inventory.csv` (from repo root) | Bulk → **YES** → legacy `products` + **Product Master** synced |
| 10 | Same CSV with one stock number changed | Summary shows updates → **YES** → stock_ledger + master stock |
| 11 | Voice note in Gujarati: «નામ ઓમ ત્રિવેદી નંબર ૯૯૭૪૦૯૯૦૬૩» (or after a bill) | Transcript keeps Gujarati; name/phone applied |
| 12 | `send me this month's statement` | Confirm → **YES** → P&L text + **PDF**. Ends with `✅ Verified balanced` or discrepancy note |
| 13 | `આ મહિનાનું નફો નુકસાન મોકલો` | Same numbers as step 12, labels in Gujarati + PDF |
| 14 | `cash ledger this month` | Dr/Cr ledger table text + PDF |
| 15 | `UNDO` (within 2 min of a save) | Last journal entry reversed |

### Data flow (Product Master)

`product setup / CSV` → **Product Master** → bill OCR/text → **priceVerify** (SQL/JS math) → WhatsApp report → **YES** → `sales_transactions` + journal + stock + profit. LLM never computes ₹.

---

## Frontend checks (judge)

1. **Dashboard** — live cash / receivables snapshot, recent journal rows, low-stock list (not “Sample data”).
2. **Statements** page — pick type `pnl`, period `this_month`, language English → table of figures matching WhatsApp.
3. Switch language to Gujarati → same rupee amounts, Gujarati labels.

---

## API smoke (optional)

```bash
# replace VENDOR_ID from seed output
curl -s http://localhost:3000/api/products/VENDOR_ID
curl -s "http://localhost:3000/api/products/VENDOR_ID/profit?datePhrase=today"
curl -s http://localhost:3000/api/inventory/VENDOR_ID
curl -s http://localhost:3000/api/statements/VENDOR_ID/tally
curl -s -X POST http://localhost:3000/api/statements -H "Content-Type: application/json" -d "{\"vendorId\":\"VENDOR_ID\",\"statementType\":\"pnl\",\"datePhrase\":\"this_month\",\"language\":\"en\"}"
```

---

## If something fails

| Symptom | Fix |
|---------|-----|
| WhatsApp 401 | Refresh `WHATSAPP_TOKEN` in `backend/.env`, restart backend |
| Webhook silent | Ngrok window open? Meta callback URL + verify token? |
| DB errors | `DATABASE_URL` / Supabase keys in `backend/.env`; service role must bypass RLS |
| Empty statements | Run `seedDemoData.js` or post a few YES sales first |
| Voice 500 | Wait and resend; Whisper retries automatically |
