import { redirect } from "next/navigation";
import { currentProfile } from "@/lib/auth";
import { Nav } from "../nav";
import { ProfileStats } from "../stats";

export default async function Profile() {
  const { profile } = await currentProfile();
  if (!profile) redirect("/");

  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-md px-4 py-10 tabular-nums">
        <ProfileStats userId={profile.id} />
        <form action="/auth/signout" method="post" className="mt-16 text-center">
          <button className="text-muted hover:text-foreground hover:underline underline-offset-4">sign out</button>
        </form>
      </main>
    </>
  );
}
