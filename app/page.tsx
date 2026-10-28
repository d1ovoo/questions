import Link from "next/link";
import { currentProfile } from "@/lib/auth";
import { Game } from "./game";
import { Nav } from "./nav";
import { UsernameForm } from "./username-form";

export default async function Questions() {
  const { userId, profile } = await currentProfile();

  if (!userId) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <Link href="/signin" className="underline underline-offset-4">
          sign in
        </Link>
      </main>
    );
  }
  if (!profile) return <UsernameForm />;

  return (
    <>
      <Nav />
      <Game />
    </>
  );
}
