import Link from "next/link";
import { redirect } from "next/navigation";
import { currentProfile } from "@/lib/auth";
import { game } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/server";
import { Nav } from "../nav";

type Row = { rank: number; username: string; rating: number; me: boolean };

export default async function Leaderboard() {
  const { profile } = await currentProfile();
  if (!profile) redirect("/");

  const { data } = await supabaseAdmin().rpc("leaderboard", {
    p_user: profile.id,
    p_min_answers: game.provisionalAnswers,
  });
  const top: Row[] = data?.top ?? [];
  const me: Row | null = data?.me ?? null;
  const pinned = me && !top.some((r) => r.me) ? me : null;
  const remaining = game.provisionalAnswers - profile.answered;

  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-md px-4 py-10 tabular-nums">
        {top.length === 0 && <p className="text-center text-muted">no ranked players yet.</p>}
        <ol>
          {top.map((r) => (
            <Line key={r.username} row={r} />
          ))}
        </ol>
        {pinned && (
          <ol className="mt-4 border-t border-muted pt-4">
            <Line row={pinned} />
          </ol>
        )}
        {remaining > 0 && (
          <p className="mt-6 text-center text-sm text-muted">
            unranked · {remaining} more {remaining === 1 ? "answer" : "answers"}
          </p>
        )}
      </main>
    </>
  );
}

function Line({ row }: { row: Row }) {
  return (
    <li className={row.me ? "font-semibold" : ""}>
      <Link href={row.me ? "/profile" : `/u/${row.username}`} className="group flex gap-4 py-1">
        <span className="w-10 text-right text-muted">{row.rank}</span>
        <span className="flex-1 truncate underline-offset-4 group-hover:underline">{row.username}</span>
        <span>{row.rating}</span>
      </Link>
    </li>
  );
}
