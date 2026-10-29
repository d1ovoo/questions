"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "questions" },
  { href: "/leaderboard", label: "leaderboard" },
  { href: "/profile", label: "profile" },
];

export function Nav() {
  // another player's page (/u/name) belongs to the leaderboard tab
  const pathname = usePathname();
  const path = pathname.startsWith("/u/") ? "/leaderboard" : pathname;
  return (
    <nav className="flex justify-center gap-3 pt-6 pb-2 text-sm">
      {tabs.map((t, i) => (
        <span key={t.href} className="flex gap-3">
          {i > 0 && <span className="text-muted">·</span>}
          <Link href={t.href} className={path === t.href ? "underline underline-offset-4" : "text-muted hover:text-foreground"}>
            {t.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
