import os
import sys
import base64
import io
import csv
import requests
import pdfplumber
import pandas as pd
from fastapi import FastAPI, Request, Response, HTTPException
from dotenv import load_dotenv
from groq import Groq

# Fix Windows console encoding for Unicode (Gujarati) characters
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Load environment variables
load_dotenv()

WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
VERIFY_TOKEN = os.getenv("VERIFY_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

app = FastAPI()

# Initialize Groq client
if GROQ_API_KEY:
    groq_client = Groq(api_key=GROQ_API_KEY)
else:
    groq_client = None

# ─────────────────────────────────────────────────────────
# ROOT & WEBHOOK VERIFICATION
# ─────────────────────────────────────────────────────────

@app.get("/")
def read_root():
    return {"message": "WhatsApp AI Webhook Backend is running."}

@app.get("/webhook")
async def verify_webhook(request: Request):
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")
    if mode and token:
        if mode == "subscribe" and token == VERIFY_TOKEN:
            print("WEBHOOK_VERIFIED")
            return Response(content=challenge, status_code=200)
        else:
            raise HTTPException(status_code=403, detail="Verification token mismatch")
    raise HTTPException(status_code=400, detail="Missing parameters")

# ─────────────────────────────────────────────────────────
# INCOMING MESSAGE HANDLER
# ─────────────────────────────────────────────────────────

@app.post("/webhook")
async def webhook_events(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    print("Incoming webhook:", body)

    if body.get("object") == "whatsapp_business_account":
        entry = body.get("entry", [{}])[0]
        changes = entry.get("changes", [{}])[0]
        value = changes.get("value", {})

        if "messages" not in value:
            return Response(content="EVENT_RECEIVED", status_code=200)

        message = value["messages"][0]
        phone_number_id = value["metadata"]["phone_number_id"]
        from_number = message["from"]
        msg_type = message.get("type")
        response_text = ""

        if msg_type == "text":
            user_text = message["text"]["body"]
            print(f"Text from {from_number}: {user_text}")
            response_text = generate_ai_response(user_text)

        elif msg_type == "image":
            image_id = message["image"]["id"]
            caption = message["image"].get("caption", "").lower()
            print(f"Image from {from_number}, ID: {image_id}, caption: {caption}")
            # If caption hints at Gujarati/OCR, use full pipeline
            gujarati_hints = ["gujarati", "guj", "ocr", "translate", "text", "gu", ""]
            if any(h in caption for h in gujarati_hints):
                response_text = gujarati_ocr_pipeline(image_id, caption)
            else:
                response_text = analyze_image_general(image_id, caption)

        elif msg_type == "audio":
            audio_id = message["audio"]["id"]
            print(f"Audio from {from_number}, ID: {audio_id}")
            response_text = transcribe_audio(audio_id)

        elif msg_type == "document":
            doc_info = message["document"]
            document_id = doc_info["id"]
            filename = doc_info.get("filename", "document")
            mime_type = doc_info.get("mime_type", "")
            print(f"Document '{filename}' ({mime_type}) from {from_number}")
            response_text = extract_document_content(document_id, filename, mime_type)

        else:
            response_text = f"Unsupported message type: {msg_type}"

        if response_text:
            send_whatsapp_message(phone_number_id, from_number, response_text)

        return Response(content="EVENT_RECEIVED", status_code=200)

    raise HTTPException(status_code=404, detail="Not Found")


# ─────────────────────────────────────────────────────────
# DOCUMENT EXTRACTION PIPELINE
# Supports: PDF, Excel (.xlsx/.xls), CSV
# ─────────────────────────────────────────────────────────

def extract_document_content(document_id: str, filename: str, mime_type: str) -> str:
    """
    Download and extract exact content from:
      - PDF  → pdfplumber (text-based) or Groq Vision (scanned/image PDF)
      - Excel → pandas (all sheets, all rows)
      - CSV  → python csv reader (all rows)
    Then sends extracted text to Groq LLM for a brief summary.
    """
    # Download the file
    file_bytes = download_whatsapp_media(document_id)
    if not file_bytes:
        return f"❌ Could not download *{filename}*. Please try again."

    fname_lower = filename.lower()
    extracted_text = ""
    file_type_label = ""

    # ── PDF ─────────────────────────────────────────────
    if fname_lower.endswith(".pdf") or "pdf" in mime_type:
        file_type_label = "PDF"
        try:
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                pages_text = []
                for i, page in enumerate(pdf.pages):
                    page_text = page.extract_text()
                    if page_text and page_text.strip():
                        pages_text.append(f"[Page {i+1}]\n{page_text.strip()}")
                extracted_text = "\n\n".join(pages_text)

            # If no text found, it's likely a scanned PDF — use Groq Vision on page 1
            if not extracted_text.strip():
                print("Scanned PDF detected, using vision OCR on first page...")
                with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                    if pdf.pages:
                        # Render first page as image
                        page_image = pdf.pages[0].to_image(resolution=200)
                        img_buffer = io.BytesIO()
                        page_image.save(img_buffer, format="PNG")
                        img_b64 = base64.b64encode(img_buffer.getvalue()).decode("utf-8")
                        # Use Groq Vision OCR
                        ocr_result = groq_client.chat.completions.create(
                            messages=[{
                                "role": "user",
                                "content": [
                                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                                    {"type": "text", "text": "Extract ALL text from this document page exactly as it appears, preserving layout, numbers, and structure. Output only the extracted text."}
                                ]
                            }],
                            model="qwen/qwen3.6-27b",
                        )
                        extracted_text = ocr_result.choices[0].message.content.strip()
        except Exception as e:
            print(f"PDF extraction error: {e}")
            return f"❌ Could not read *{filename}*: {e}"

    # ── EXCEL (.xlsx / .xls) ─────────────────────────────
    elif fname_lower.endswith((".xlsx", ".xls")):
        file_type_label = "Excel"
        try:
            engine = "openpyxl" if fname_lower.endswith(".xlsx") else "xlrd"
            xl = pd.ExcelFile(io.BytesIO(file_bytes), engine=engine)
            sheet_texts = []
            for sheet_name in xl.sheet_names:
                df = xl.parse(sheet_name)
                # Drop completely empty rows/columns
                df.dropna(how="all", inplace=True)
                df.dropna(axis=1, how="all", inplace=True)
                if df.empty:
                    continue
                sheet_str = f"[Sheet: {sheet_name}]\n"
                sheet_str += df.to_string(index=False)
                sheet_texts.append(sheet_str)
            extracted_text = "\n\n".join(sheet_texts)
        except Exception as e:
            print(f"Excel extraction error: {e}")
            return f"❌ Could not read *{filename}*: {e}"

    # ── CSV ──────────────────────────────────────────────
    elif fname_lower.endswith(".csv") or "csv" in mime_type:
        file_type_label = "CSV"
        try:
            # Try UTF-8 first, then latin-1 as fallback
            for encoding in ("utf-8", "utf-8-sig", "latin-1"):
                try:
                    text_content = file_bytes.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue
            reader = csv.reader(io.StringIO(text_content))
            rows = [", ".join(row) for row in reader if any(cell.strip() for cell in row)]
            extracted_text = "\n".join(rows)
        except Exception as e:
            print(f"CSV extraction error: {e}")
            return f"❌ Could not read *{filename}*: {e}"

    else:
        return f"⚠️ *{filename}* — file type not supported yet.\nSupported: PDF, Excel (.xlsx/.xls), CSV"

    if not extracted_text.strip():
        return f"⚠️ *{filename}* appears to be empty or contains no readable text."

    print(f"Extracted {len(extracted_text)} chars from {filename}")

    # Limit to 6000 chars for WhatsApp + LLM context
    CHAR_LIMIT = 6000
    truncated = False
    display_text = extracted_text
    if len(extracted_text) > CHAR_LIMIT:
        display_text = extracted_text[:CHAR_LIMIT]
        truncated = True

    # Generate AI summary
    try:
        summary_result = groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "You are a document analyst. Summarize the key information from this document in 3-5 bullet points."
                },
                {
                    "role": "user",
                    "content": f"Summarize this {file_type_label} document:\n\n{display_text}"
                }
            ],
            model="llama-3.1-8b-instant",
        )
        summary = summary_result.choices[0].message.content.strip()
    except Exception:
        summary = "(Summary unavailable)"

    truncation_note = f"\n_(Showing first {CHAR_LIMIT} of {len(extracted_text)} characters)_" if truncated else ""
    return (
        f"📄 *{filename}* ({file_type_label}){truncation_note}\n\n"
        f"📋 *Summary:*\n{summary}\n\n"
        f"📝 *Extracted Content:*\n{display_text}"
    )


