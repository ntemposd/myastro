// scripts/sync-experience.ts
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';

const EXP_DB_RAW = process.env.NOTION_EXPERIENCE_DB_ID ?? process.env.NOTION_EXPERIENCE_DB ?? null;
const EXP_DS_RAW = process.env.NOTION_EXPERIENCE_DATA_SOURCE_ID ?? null;
const notion = new Client({ auth: process.env.NOTION_SECRET ?? process.env.NOTION_TOKEN });

const OUT_DIR = path.resolve('src/content/experience');

const ID32 = /[a-f0-9]{32}/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mask = (s?: string | null) => (s ? `${s.slice(0,8)}…${s.slice(-4)}` : 'none');
const plain = (rich: any[] = []) => rich.map((x: any) => x.plain_text).join('').trim();
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu,'-').replace(/(^-|-$)/g,'');
const toMs = (iso?: string | null) => (iso ? new Date(iso).getTime() : -Infinity);
async function ensureDir(p: string) { await fs.mkdir(p, { recursive: true }); }
function toHyphenated(id: string) {
  const s = id.replace(/-/g,''); return s.length===32 ? `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}` : id;
}
function extractDbLikeId(input?: string | null): string | null {
  if (!input) return null; if (UUID.test(input)) return input; const hit = input.match(ID32); return hit ? toHyphenated(hit[0]) : null;
}
async function databasesRetrieve(database_id: string) {
  const has = (notion as any)?.databases?.retrieve && typeof (notion as any).databases.retrieve==='function';
  return has ? await (notion as any).databases.retrieve({ database_id }) : await notion.request({ path: `databases/${database_id}`, method:'get' });
}
async function dataSourcesQueryAll(data_source_id: string) {
  const has = (notion as any)?.dataSources?.query && typeof (notion as any).dataSources.query==='function';
  const call = async (start_cursor?: string) => has
    ? await (notion as any).dataSources.query({ data_source_id, page_size: 100, start_cursor })
    : await notion.request({ path: `data_sources/query`, method:'post', body: { data_source_id, page_size: 100, start_cursor }});
  const results: any[] = []; let cursor: string | undefined;
  do { const resp: any = await call(cursor); results.push(...resp.results); cursor = resp.has_more ? resp.next_cursor : undefined; } while(cursor);
  return results;
}
async function databasesQueryAll(database_id: string) {
  const has = (notion as any)?.databases?.query && typeof (notion as any).databases.query==='function';
  const call = async (start_cursor?: string) => has
    ? await (notion as any).databases.query({ database_id, start_cursor })
    : await notion.request({ path: `databases/${database_id}/query`, method:'post', body: { start_cursor }});
  const results: any[] = []; let cursor: string | undefined;
  do { const resp: any = await call(cursor); results.push(...resp.results); cursor = resp.has_more ? resp.next_cursor : undefined; } while(cursor);
  return results;
}
function readTitle(props: any) { const k = Object.keys(props).find((x)=>props[x]?.type==='title'); return k ? plain(props[k].title) : ''; }

(async () => {
  if (!process.env.NOTION_SECRET && !process.env.NOTION_TOKEN) throw new Error('NOTION_SECRET/NOTION_TOKEN is missing');

  // Prefer explicit DS id; else resolve from DB; else DB query
  let src: { kind: 'ds' | 'db'; id: string } | null = null;
  if (EXP_DS_RAW) {
    const dsId = extractDbLikeId(EXP_DS_RAW); src = dsId ? { kind: 'ds', id: dsId } : null;
  } else {
    const dbId = extractDbLikeId(EXP_DB_RAW);
    if (!dbId) throw new Error('Set NOTION_EXPERIENCE_DB_ID (or NOTION_EXPERIENCE_DATA_SOURCE_ID)');
    try {
      const meta: any = await databasesRetrieve(dbId);
      const ds = Array.isArray(meta?.data_sources) ? meta.data_sources[0] : undefined;
      src = ds?.id ? { kind: 'ds', id: ds.id } : { kind: 'db', id: dbId };
    } catch (e: any) {
      if (e?.code==='invalid_request_url' || e?.status===400) src = { kind:'ds', id: dbId };
      else throw e;
    }
  }

  console.log('Experience Source:', src ? `${src.kind.toUpperCase()} ${mask(src.id)}` : 'none');
  const pages = src!.kind === 'ds' ? await dataSourcesQueryAll(src!.id) : await databasesQueryAll(src!.id);

  await ensureDir(OUT_DIR);
  const items: Array<{ slug: string, data: any, dateKey?: string | null }> = [];

  for (const r of pages) {
    if (r.object !== 'page') continue;
    const p = r.properties ?? {};
    const company = readTitle(p) || '';
    const role = p.Role?.type === 'rich_text' ? plain(p.Role.rich_text) : '';
    const start = p.Start?.type === 'date' ? (p.Start.date?.start ?? null) : null;
    const end = p.End?.type === 'date' ? (p.End.date?.end ?? p.End.date?.start ?? null) : null;
    const current = p.Current?.type === 'checkbox' ? !!p.Current.checkbox : false;
    const summary =
      p.Description?.type === 'rich_text' ? plain(p.Description.rich_text)
      : p.Summary?.type === 'rich_text' ? plain(p.Summary.rich_text)
      : undefined;
    const tags = p.Tags?.type === 'multi_select' ? p.Tags.multi_select.map((t: any) => t.name) : [];
    const location = p.Location?.type === 'rich_text' ? plain(p.Location.rich_text) : undefined;
    const url = p.URL?.type === 'url' ? p.URL.url : undefined;
    const logo =
      r.icon?.type === 'external' ? r.icon.external.url
      : r.icon?.type === 'file' ? r.icon.file.url
      : undefined;

    items.push({
      slug: slugify(`${company}-${role}`),
      data: { company, role, start, end, current, location, url, summary, tags, order: 0, logo },
      dateKey: start,
    });
  }

  // sort current first, then by start desc
  items.sort((a, b) => {
    const cur = Number(b.data.current) - Number(a.data.current);
    if (cur) return cur;
    return (toMs(b.dateKey) - toMs(a.dateKey));
  });

  // clean dir
  for (const f of await fs.readdir(OUT_DIR).catch(() => [] as string[])) {
    await fs.unlink(path.join(OUT_DIR, f)).catch(()=>{});
  }

  // write numbered json + _ordered.json
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const filename = `${String(i + 1).padStart(3, '0')}-${it.slug}.json`;
    await fs.writeFile(path.join(OUT_DIR, filename), JSON.stringify(it.data, null, 2), 'utf8');
  }
  await fs.writeFile(path.join(OUT_DIR, '_ordered.json'), JSON.stringify(items.map(x => x.data), null, 2), 'utf8');

  console.log(`✓ Experience: ${items.length} → ${OUT_DIR}`);
})().catch((e) => { console.error(e); process.exit(1); });
