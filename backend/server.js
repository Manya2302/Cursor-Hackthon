const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load backend/.env, then repo-root .env as fallback for any missing keys.
const backendEnv = path.join(__dirname, '.env');
const rootEnv = path.join(__dirname, '..', '.env');
dotenv.config({ path: backendEnv });
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv, override: false });
}

// Normalize quoted values copied from Python .env style
for (const key of [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'VERIFY_TOKEN',
  'WHATSAPP_VERIFY_TOKEN',
  'GROQ_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_API',
  'DATABASE_URL',
]) {
  if (process.env[key]) {
    process.env[key] = process.env[key].replace(/^["']|["']$/g, '').trim();
  }
}

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`NIRVHA listening on port ${PORT}`);
  console.log(
    `WHATSAPP_TOKEN set: ${Boolean(process.env.WHATSAPP_TOKEN)} | GROQ set: ${Boolean(process.env.GROQ_API_KEY)} | VERIFY_TOKEN: ${process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || '(missing)'}`
  );
});