# ─────────────────────────────────────────────────────────
# GUJARATI OCR PIPELINE
# Image → OCR (Groq Vision) → Gujarati Text
#       → Translation (Groq LLM) → English
#       → Summary (Groq LLM)
# ─────────────────────────────────────────────────────────

def gujarati_ocr_pipeline(image_id: str, caption: str = "") -> str:
    """
    Full pipeline:
      Image → Groq Vision OCR → Gujarati Unicode text
            → Groq LLM Translation → English
            → Groq LLM Summary
    """
    if not groq_client:
        return "AI not configured."

    # ── STEP 1: Download image ──────────────────────────
    image_bytes = download_whatsapp_media(image_id)
    if not image_bytes:
        return "❌ Could not download your image. Please try again."

    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    # ── STEP 2: OCR – Extract Gujarati text via Groq Vision ──
    try:
        ocr_result = groq_client.chat.completions.create(
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}
                    },
                    {
                        "type": "text",
                        "text": (
                            "This image may contain Gujarati script text. "
                            "Extract ALL text from this image exactly as it appears, "
                            "preserving Gujarati Unicode characters. "
                            "Output ONLY the extracted text, nothing else. "
                            "If no text is found, say 'No text found'."
                        )
                    }
                ]
            }],
            model="qwen/qwen3.6-27b",
        )
        gujarati_text = ocr_result.choices[0].message.content.strip()
        print(f"OCR result: {gujarati_text}")
    except Exception as e:
        print(f"OCR error: {e}")
        return f"❌ OCR failed: {e}"

    if not gujarati_text or gujarati_text.lower() == "no text found":
        return "🖼️ No text was detected in your image."

    # ── STEP 3: Translate Gujarati → English via Groq LLM ──
    try:
        translation_result = groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert Gujarati-to-English translator. "
                        "Translate the provided Gujarati text to clear, accurate English. "
                        "Output only the English translation, nothing else."
                    )
                },
                {
                    "role": "user",
                    "content": f"Translate this Gujarati text to English:\n\n{gujarati_text}"
                }
            ],
            model="llama-3.1-8b-instant",
        )
        english_text = translation_result.choices[0].message.content.strip()
        print(f"Translation: {english_text}")
    except Exception as e:
        print(f"Translation error: {e}")
        english_text = "(Translation failed)"

    # ── STEP 4: Summarize via Groq LLM ──────────────────
    try:
        summary_result = groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "Provide a concise summary of the text in 2-3 sentences."
                },
                {
                    "role": "user",
                    "content": f"Summarize:\n\n{english_text}"
                }
            ],
            model="llama-3.1-8b-instant",
        )
        summary = summary_result.choices[0].message.content.strip()
    except Exception as e:
        summary = "(Summary unavailable)"

    return (
        f"🔍 *Gujarati Text (OCR):*\n{gujarati_text}\n\n"
        f"🌐 *English Translation:*\n{english_text}\n\n"
        f"📋 *Summary:*\n{summary}"
    )


