"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Supabase error codes -> something a player can act on
function explain(code: string | undefined, status: number | undefined): string {
  if (code === "over_email_send_rate_limit" || status === 429)
    return "too many sign-in emails were sent in the last hour. try again later.";
  if (code === "email_address_invalid" || code === "validation_failed") return "that email doesn't look right.";
  if (code === "signup_disabled") return "sign-ups are closed right now.";
  return "something went wrong. try again.";
}

export function SignInForm({ googleEnabled, linkFailed }: { googleEnabled: boolean; linkFailed: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState(
    linkFailed ? "that link didn't work. it may have expired, or was opened in a different browser. request a new one here." : "",
  );
  const redirectTo = () => `${window.location.origin}/auth/callback`;

  async function google() {
    const { error } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) {
      setState("error");
      setMessage(explain(error.code, error.status));
    }
  }

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("sending");
    setMessage("");
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo() },
    });
    if (error) {
      setState("error");
      setMessage(explain(error.code, error.status));
    } else setState("sent");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-4">
      {googleEnabled && (
        <button onClick={google} className="hover:underline underline-offset-4">
          continue with google
        </button>
      )}
      {state === "sent" ? (
        <p className="max-w-xs text-center">check your email, and open the link in this browser.</p>
      ) : (
        <form onSubmit={magicLink} className="w-full max-w-xs">
          <input
            type="email"
            autoFocus
            autoComplete="email"
            enterKeyHint="send"
            placeholder={googleEnabled ? "or email + enter" : "email + enter"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={state === "sending"}
            className="w-full border-b border-muted py-2 text-center focus:border-foreground"
          />
          {message && <p className="mt-3 text-center text-sm text-muted">{message}</p>}
        </form>
      )}
    </main>
  );
}
