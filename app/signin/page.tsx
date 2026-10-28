"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const redirectTo = () => `${window.location.origin}/auth/callback`;

  async function google() {
    await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
  }

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("sending");
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo() },
    });
    setState(error ? "error" : "sent");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-4">
      <button onClick={google} className="hover:underline underline-offset-4">
        continue with google
      </button>
      {state === "sent" ? (
        <p>check your email.</p>
      ) : (
        <form onSubmit={magicLink} className="w-full max-w-xs">
          <input
            type="email"
            autoFocus
            autoComplete="email"
            enterKeyHint="send"
            placeholder="or email + enter"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={state === "sending"}
            className="w-full border-b border-muted py-2 text-center focus:border-foreground"
          />
          {state === "error" && <p className="mt-3 text-center text-sm text-muted">something went wrong. try again.</p>}
        </form>
      )}
    </main>
  );
}
