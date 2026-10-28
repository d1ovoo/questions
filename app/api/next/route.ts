import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { game } from "@/lib/config";
import { rateLimited } from "@/lib/ratelimit";
import { supabaseAdmin } from "@/lib/supabase/server";

// Returns the pending question (with time already used) or serves a new one.
export async function POST() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (rateLimited(`next:${userId}`)) return NextResponse.json({ error: "slow down" }, { status: 429 });

  const { data, error } = await supabaseAdmin().rpc("next_question", {
    p_user: userId,
    p_window: game.matchWindow,
    p_limit_ms: game.timeLimitMs + game.graceMs,
    p_k_provisional: game.kProvisional,
    p_k_established: game.kEstablished,
    p_provisional_n: game.provisionalAnswers,
  });
  if (error) return NextResponse.json({ error: "try again" }, { status: 500 });

  if (data.status === "empty") return NextResponse.json({ status: "empty" });
  return NextResponse.json({
    status: "question",
    id: data.id,
    question: data.question,
    category: data.category,
    remainingMs: Math.max(0, game.timeLimitMs - data.elapsed_ms),
  });
}
