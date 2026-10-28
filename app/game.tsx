"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { game } from "@/lib/config";

type Question = { id: number; question: string; remainingMs: number };
type Result = { correct: boolean; answer: string; delta: number };
type Phase = "loading" | "question" | "result" | "empty" | "error";

const signed = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

async function fetchNext(): Promise<(Question & { status: "question" }) | { status: "empty" } | "signed out" | null> {
  const res = await fetch("/api/next", { method: "POST" }).catch(() => null);
  if (res?.status === 401) return "signed out";
  return res?.ok ? res.json() : null;
}

export function Game() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [q, setQ] = useState<Question | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const valueRef = useRef("");
  const busy = useRef(false);
  const resultAt = useRef(0);
  // bumping this fetches the next question
  const [turn, setTurn] = useState(0);

  const next = useCallback(() => {
    setPhase("loading");
    setTurn((t) => t + 1);
  }, []);

  const submit = useCallback(
    async (answer: string) => {
      if (busy.current || !q) return;
      busy.current = true;
      const res = await fetch("/api/answer", {
        method: "POST",
        body: JSON.stringify({ id: q.id, answer }),
      }).catch(() => null);
      if (!res?.ok) return next(); // pending question was already settled; move on
      setResult(await res.json());
      setPhase("result");
      resultAt.current = Date.now();
      input.current?.focus();
    },
    [q, next],
  );

  // fetch the pending question (resumed with its remaining time) or a new one
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    fetchNext().then((data) => {
      if (!alive) return;
      if (data === "signed out") return window.location.reload();
      if (!data) {
        setPhase("error");
        retry = setTimeout(() => setTurn((t) => t + 1), 3000);
        return;
      }
      if (data.status === "empty") return setPhase("empty");
      busy.current = false;
      valueRef.current = "";
      setValue("");
      setResult(null);
      setQ(data);
      setPhase("question");
      input.current?.focus();
    });
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [turn]);

  // when time runs out, send whatever is typed; the server decides if it was in time
  useEffect(() => {
    if (phase !== "question" || !q) return;
    const deadline = setTimeout(() => submit(valueRef.current), q.remainingMs);
    return () => clearTimeout(deadline);
  }, [phase, q, submit]);

  if (phase === "empty") {
    return <main className="flex flex-1 items-center justify-center px-4 text-center">no questions left. come back later.</main>;
  }

  const link = "text-sm text-muted hover:text-foreground hover:underline underline-offset-4";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-4 pb-24">
      {phase === "question" && q && (
        <div
          key={q.id}
          className="fixed left-0 top-0 h-[2px] w-full origin-left bg-foreground"
          style={
            {
              "--from": q.remainingMs / game.timeLimitMs,
              animation: `shrink ${q.remainingMs}ms linear forwards`,
            } as React.CSSProperties
          }
        />
      )}

      <h1
        className="min-h-[3em] max-w-2xl select-none text-balance text-center text-2xl leading-snug sm:text-4xl"
        style={{ WebkitTouchCallout: "none" }}
        onCopy={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {phase === "error" ? "something went wrong. retrying." : phase === "loading" ? "" : (q?.question ?? "")}
      </h1>

      <form
        className="w-full max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (phase === "question" && value.trim()) submit(value);
          // ignore an Enter that was really a double-press of the answer
          else if (phase === "result" && Date.now() - resultAt.current > 400) next();
        }}
      >
        <input
          ref={input}
          autoFocus
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={phase === "result" ? "next" : "send"}
          aria-label="answer"
          maxLength={100}
          value={value}
          // readOnly instead of disabled keeps the mobile keyboard open between questions
          readOnly={phase !== "question"}
          onChange={(e) => {
            valueRef.current = e.target.value;
            setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && phase === "question") submit("");
          }}
          className="w-full border-b border-muted py-2 text-center text-xl focus:border-foreground"
        />
        <p className="mt-4 h-6 text-center text-lg tabular-nums">
          {phase === "result" && result &&
            (result.correct ? `✓ ${signed(result.delta)}` : `✗ ${result.answer} ${signed(result.delta)}`)}
        </p>
        <p className="mt-6 h-5 text-center">
          {phase === "question" && (
            <button type="button" className={link} onClick={() => submit("")}>
              give up
            </button>
          )}
          {phase === "result" && (
            <button type="button" className={link} onClick={next}>
              next
            </button>
          )}
        </p>
      </form>
    </main>
  );
}
