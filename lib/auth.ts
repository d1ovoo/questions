import "server-only";
import { supabaseAdmin, supabaseServer } from "./supabase/server";

export type Profile = { id: string; username: string; rating: number; answered: number };

export async function currentUserId(): Promise<string | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ?? null;
}

export async function currentProfile(): Promise<{ userId: string | null; profile: Profile | null }> {
  const userId = await currentUserId();
  if (!userId) return { userId: null, profile: null };
  const { data } = await supabaseAdmin()
    .from("profiles")
    .select("id, username, rating, answered")
    .eq("id", userId)
    .maybeSingle();
  return { userId, profile: data };
}
