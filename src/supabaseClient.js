import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase env variables. Check .env.local in the project root.")
}

// Use only the Supabase publishable/anon key in the browser. Service role keys must stay server-side.
// Future auth policy point: once sign-in is added, RLS policies should enforce per-warehouse access.
export const supabase = createClient(supabaseUrl, supabaseKey)
