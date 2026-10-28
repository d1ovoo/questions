// Wikipedia's Vital articles (~50,000 important topics), most viewed first.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gen } from "./config";

const API = "https://en.wikipedia.org/w/api.php";

export type Article = { title: string; url: string; text: string; avgViews: number; topic: string };
type Entry = { title: string; views: number; topic: string };

type Page = {
  title: string;
  length?: number;
  missing?: boolean;
  fullurl?: string;
  pageprops?: Record<string, string>;
  pageviews?: Record<string, number | null>;
  extract?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": gen.userAgent } }).catch(() => null);
    if (res?.ok) return res;
    if (attempt >= 6) throw new Error(`Wikipedia ${res?.status ?? "network error"}`);
    // rate limited: honor Retry-After, otherwise back off exponentially
    const retryAfter = Number(res?.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
  }
}

async function api(params: Record<string, string>): Promise<{ query?: { pages?: Page[] } }> {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  return (await get(url)).json();
}

// at most `limit` requests in flight, to stay polite to the API
async function inBatches<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map((t, j) => fn(t, i + j)))));
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
];

function avg(views: Record<string, number | null> | undefined): number {
  const vals = Object.values(views ?? {}).filter((v): v is number => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// Download the Vital articles data pages, look up pageviews and size, sort by views.
async function buildList(): Promise<Entry[]> {
  const pages = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "others"];
  const topics = new Map<string, string>();
  await inBatches(pages, 2, async (p) => {
    const raw = await get(`https://en.wikipedia.org/w/index.php?title=Wikipedia:Vital_articles/data/${p}.json&action=raw`);
    const data = (await raw.json()) as Record<string, { topic?: string }>;
    for (const [title, v] of Object.entries(data)) {
      if (!BAD_TITLE.some((re) => re.test(title))) topics.set(title, v.topic ?? "");
    }
  });
  console.log(`vital articles: ${topics.size} titles, fetching pageviews (one-time, a few minutes)…`);

  const titles = [...topics.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));

  const entries = new Map<string, Entry>();
  await inBatches(chunks, 2, async (chunk, i) => {
    const res = (await api({
      action: "query",
      titles: chunk.join("|"),
      redirects: "1",
      prop: "pageviews|info|pageprops",
      ppprop: "disambiguation",
      pvipdays: "30",
    })) as { query?: { pages?: Page[]; redirects?: { from: string; to: string }[] } };
    const from = new Map((res.query?.redirects ?? []).map((r) => [r.to, r.from]));
    for (const p of res.query?.pages ?? []) {
      if (p.missing || (p.pageprops && "disambiguation" in p.pageprops)) continue;
      if ((p.length ?? 0) < gen.minArticleBytes) continue;
      const topic = topics.get(p.title) ?? topics.get(from.get(p.title) ?? "") ?? "";
      entries.set(p.title, { title: p.title, views: Math.round(avg(p.pageviews)), topic });
    }
    if (i % 100 === 0) process.stdout.write(`  ${i}/${chunks.length}\r`);
  });

  return [...entries.values()].sort((a, b) => b.views - a.views);
}

export async function vitalList(refresh = false): Promise<Entry[]> {
  if (!refresh && existsSync(gen.listFile)) return JSON.parse(readFileSync(gen.listFile, "utf8"));
  const list = await buildList();
  writeFileSync(gen.listFile, JSON.stringify(list));
  console.log(`saved ${list.length} articles to ${gen.listFile}`);
  return list;
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

// end the excerpt on a sentence boundary
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = cut.lastIndexOf(". ");
  return end > max * 0.6 ? cut.slice(0, end + 1) : cut;
}

// Topics take turns (history, science, sport, …), each in order of popularity, so the
// most-viewed celebrities don't crowd everything else out.
function byTopic(list: Entry[]): Entry[] {
  const groups = new Map<string, Entry[]>();
  for (const e of list) groups.set(e.topic, [...(groups.get(e.topic) ?? []), e]);
  const queues = [...groups.values()];
  const out: Entry[] = [];
  for (let i = 0; out.length < list.length; i++) {
    for (const q of queues) if (q[i]) out.push(q[i]);
  }
  return out;
}

// Unused articles, topics interleaved. Safe to share between concurrent workers.
export async function* articles(
  list: Entry[],
  seen: Set<string>,
  reject: (reason: string) => void,
): AsyncGenerator<Article> {
  const queue = byTopic(list.filter((e) => !seen.has(e.title) && e.views >= gen.minDailyViews));
  for (const e of queue) {
    if (seen.has(e.title)) continue;
    const a = await articleText(e.title).catch(() => null);
    if (!a || a.text.length < gen.minExtractChars) {
      reject("wiki: short text");
      continue;
    }
    yield { title: e.title, url: a.url, text: excerpt(a.text, gen.maxExtractChars), avgViews: e.views, topic: e.topic };
  }
}
