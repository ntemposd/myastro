// scripts/sync-projects.ts  — downloads project images into src/assets/projects
// and writes frontmatter .md files into src/content/projects (with `order`)
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';

const PROJ_DB_RAW = process.env.NOTION_PROJECTS_DB_ID ?? null;
const notion = new Client({ auth: process.env.NOTION_SECRET ?? process.env.NOTION_TOKEN });

const PROJECTS_OUT = path.resolve('src/content/projects');
const ASSETS_DIR   = path.resolve('src/assets/projects');

// Optional: keep specific files
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
async function dataSourcesQueryAll(data_source_id: string) {
  const has = (notion as any)?.dataSources?.query && typeof (notion as any).dataSources.query==='function';
  const call = async (start_cursor?: string) =>
    has
      ? await (notion as any).dataSources.query({ data_source_id, page_size: 100, start_cursor })
      : await notion.request({ path: `data_sources/query`, method:'post', body: { data_source_id, page_size: 100, start_cursor }});
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

// ---------- pick URL from Notion ----------
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

// ---------- download ANY url into src/assets/projects ----------
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

// ---------- main ----------
(async () => {
  if (!process.env.NOTION_SECRET && !process.env.NOTION_TOKEN) {
    console.error('NOTION_SECRET/NOTION_TOKEN is missing');
    process.exit(1);
  }
  const src = await resolveDbOrDs(PROJ_DB_RAW);
  console.log('Projects Source:', src ? `${src.kind.toUpperCase()} ${mask(src.id)}` : 'none');
  if (!src) { console.error('Set NOTION_PROJECTS_DB_ID'); process.exit(1); }

  const isActive = (page: any) => !(page.properties?.Draft?.type === 'checkbox' && page.properties.Draft.checkbox);

  const pages = src.kind === 'ds'
    ? (await dataSourcesQueryAll(src.id)).filter(isActive)
    : (await databasesQueryAll(src.id, { /* optional server filter */ })).filter(isActive);

  await ensureDir(PROJECTS_OUT);
  await ensureDir(ASSETS_DIR);

  // HARD CLEAN content: remove all .md/.mdx except protected
  const existing = await fs.readdir(PROJECTS_OUT).catch(() => [] as string[]);
  let removed = 0;
  for (const f of existing) {
    const lower = f.toLowerCase();
    if ((lower.endsWith('.md') || lower.endsWith('.mdx')) && !PROTECTED.has(f)) {
      await fs.unlink(path.join(PROJECTS_OUT, f)).catch(()=>{});
      removed++;
    }
  }
  console.log(`Cleaned projects content: removed ${removed} old file(s).`);

  // Build items + track which asset files to keep
  type Item = {
    slug: string;
    data: {
      title: string;
      blurb: string;
      tags: string[];
      link: string;
      image?: string;
      order: number;
      draft: boolean;
      notionId: string;
    };
  };
  const items: Item[] = [];
  const keepAssets = new Set<string>();

  for (const page of pages) {
    const p = page.properties ?? {};
    const title = readTitle(p) || '(Untitled)';
    const slugProp = p.Slug?.type === 'rich_text' ? plain(p.Slug.rich_text) : '';
    const slug = slugProp || slugify(title);

    const blurb =
      p.Blurb?.type === 'rich_text' ? plain(p.Blurb.rich_text)
      : p.Description?.type === 'rich_text' ? plain(p.Description.rich_text)
      : '';

    const tags = p.Tags?.type === 'multi_select' ? p.Tags.multi_select.map((t: any) => t.name) : [];

    const link =
      p.Link?.type === 'url' && p.Link.url ? p.Link.url
      : p.URL?.type === 'url' && p.URL.url ? p.URL.url
      : '';

    const rawUrl = getImagePropUrl(p) ?? getCoverUrl(page);
    let imageFile: string | undefined;
    if (rawUrl) {
      imageFile = await downloadToAssets(rawUrl, slug);           // -> src/assets/projects/<slug>.<ext>
      keepAssets.add(imageFile);
    }

    const order = p.Order?.type === 'number' && typeof p.Order.number === 'number' ? p.Order.number : 0;
    const draft = p.Draft?.type === 'checkbox' ? !!p.Draft.checkbox : false;

    items.push({
      slug,
      data: {
        title,
        blurb,
        tags,
        link,
        image: imageFile ? `/projects/${imageFile}` : undefined,   // frontmatter hint; page resolves by basename
        order,                                                      // << include order in frontmatter
        draft,
        notionId: page.id,
      },
    });
  }

  // PRUNE ASSETS not referenced
  const assetFiles = await fs.readdir(ASSETS_DIR).catch(() => [] as string[]);
  let removedAssets = 0;
  for (const f of assetFiles) {
    if (!keepAssets.has(f)) {
      await fs.unlink(path.join(ASSETS_DIR, f)).catch(()=>{});
      removedAssets++;
    }
  }
  if (removedAssets) console.log(`Pruned project assets: removed ${removedAssets} file(s).`);

  // WRITE frontmatter-only MD (low order first to match your page sorting)
  for (const it of items.sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0))) {
    const file = path.join(PROJECTS_OUT, `${it.slug}.md`);
    await fs.writeFile(file, fm(it.data) + '\n', 'utf8');
    console.log('✓ Project:', file);
  }

  console.log(`✓ Projects: ${items.length} → ${PROJECTS_OUT}  (assets in ${ASSETS_DIR})`);
})().catch((e) => { console.error(e); process.exit(1); });
