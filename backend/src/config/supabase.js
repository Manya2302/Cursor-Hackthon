const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn(
    'Warning: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. Vendor upsert and DB calls will fail until configured.'
  );
}

// Placeholders allow the HTTP server to boot before secrets are filled in.
const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseServiceRoleKey || 'placeholder-service-role-key'
);

module.exports = supabase;
