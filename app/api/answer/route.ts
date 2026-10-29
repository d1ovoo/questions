import { NextResponse } from "next/server";
import { normalize } from "@/lib/answer";
import { currentUserId } from "@/lib/auth";
import { game } from "@/lib/config";
import { rateLimited } from "@/lib/ratelimit";
import { supabaseAdmin } from "@/lib/supabase/server";

// Grades the chosen option for the user's pending question. The deadline is checked in
// Postgres against served_at, so the client clock is never trusted.
export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (rateLimited(`answer:${userId}`)) return NextResponse.json({ error: "slow down" }, { status: 429 });

  // choice is the option text; empty means "give up" or time ran out
  const body = (await request.json().catch(() => ({}))) as { id?: number; choice?: string };
  const choice = typeof body.choice === "string" ? body.choice.slice(0, 200) : "";

  const admin = supabaseAdmin();
  const { data: pending } = await admin.rpc("current_question", { p_user: userId });
  const q = pending?.[0];
  if (!q || q.id !== body.id) return NextResponse.json({ error: "no such question" }, { status: 409 });

  const { data, error } = await admin.rpc("grade_answer", {
    p_user: userId,
    p_question: q.id,
    p_given: choice,
    p_correct: choice !== "" && normalize(choice) === normalize(q.answer),
    p_limit_ms: game.timeLimitMs + game.graceMs,
    p_k_provisional: game.kProvisional,
    p_k_established: game.kEstablished,
    p_provisional_n: game.provisionalAnswers,
    p_guess: game.guessChance,
    p_question_k: game.questionK,
  });
  if (error) return NextResponse.json({ error: "no such question" }, { status: 409 });

  return NextResponse.json({
    correct: data.correct,
    timedOut: data.timed_out,
    answer: data.answer,
    delta: Math.round(data.rating_after) - Math.round(data.rating_before),
    rating: Math.round(data.rating_after),
  });
}
