// Random, reasonably well-known English Wikipedia articles.
import { gen } from "./config";

const API = "https://en.wikipedia.org/w/api.php";

export type Article = { title: string; url: string; text: string; avgViews: number };

type Page = {
  pageid: number;
  title: string;
  length?: number;
  missing?: boolean;
  fullurl?: string;
  pageprops?: Record<string, string>;
  pageviews?: Record<string, number | null>;
  extract?: string;
};

async function api(params: Record<string, string>): Promise<{ query?: { pages?: Page[]; random?: { title: string }[] } }> {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": gen.userAgent } }).catch(() => null);
    if (res?.ok) return res.json();
    if (attempt >= 6) throw new Error(`Wikipedia ${res?.status ?? "network error"}`);
    // rate limited: honor Retry-After, otherwise back off exponentially
    const retryAfter = Number(res?.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// at most `limit` requests in flight, to stay polite to the API
async function inBatches<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

const BAD_TITLE = [
  /^lists? of /i,
  /^index of /i,
  /^outline of /i,
  /^timeline of /i,
  /^glossary of /i,
  /\(disambiguation\)/i,
  /^\d{1,4}( BC| AD)?$/, // bare years
  /^\d{4}s?\b.* in /, // "2003 in film", "1990s in music"
  /\bseason\b/i, // sports/TV seasons tend to be stats soup
  /\belection\b/i,
];

export type Rejections = Record<string, number>;

function avg(views: Record<string, number | null> | undefined): number {
  const vals = Object.values(views ?? {}).filter((v): v is number => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// Pull random titles and keep the ones that pass the cheap filters.
async function candidateTitles(reject: (reason: string) => void): Promise<{ title: string; avgViews: number }[]> {
  const random = await api({
    action: "query",
    list: "random",
    rnnamespace: "0",
    rnfilterredir: "nonredirects",
    rnlimit: "100",
  });
  const titles = (random.query?.random ?? []).map((r) => r.title);
  const out: { title: string; avgViews: number }[] = [];

  const chunks: string[][] = [];
  for (let i = 0; i < titles.length; i += 20) {
    const chunk = titles.slice(i, i + 20).filter((t) => {
      if (BAD_TITLE.some((re) => re.test(t))) {
        reject("title");
        return false;
      }
      return true;
    });
    if (chunk.length) chunks.push(chunk);
  }
  const infos = await inBatches(chunks, 2, (chunk) =>
    api({
      action: "query",
      titles: chunk.join("|"),
      prop: "pageprops|info|pageviews",
      ppprop: "disambiguation",
      pvipdays: "30",
    }),
  );
  for (const info of infos) {
    for (const p of info.query?.pages ?? []) {
      if (p.missing) continue;
      if (p.pageprops && "disambiguation" in p.pageprops) reject("disambiguation");
      else if ((p.length ?? 0) < gen.minArticleBytes) reject("stub");
      else {
        const v = avg(p.pageviews);
        if (v < gen.minDailyViews) reject("pageviews");
        else out.push({ title: p.title, avgViews: Math.round(v) });
      }
    }
  }
  return out;
}

// Plain text of the article body, without reference sections and headings.
async function articleText(title: string): Promise<{ text: string; url: string } | null> {
  const res = await api({
    action: "query",
    titles: title,
    prop: "extracts|info",
    inprop: "url",
    explaintext: "1",
    exsectionformat: "wiki",
  });
  const page = res.query?.pages?.[0];
  if (!page?.extract || !page.fullurl) return null;
  const cut = page.extract.search(/\n==+\s*(See also|References|Notes|External links|Further reading|Bibliography|Sources)\s*==+/i);
  const body = (cut >= 0 ? page.extract.slice(0, cut) : page.extract)
    .split("\n")
    .filter((line) => !/^==+.*==+$/.test(line.trim()))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { text: body, url: page.fullurl };
}

// Endless stream of articles that pass every filter.
export async function* articles(
  seen: Set<string>,
  reject: (reason: string) => void,
): AsyncGenerator<Article> {
  while (true) {
    let candidates: { title: string; avgViews: number }[];
    try {
      candidates = await candidateTitles(reject);
    } catch (e) {
      // a long outage or rate limit shouldn't end a multi-hour run
      console.log(`  wikipedia: ${e instanceof Error ? e.message : e}; retrying in 60s`);
      await sleep(60_000);
      continue;
    }
    for (const c of candidates) {
      if (seen.has(c.title)) {
        reject("already used");
        continue;
      }
      const a = await articleText(c.title).catch(() => null);
      if (!a || a.text.length < gen.minExtractChars) {
        reject("short text");
        continue;
      }
      yield { title: c.title, url: a.url, text: a.text.slice(0, gen.maxExtractChars), avgViews: c.avgViews };
    }
  }
}
