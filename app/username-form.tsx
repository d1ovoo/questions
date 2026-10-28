"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Shown once, on first sign-in.
export function UsernameForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    const res = await fetch("/api/username", { method: "POST", body: JSON.stringify({ username: name }) });
    if (res.ok) return router.refresh();
    setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "try again");
    setBusy(false);
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-xs">
        <input
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={20}
          placeholder="choose a username"
          value={name}
          onChange={(e) => {
            setName(e.target.value.toLowerCase());
            setError("");
          }}
          className="w-full border-b border-muted py-2 text-center text-xl focus:border-foreground"
        />
        <p className="mt-3 h-5 text-center text-sm text-muted">{error}</p>
      </form>
    </main>
  );
}
