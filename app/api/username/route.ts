import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { game } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const { username } = (await request.json().catch(() => ({}))) as { username?: string };
  const name = (username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(name)) {
    return NextResponse.json({ error: "3–20 letters, numbers or _" }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from("profiles")
    .insert({ id: userId, username: name, rating: game.startRating, peak_rating: game.startRating });
  if (error?.code === "23505") {
    // either the name is taken or this user already has a profile
    return NextResponse.json({ error: "taken" }, { status: 409 });
  }
  if (error) return NextResponse.json({ error: "try again" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
