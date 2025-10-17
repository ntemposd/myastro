// scripts/sync-posts.ts — Notion → src/content/posts + downloads images to src/assets/posts
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';

const POSTS_DB_RAW = process.env.NOTION_POSTS_DB_ID ?? null;
const POST_DATE_PROP = process.env.NOTION_POSTS_DATE_PROP ?? 'Date';
const STRICT_DATE = (process.env.NOTION_POSTS_STRICT_DATE ?? 'true').toLowerCase() !== 'false';

const notion = new Client({ auth: process.env.NOTION_SECRET ?? process.env.NOTION_TOKEN });

const POSTS_OUT  = path.resolve('src/content/posts');
const ASSETS_DIR = path.resolve('src/assets/posts');

// Optional: keep some files in content (never delete)
const PROTECTED = new Set<string>(['_README.md']);

// ---------- utils ----------
const ID32 = /[a-f0-9]{32}/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mask = (s?: string | null) => (s ? `${s.slice(0,8)}…${s.slice(-4)}` : 'none');
const plain = (rich: any[] = []) => rich.map((x: any) => x.plain_text).join('').trim();
const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu,'-').replace(/(^-|-$)/g,'');

async function ensureDir(p: string) { await fs.mkdir(p, { recursive: true }); }
function fm(obj: Record<string, any>) {
  const yaml = Object.entries(obj).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.map((x)=>JSON.stringify(x)).join(', ')}]`
    : v === null || v === undefined ? `${k}:`
    : `${k}: ${JSON.stringify(v)}`
  ).join('\n');
  return `---\n${yaml}\n---\n`;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g,'');

function toHyphenated(id: string) {
  const s = id.replace(/-/g,'');
  return s.length===32 ? `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}` : id;
}
function extractDbLikeId(input?: string | null): string | null {
  if (!input) return null;
  if (UUID.test(input)) return input;
  const hit = input.match(ID32);
  return hit ? toHyphenated(hit[0]) : null;
}
function readTitle(props: any) {
  const k = Object.keys(props).find((x)=>props[x]?.type==='title');
  return k ? plain(props[k].title) : '';
}

// ---------- Notion wrappers ----------
async function databasesQueryAll(database_id: string, body: any = {}) {
  const hasSdk = (notion as any)?.databases?.query && typeof (notion as any).databases.query === 'function';
  const call = async (start_cursor?: string) =>
    hasSdk
      ? await (notion as any).databases.query({ database_id, start_cursor, ...body })
      : await notion.request({ path: `databases/${database_id}/query`, method:'post', body: { start_cursor, ...body }});
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await call(cursor);
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}
async function dataSourcesQueryAll(data_source_id: string, body: any = {}) {
  const has = (notion as any)?.dataSources?.query && typeof (notion as any).dataSources.query === 'function';
  const call = async (start_cursor?: string) =>
    has
      ? await (notion as any).dataSources.query({ data_source_id, page_size: 100, start_cursor, ...body })
      : await notion.request({ path: `data_sources/query`, method:'post', body: { data_source_id, page_size: 100, start_cursor, ...body }});
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await call(cursor);
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}
async function databasesRetrieve(database_id: string) {
  const has = (notion as any)?.databases?.retrieve && typeof (notion as any).databases.retrieve==='function';
  return has
    ? await (notion as any).databases.retrieve({ database_id })
    : await notion.request({ path: `databases/${database_id}`, method:'get' });
}
async function resolveDbOrDs(raw: string | null): Promise<{ kind: 'ds' | 'db'; id: string } | null> {
  if (!raw) return null;
  const candidate = extractDbLikeId(raw);
  if (!candidate) return null;
  try {
    const meta: any = await databasesRetrieve(candidate);
    const ds = Array.isArray(meta?.data_sources) ? meta.data_sources[0] : undefined;
    return ds?.id ? { kind:'ds', id: ds.id } : { kind:'db', id: candidate };
  } catch (e: any) {
    if (e?.code==='invalid_request_url' || e?.status===400) return { kind:'ds', id: candidate };
    throw e;
  }
}

// ---------- image helpers ----------
function getCoverUrl(page: any): string | undefined {
  const c = page?.cover;
  if (!c) return undefined;
  if (c.type === 'external') return c.external?.url;
  if (c.type === 'file') return c.file?.url; // signed; we’ll download anyway
  return undefined;
}
function getImagePropUrl(props: any): string | undefined {
  if (props.Image?.type === 'url' && props.Image.url) return props.Image.url;
  if (props.Image?.type === 'files' && Array.isArray(props.Image.files) && props.Image.files.length) {
    const f = props.Image.files[0];
    if (f?.type === 'external') return f.external.url;
    if (f?.type === 'file') return f.file.url; // signed; we’ll download anyway
  }
  return undefined;
}
function extFromContentType(ct?: string | null) {
  if (!ct) return '';
  if (ct.includes('jpeg')) return 'jpg';
  if (ct.includes('png'))  return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('svg'))  return 'svg';
  if (ct.includes('gif'))  return 'gif';
  return '';
}
function extFromUrl(url: string) {
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp|avif|svg|gif)$/i);
  return m ? m[1].toLowerCase().replace('jpeg','jpg') : '';
}
async function downloadToAssets(url: string, filenameBase: string) {
  await ensureDir(ASSETS_DIR);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = extFromContentType(res.headers.get('content-type')) || extFromUrl(url) || 'bin';
  const file = `${filenameBase}.${ext}`;
  await fs.writeFile(path.join(ASSETS_DIR, file), buf);
  return file; // filename only
}

// ---------- Markdown inline image rewriting ----------
function collectImageUrlsFromMarkdown(md: string): string[] {
  const urls = new Set<string>();
  // ![alt](url) and <img src="url">
  const reMd = /!\[[^\]]*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const reHtml = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = reMd.exec(md))) urls.add(m[1]);
  while ((m = reHtml.exec(md))) urls.add(m[1]);
  return [...urls];
}
function replaceMarkdownUrls(md: string, mapping: Record<string, string>): string {
  let out = md;
  for (const [from, to] of Object.entries(mapping)) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'g'), to);
  }
  return out;
}

// ---------- date picking (strict) ----------
function pickPostDateStrict(props: any, page: any, title: string) {
  const targets = [POST_DATE_PROP, 'PublishDate', 'Publish Date', 'PublishedAt', 'Published At', 'Date', 'date'];
  const want = new Set(targets.map(norm));
  const exactKey = Object.keys(props).find((k) => want.has(norm(k)));
  const pref = exactKey ? props[exactKey] : undefined;
  if (pref?.type === 'date' && pref.date?.start) return pref.date.start.slice(0, 10);
  const anyKey = Object.keys(props).find((k) => props[k]?.type === 'date' && props[k].date?.start);
  if (anyKey) return props[anyKey].date.start.slice(0, 10);
  if (STRICT_DATE) throw new Error(`Post "${title}" missing a filled date (${targets.join(', ')}).`);
  return (page.created_time ?? new Date().toISOString()).slice(0, 10);
}

// ---------- main ----------
(async () => {
  if (!process.env.NOTION_SECRET && !process.env.NOTION_TOKEN) {
    console.error('NOTION_SECRET/NOTION_TOKEN is missing'); process.exit(1);
  }
  const src = await resolveDbOrDs(POSTS_DB_RAW);
  console.log('Posts Source:', src ? `${src.kind.toUpperCase()} ${mask(src.id)}` : 'none');
  if (!src) { console.error('Set NOTION_POSTS_DB_ID'); process.exit(1); }

  const isPublished = (page: any) => {
    const props = page.properties ?? {};
    const pub = props.Published?.type === 'checkbox' ? !!props.Published.checkbox : false;
    const status =
      props.Status?.type === 'select'
        ? String(props.Status.select?.name || '').toLowerCase() === 'published'
        : false;
    return pub || status;
  };

  // fetch pages
  let pages: any[] = [];
  if (src.kind === 'ds') pages = (await dataSourcesQueryAll(src.id)).filter(isPublished);
  else pages = await databasesQueryAll(src.id, {
    filter: { or: [{ property: 'Published', checkbox: { equals: true } }, { property: 'Status', select: { equals: 'Published' } }] }
  });

  await ensureDir(POSTS_OUT);
  await ensureDir(ASSETS_DIR);

  // HARD CLEAN content: remove all .md/.mdx except protected
  const existing = await fs.readdir(POSTS_OUT).catch(() => [] as string[]);
  let removed = 0;
  for (const f of existing) {
    const lower = f.toLowerCase();
    if ((lower.endsWith('.md') || lower.endsWith('.mdx')) && !PROTECTED.has(f)) {
      await fs.unlink(path.join(POSTS_OUT, f)).catch(()=>{});
      removed++;
    }
  }
  console.log(`Cleaned posts content: removed ${removed} old file(s).`);

  type Item = {
    id: string;
    slug: string;
    title: string;
    date: string;       // YYYY-MM-DD
    excerpt?: string;
    tags: string[];
    image?: string;     // /posts/filename.ext (cover)
    md: string;         // rewritten markdown
  };

  const n2m = new NotionToMarkdown({ notionClient: notion });
  const items: Item[] = [];

  for (const p of pages) {
    const props = p.properties ?? {};
    const title = readTitle(props) || '(Untitled)';
    const slugProp = props.Slug?.type === 'rich_text' ? plain(props.Slug.rich_text) : '';
    const slug = slugProp || slugify(title);
    const excerpt = props.Excerpt?.type === 'rich_text' ? plain(props.Excerpt.rich_text) : undefined;
    const tags = props.Tags?.type === 'multi_select' ? props.Tags.multi_select.map((x: any) => x.name) : [];
    const date = pickPostDateStrict(props, p, title);

    // cover/image property → src/assets/posts/<slug>.<ext>
    const imgProp = getImagePropUrl(props);
    const coverRaw = getCoverUrl(p);
    const raw = imgProp ?? coverRaw;
    let coverFile: string | undefined;
    if (raw) coverFile = await downloadToAssets(raw, slug); // filename only

    // page content → markdown
    const blocks = await n2m.pageToMarkdown(p.id);
    const mdObj: any = n2m.toMarkdownString(blocks);
    let md = typeof mdObj === 'string' ? mdObj : mdObj?.parent ?? '';

    // inline images in MD → download & rewrite
    const inlineUrls = collectImageUrlsFromMarkdown(md);
    const rewriteMap: Record<string, string> = {};
    let imgIndex = 1;
    for (const u of inlineUrls) {
      if (!/^https?:\/\//i.test(u)) continue; // already local or relative
      const file = await downloadToAssets(u, `${slug}-img${imgIndex++}`);
      rewriteMap[u] = `/posts/${file}`;
    }
    if (Object.keys(rewriteMap).length) {
      md = replaceMarkdownUrls(md, rewriteMap);
    }

    items.push({
      id: p.id,
      slug,
      title,
      date,
      excerpt,
      tags,
      image: coverFile ? `/posts/${coverFile}` : undefined,
      md,
    });
  }

  // PRUNE ASSETS not referenced (keep cover files + inline files we just downloaded)
  const keepAssets = new Set<string>();
  for (const it of items) {
    if (it.image) keepAssets.add(path.basename(it.image));
    // collect inline asset filenames from rewritten MD
    const urls = collectImageUrlsFromMarkdown(it.md);
    for (const u of urls) {
      if (u.startsWith('/posts/')) keepAssets.add(path.basename(u));
    }
  }
  const assetFiles = await fs.readdir(ASSETS_DIR).catch(() => [] as string[]);
  let removedAssets = 0;
  for (const f of assetFiles) {
    if (!keepAssets.has(f)) {
      await fs.unlink(path.join(ASSETS_DIR, f)).catch(()=>{});
      removedAssets++;
    }
  }
  if (removedAssets) console.log(`Pruned post assets: removed ${removedAssets} file(s).`);

  // write markdown files (newest first)
  for (const it of items.sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const fmData: Record<string, any> = {
      title: it.title,
      date: it.date,                 // "YYYY-MM-DD"
      excerpt: it.excerpt,
      tags: it.tags,
      draft: false,
      notionId: it.id,
    };
    if (it.image) fmData.image = it.image;

    const file = path.join(POSTS_OUT, `${it.slug}.md`);
    await fs.writeFile(file, fm(fmData) + '\n' + it.md + '\n', 'utf8');
    console.log('✓ Post:', file);
  }

  console.log(`✓ Posts: ${items.length} → ${POSTS_OUT}  (assets in ${ASSETS_DIR})`);
})().catch((e) => { console.error(e); process.exit(1); });