# ─────────────────────────────────────────────────────────
# GENERAL IMAGE DESCRIPTION (non-Gujarati images)
# ─────────────────────────────────────────────────────────

def analyze_image_general(image_id: str, caption: str = "") -> str:
    if not groq_client:
        return "AI not configured."
    image_bytes = download_whatsapp_media(image_id)
    if not image_bytes:
        return "❌ Could not download your image."
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")
    prompt = caption if caption else "Describe this image in detail."
    try:
        result = groq_client.chat.completions.create(
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt}
                ]
            }],
            model="qwen/qwen3.6-27b",
        )
        return "🖼️ " + result.choices[0].message.content
    except Exception as e:
        return f"❌ Image analysis failed: {e}"


# ─────────────────────────────────────────────────────────
# AUDIO TRANSCRIPTION (Whisper via Groq)
# ─────────────────────────────────────────────────────────

def transcribe_audio(audio_id: str) -> str:
    """
    Gujarati-optimised audio pipeline:
      Voice (ogg) → Whisper (language=gu) → Gujarati text
                 → Groq LLM translation → English
                 → Groq LLM response
    """
    if not groq_client:
        return "AI not configured."

    audio_bytes = download_whatsapp_media(audio_id)
    if not audio_bytes:
        return "❌ Could not download your voice message. Please try again."

    # ── STEP 1: Transcribe with Gujarati language hint ──────────────
    try:
        transcription = groq_client.audio.transcriptions.create(
            file=("audio.ogg", audio_bytes, "audio/ogg"),
            model="whisper-large-v3",
            language="gu",           # Force Gujarati recognition
            response_format="text",  # Plain text output
            prompt="આ ઑડિઓ ગુજરાતી ભાષામાં છે."  # Gujarati hint to Whisper
        )
        gujarati_text = transcription.strip()
        print(f"Gujarati transcription: {gujarati_text}")
    except Exception as e:
        print(f"Transcription error: {e}")
        return f"❌ Could not transcribe your voice message: {e}"

    if not gujarati_text:
        return "🎤 Could not detect any speech. Please speak clearly and try again."

    # ── STEP 2: Translate Gujarati → English ────────────────────────
    try:
        translation_result = groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert Gujarati-to-English translator. "
                        "Translate the given Gujarati text to clear, natural English. "
                        "Output only the English translation."
                    )
                },
                {
                    "role": "user",
                    "content": f"Translate this Gujarati text to English:\n\n{gujarati_text}"
                }
            ],
            model="llama-3.1-8b-instant",
        )
        english_text = translation_result.choices[0].message.content.strip()
        print(f"English translation: {english_text}")
    except Exception as e:
        print(f"Translation error: {e}")
        english_text = gujarati_text  # Fallback: use original text

    # ── STEP 3: Generate AI response in English ─────────────────────
    try:
        ai_response = generate_ai_response(english_text)
    except Exception as e:
        ai_response = "(Could not generate response)"

    return (
        f"🎤 *You said (Gujarati):*\n{gujarati_text}\n\n"
        f"🌐 *Translation:*\n{english_text}\n\n"
        f"🤖 *AI Response:*\n{ai_response}"
    )


