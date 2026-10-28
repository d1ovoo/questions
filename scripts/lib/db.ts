// Service-role Supabase client for the local scripts. Never import this from app code.
import { createClient } from "@supabase/supabase-js";
import "./config";

export function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;
