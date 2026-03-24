import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load the environment variables
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase credentials. Check your .env file!');
}

// Create and export the secure client
export const supabase = createClient(supabaseUrl, supabaseKey);