import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

console.log("Supabase URL:", supabaseUrl)

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase env variables. Check .env.local in the project root.")
}

export const supabase = createClient(supabaseUrl, supabaseKey)