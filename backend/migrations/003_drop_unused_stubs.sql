-- Drop unused future-AI stub tables (not used by live WhatsApp path).
-- Safe / idempotent.

drop table if exists business_insights cascade;
drop table if exists notifications cascade;
drop table if exists audit_logs cascade;
drop table if exists product_categories cascade;

-- Optional: verification_logs kept (used). ocr_* kept (used by priceVerify).