# ─────────────────────────────────────────────────────────
# TEXT AI RESPONSE (Groq LLM)
# ─────────────────────────────────────────────────────────

def generate_ai_response(user_message: str) -> str:
    if not groq_client:
        return f"Echo: {user_message}"
    try:
        result = groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful and concise AI assistant on WhatsApp. Keep responses short and clear."
                },
                {"role": "user", "content": user_message}
            ],
            model="llama-3.1-8b-instant",
        )
        return result.choices[0].message.content
    except Exception as e:
        print(f"Groq error: {e}")
        return "Sorry, I encountered an error processing your message."


# ─────────────────────────────────────────────────────────
# WHATSAPP MEDIA DOWNLOAD
# ─────────────────────────────────────────────────────────

def download_whatsapp_media(media_id: str) -> bytes | None:
    try:
        url_resp = requests.get(
            f"https://graph.facebook.com/v17.0/{media_id}",
            headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"}
        )
        url_resp.raise_for_status()
        media_url = url_resp.json().get("url")
        if not media_url:
            return None
        media_resp = requests.get(
            media_url,
            headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"}
        )
        media_resp.raise_for_status()
        return media_resp.content
    except Exception as e:
        print(f"Media download error: {e}")
        return None


# ─────────────────────────────────────────────────────────
# SEND WHATSAPP MESSAGE
# ─────────────────────────────────────────────────────────

def send_whatsapp_message(phone_number_id: str, to_number: str, text: str):
    url = f"https://graph.facebook.com/v17.0/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json"
    }
    data = {
        "messaging_product": "whatsapp",
        "to": to_number,
        "type": "text",
        "text": {"body": text}
    }
    try:
        resp = requests.post(url, headers=headers, json=data)
        resp.raise_for_status()
        print(f"✅ Message sent to {to_number}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to send message: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"Details: {e.response.text}")

# Run with: uvicorn main:app --port 8000
