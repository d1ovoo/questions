import { NextResponse } from "next/server";
import { isCorrect } from "@/lib/answer";
import { currentUserId } from "@/lib/auth";
import { game } from "@/lib/config";
import { rateLimited } from "@/lib/ratelimit";
import { supabaseAdmin } from "@/lib/supabase/server";

// Grades the answer to the user's pending question. The deadline is checked in
// Postgres against served_at, so the client clock is never trusted.
export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (rateLimited(`answer:${userId}`)) return NextResponse.json({ error: "slow down" }, { status: 429 });

  const body = (await request.json().catch(() => ({}))) as { id?: number; answer?: string };
  const given = typeof body.answer === "string" ? body.answer.slice(0, 200) : "";

  const admin = supabaseAdmin();
  const { data: pending } = await admin.rpc("pending_question", { p_user: userId });
  const q = pending?.[0];
  if (!q || q.id !== body.id) return NextResponse.json({ error: "no such question" }, { status: 409 });

  const correct = isCorrect(given, q.answer, q.accepted_answers, game.fuzzyThreshold);
  const { data, error } = await admin.rpc("record_answer", {
    p_user: userId,
    p_question: q.id,
    p_given: given,
    p_correct: correct,
    p_limit_ms: game.timeLimitMs + game.graceMs,
    p_k_provisional: game.kProvisional,
    p_k_established: game.kEstablished,
    p_provisional_n: game.provisionalAnswers,
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
