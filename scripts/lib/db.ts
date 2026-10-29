// Service-role Supabase client for the local scripts. Never import this from app code.
import { createClient } from "@supabase/supabase-js";
import "./config";

export function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || url.includes("your-project") || key === "replace-me") {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local to your project's values\n" +
        "(Supabase dashboard → Project Settings → API). Or try without a database: add --dry-run",
    );
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;

// The API returns at most 1,000 rows per request; read everything page by page.
// `page(from, to)` must build the query and end with .range(from, to).
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
