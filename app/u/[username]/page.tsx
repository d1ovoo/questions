import { notFound, redirect } from "next/navigation";
import { currentProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { Nav } from "../../nav";
import { ProfileStats } from "../../stats";

// Another player's stats, opened from the leaderboard.
export default async function PlayerProfile({ params }: PageProps<"/u/[username]">) {
  const { profile: me } = await currentProfile();
  if (!me) redirect("/");

  const { username } = await params;
  const { data: player } = await supabaseAdmin()
    .from("profiles")
    .select("id")
    .eq("username", decodeURIComponent(username).toLowerCase())
    .maybeSingle();
  if (!player) notFound();
  if (player.id === me.id) redirect("/profile");

  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-md px-4 py-10 tabular-nums">
        <ProfileStats userId={player.id} />
      </main>
    </>
  );
}
