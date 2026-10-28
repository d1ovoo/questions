import { redirect } from "next/navigation";
import { currentProfile } from "@/lib/auth";
import { game } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/server";
import { Nav } from "../nav";

type Group = { n: number; accuracy: number };
type Stats = {
  username: string;
  rating: number;
  peak_rating: number;
  provisional: boolean;
  rank: number | null;
  ranked_players: number;
  answered: number;
  correct: number;
  current_streak: number;
  best_streak: number;
  total_answer_ms: number;
  avg_answer_ms: number | null;
  fastest_correct_ms: number | null;
  timeouts: number;
  categories: (Group & { category: string })[];
  bands: (Group & { band: "easy" | "medium" | "hard" })[];
  history: number[];
  member_since: string;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);

function duration(ms: number) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default async function Profile() {
  const { profile } = await currentProfile();
  if (!profile) redirect("/");

  const { data } = await supabaseAdmin().rpc("profile_stats", {
    p_user: profile.id,
    p_min_answers: game.provisionalAnswers,
  });
  const s = data as Stats;

  // best/worst among categories with a few answers, so one lucky answer doesn't count
  const rated = s.categories.filter((c) => c.n >= 5);
  const pool = rated.length >= 2 ? rated : s.categories.length >= 2 ? s.categories : [];
  const sorted = [...pool].sort((a, b) => b.accuracy - a.accuracy);
  const band = (b: string) => s.bands.find((x) => x.band === b);

  const rows: [string, string][] = [
    ["rating", s.provisional ? `${s.rating} (provisional)` : String(s.rating)],
    ["peak rating", String(s.peak_rating)],
    ["global rank", s.rank ? `#${s.rank}` : "—"],
    [
      "percentile",
      s.rank ? `top ${Math.max(1, Math.ceil((s.rank / s.ranked_players) * 100))}%` : "—",
    ],
    ["", ""],
    ["answered", String(s.answered)],
    ["correct", String(s.correct)],
    ["accuracy", s.answered ? pct(s.correct / s.answered) : "—"],
    ["", ""],
    ["current streak", String(s.current_streak)],
    ["best streak", String(s.best_streak)],
    ["", ""],
    ["average answer time", secs(s.avg_answer_ms)],
    ["fastest correct answer", secs(s.fastest_correct_ms)],
    ["timeouts", String(s.timeouts)],
    ["", ""],
    ...s.categories.map((c): [string, string] => [c.category, `${pct(c.accuracy)} of ${c.n}`]),
    ...(sorted.length
      ? ([
          ["best category", sorted[0].category],
          ["worst category", sorted[sorted.length - 1].category],
        ] as [string, string][])
      : []),
    ["", ""],
    ...(["easy", "medium", "hard"] as const).map((b): [string, string] => {
      const x = band(b);
      return [b, x ? `${pct(x.accuracy)} of ${x.n}` : "—"];
    }),
    ["", ""],
    ["total time played", duration(s.total_answer_ms)],
    ["member since", new Date(s.member_since).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })],
  ];

  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-md px-4 py-10 tabular-nums">
        <h1 className="mb-8 text-center text-2xl">{s.username}</h1>
        {s.history.length > 1 && <History points={s.history} />}
        <dl>
          {rows.map(([k, v], i) =>
            k ? (
              <div key={k} className="flex justify-between py-0.5">
                <dt className="text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ) : (
              <div key={i} className="h-4" />
            ),
          )}
        </dl>
        <form action="/auth/signout" method="post" className="mt-16 text-center">
          <button className="text-muted hover:text-foreground hover:underline underline-offset-4">sign out</button>
        </form>
      </main>
    </>
  );
}

// rating history as a single thin line, no axes
function History({ points }: { points: number[] }) {
  const w = 400;
  const h = 60;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((p - min) / span) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 -2 ${w} ${h + 4}`} className="mb-8 h-16 w-full" preserveAspectRatio="none" aria-label="rating history">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
