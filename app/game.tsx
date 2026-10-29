"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { game } from "@/lib/config";

type Question = { id: number; question: string; options: string[]; remainingMs: number };
type Result = { correct: boolean; timedOut: boolean; answer: string; delta: number };
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
  const [chosen, setChosen] = useState<string | null>(null);
  const busy = useRef(false);
  const resultAt = useRef(0);
  // bumping this fetches the next question
  const [turn, setTurn] = useState(0);

  const next = useCallback(() => {
    setPhase("loading");
    setTurn((t) => t + 1);
  }, []);

  // choice "" means give up / out of time
  const submit = useCallback(
    async (choice: string) => {
      if (busy.current || !q) return;
      busy.current = true;
      setChosen(choice);
      const res = await fetch("/api/answer", {
        method: "POST",
        body: JSON.stringify({ id: q.id, choice }),
      }).catch(() => null);
      if (!res?.ok) return next(); // pending question was already settled; move on
      setResult(await res.json());
      setPhase("result");
      resultAt.current = Date.now();
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
      setChosen(null);
      setResult(null);
      setQ(data);
      setPhase("question");
    });
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [turn]);

  // when time runs out, the answer counts as wrong; the server has the real clock
  useEffect(() => {
    if (phase !== "question" || !q) return;
    const deadline = setTimeout(() => submit(""), q.remainingMs);
    return () => clearTimeout(deadline);
  }, [phase, q, submit]);

  // keyboard: 1–4 to answer, Esc to give up, Enter / Space for the next question
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (phase === "question" && q) {
        const i = Number(e.key) - 1;
        if (i >= 0 && i < q.options.length) submit(q.options[i]);
        else if (e.key === "Escape") submit("");
      } else if (phase === "result" && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        // ignore a key that was really a double-press of the answer
        if (Date.now() - resultAt.current > 400) next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, q, submit, next]);

  if (phase === "empty") {
    return <main className="flex flex-1 items-center justify-center px-4 text-center">no questions left. come back later.</main>;
  }

  const link = "text-sm text-muted hover:text-foreground hover:underline underline-offset-4";
  const showing = phase === "question" || phase === "result";

  function optionClass(o: string) {
    if (phase !== "result" || !result) return "hover:underline underline-offset-4";
    if (o === result.answer) return "font-semibold";
    if (o === chosen) return "text-muted line-through";
    return "text-muted";
  }

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
        {phase === "error" ? "something went wrong. retrying." : showing ? q?.question : ""}
      </h1>

      <ol className="w-full max-w-sm select-none">
        {showing &&
          q?.options.map((o, i) => (
            <li key={o}>
              <button
                type="button"
                disabled={phase !== "question"}
                onClick={() => submit(o)}
                className={`flex w-full gap-4 py-2 text-left text-lg ${optionClass(o)}`}
              >
                <span className="w-4 shrink-0 text-muted tabular-nums">{i + 1}</span>
                <span>
                  {o}
                  {phase === "result" && result && o === result.answer && " ✓"}
                  {phase === "result" && result && o === chosen && !result.correct && " ✗"}
                </span>
              </button>
            </li>
          ))}
      </ol>

      <div className="flex h-12 flex-col items-center gap-2 tabular-nums">
        {phase === "result" && result && (
          <p className="text-lg">
            {result.timedOut || chosen === "" ? "✗ " : ""}
            {signed(result.delta)}
          </p>
        )}
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
      </div>
    </main>
  );
}
