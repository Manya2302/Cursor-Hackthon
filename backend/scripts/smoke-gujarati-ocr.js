require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
for (const k of Object.keys(process.env)) {
  if (process.env[k]) {
    process.env[k] = String(process.env[k]).replace(/^["']|["']$/g, '').trim();
  }
}

const fs = require('fs');
const path = require('path');
const { ocrImageText, extractIntent } = require('../src/services/groq');
const { buildConfirmationSummary } = require('../src/utils/confirmation');

const imgPath =
  process.argv[2] ||
  path.join(
    process.env.USERPROFILE || '',
    '.cursor/projects/d-Manya-Cursor-hackathon/assets/c__Users_Admin_AppData_Roaming_Cursor_User_workspaceStorage_f02ccd8e73d2346946a75bd2d7544c0e_images_image-3aafa9f1-8569-4976-84eb-6ba852366c89.png'
  );

(async () => {
  const buf = fs.readFileSync(imgPath);
  console.log('OCR…');
  const ocr = await ocrImageText(buf, 'image/png');
  console.log('--- OCR ---\n', ocr);
  const parsed = await extractIntent(
    'User sent a Gujarati handwritten customer bill image.\nContent:\n' + ocr
  );
  console.log('--- PARSED ---\n', JSON.stringify(parsed, null, 2));
  console.log('--- CONFIRM ---\n', buildConfirmationSummary(parsed));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
