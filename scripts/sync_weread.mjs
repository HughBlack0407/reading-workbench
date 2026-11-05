// Pull WeRead data through the official Agent Gateway, encrypt it locally, and
// write ONLY into data/sync/. Never touches data/notes/ (user-authored notes).
//
//   node scripts/sync_weread.mjs                 # pull, encrypt, write, commit
//   node scripts/sync_weread.mjs --push          # ... and push to GitHub
//   node scripts/sync_weread.mjs --dry-run       # pull + report, write nothing
//   node scripts/sync_weread.mjs --no-commit     # write files, skip git entirely
//
// Optional: --max-books N --max-note-books N --throttle-ms N
// Credentials: WEREAD_API_KEY env var; vault passphrase read interactively
// (or VAULT_PASSPHRASE env var for unattended runs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readPassphrase } from './passphrase.mjs';
import { openVault, encryptJSON } from './crypto.mjs';
import {
  GATEWAY, SKILL_VERSION, SYNC_DIR, NOTES_DIR, METRIC_DEFINITIONS,
  DEFAULT_MAX_BOOKS, DEFAULT_MAX_NOTE_BOOKS, DEFAULT_THROTTLE_MS,
} from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY = process.env.WEREAD_API_KEY;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);
const DRY_RUN = has('--dry-run');
const NO_COMMIT = has('--no-commit');
const PUSH = has('--push');
const MAX_BOOKS = Number(arg('--max-books', DEFAULT_MAX_BOOKS));
const MAX_NOTE_BOOKS = Number(arg('--max-note-books', DEFAULT_MAX_NOTE_BOOKS));
const THROTTLE = Number(arg('--throttle-ms', DEFAULT_THROTTLE_MS));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (unixSeconds) => {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

class UpgradeRequired extends Error {}

async function weread(apiName, extra = {}) {
  // Business parameters MUST be flattened at the top level of the body.
  const body = { api_name: apiName, skill_version: SKILL_VERSION, ...extra };
  let res;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`${apiName} 网络请求失败: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${apiName} 返回非 JSON (HTTP ${res.status})`); }

  // The official skill requires stopping immediately on upgrade_info.
  if (data.upgrade_info) {
    const msg = data.upgrade_info.message || JSON.stringify(data.upgrade_info);
    throw new UpgradeRequired(`官方要求升级 skill_version（当前 ${SKILL_VERSION}）：${msg}`);
  }
  if (!res.ok) throw new Error(`${apiName} HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (typeof data.errcode === 'number' && data.errcode !== 0) {
    throw new Error(`${apiName} errcode ${data.errcode}: ${data.errmsg || ''}`);
  }
  await sleep(THROTTLE);
  return data;
}

async function safeCall(apiName, extra, label) {
  try { return await weread(apiName, extra); }
  catch (e) {
    if (e instanceof UpgradeRequired) throw e;
    throw new Error(`${label} 获取失败，本次同步未发布：${e.message}`);
  }
}

async function collectShelf() {
  const s = await weread('/shelf/sync');
  const books = Array.isArray(s.books) ? s.books : [];
  const albums = Array.isArray(s.albums) ? s.albums : [];
  const totalCount = books.length + albums.length + (s.mp ? 1 : 0);
  const sorted = [...books].sort((a, b) => num(b.readUpdateTime) - num(a.readUpdateTime));
  const picked = sorted.slice(0, MAX_BOOKS);

  const progressMap = {};
  for (const b of picked) {
    const p = await safeCall('/book/getprogress', { bookId: b.bookId }, `进度 ${b.bookId}`);
    if (p && p.book) {
      progressMap[b.bookId] = {
        progress: p.book.progress ?? null,
        readingTimeSec: p.book.recordReadingTime ?? null,
        updateTime: iso(p.book.updateTime),
      };
    }
  }

  return {
    books: books.map((b) => ({
      bookId: b.bookId,
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
      category: b.category || '',
      readUpdateTime: iso(b.readUpdateTime),
      finishReading: b.finishReading === 1,
      isTop: Boolean(b.isTop),
      secret: b.secret === 1,
      readerLink: b.readerLink || '',
      deepLink: b.deepLink || '',
      progress: progressMap[b.bookId]?.progress ?? null,
      readingTimeSec: progressMap[b.bookId]?.readingTimeSec ?? null,
    })),
    albums: albums.map((a) => ({
      albumId: a.albumInfo?.albumId || '',
      title: a.albumInfo?.name || '',
      author: a.albumInfo?.authorName || '',
      cover: a.albumInfo?.cover || '',
      trackCount: a.albumInfo?.trackCount ?? null,
      finishStatus: a.albumInfo?.finishStatus || '',
      readUpdateTime: iso(a.albumInfoExtra?.lectureReadUpdateTime),
    })),
    hasArticleCollection: Boolean(s.mp),
    totalCount,
    recent: picked.map((b) => b.bookId),
  };
}

async function collectNotebooks() {
  const list = [];
  let lastSort;
  for (let page = 0; page < 50; page += 1) {
    const extra = { count: 100 };
    if (lastSort != null) extra.lastSort = lastSort;
    const p = await weread('/user/notebooks', extra);
    const batch = Array.isArray(p.books) ? p.books : [];
    list.push(...batch);
    if (Number(p.hasMore) !== 1) break;
    if (batch.length === 0) throw new Error('笔记本分页返回空页但仍提示更多，本次同步未发布');
    if (page === 49) throw new Error('笔记本超过 50 页，本次同步未发布');
    const last = batch[batch.length - 1];
    if (last?.sort == null || last.sort === lastSort) {
      throw new Error('笔记本分页游标无效，本次同步未发布');
    }
    lastSort = last.sort;
  }
  return list;
}

function buildNoteCounts(notebooks) {
  const breakdown = { reviewCount: 0, noteCount: 0, bookmarkCount: 0 };
  for (const b of notebooks) {
    breakdown.reviewCount += num(b.reviewCount);
    breakdown.noteCount += num(b.noteCount);
    breakdown.bookmarkCount += num(b.bookmarkCount);
  }
  return {
    noteCount: breakdown.reviewCount + breakdown.noteCount + breakdown.bookmarkCount,
    noteCountBreakdown: breakdown,
    totalBookCount: notebooks.length,
    serverTotalNoteCount: null,
  };
}

async function collectHighlights(notebooks) {
  const picked = [...notebooks]
    .sort((a, b) => num(b.sort) - num(a.sort))
    .slice(0, MAX_NOTE_BOOKS);
  const items = [];

  for (const nb of picked) {
    const bookId = nb.bookId;
    const title = nb.book?.title || '';

    const bm = await safeCall('/book/bookmarklist', { bookId }, `划线 ${bookId}`);
    if (bm) {
      const chapters = new Map(
        (Array.isArray(bm.chapters) ? bm.chapters : []).map((c) => [c.chapterUid, c.title]),
      );
      for (const u of (Array.isArray(bm.updated) ? bm.updated : [])) {
        items.push({
          id: String(u.bookmarkId || ''),
          bookId,
          bookTitle: title,
          kind: 'highlight',
          text: u.markText || '',
          note: null,
          chapter: chapters.get(u.chapterUid) || null,
          createdAt: iso(u.createTime),
          range: u.range || null,
        });
      }
    }

    // NOTE: this endpoint uses lowercase `bookid`.
    let synckey = 0;
    for (let page = 0; page < 100; page += 1) {
      const rv = await safeCall(
        '/review/list/mine',
        { bookid: bookId, count: 100, synckey },
        `想法 ${bookId}`,
      );
      for (const r of (Array.isArray(rv.reviews) ? rv.reviews : [])) {
        const x = r.review || {};
        items.push({
          id: String(x.reviewId || ''),
          bookId,
          bookTitle: title,
          kind: 'review',
          text: x.content || '',
          note: x.abstract || null,
          chapter: x.chapterName || null,
          createdAt: iso(x.createTime),
          range: x.range || null,
        });
      }
      if (Number(rv.hasMore) !== 1) break;
      if (page === 99 || rv.synckey == null || Number(rv.synckey) === Number(synckey)) {
        throw new Error(`想法 ${bookId} 分页游标无效或超过上限，本次同步未发布`);
      }
      synckey = rv.synckey;
    }
  }
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return items;
}

function periodFromReadTimes(readTimes) {
  const out = [];
  if (!readTimes || typeof readTimes !== 'object') return out;
  for (const [key, seconds] of Object.entries(readTimes)) {
    const ts = Number(key);
    if (!Number.isFinite(ts)) continue;
    out.push({ date: iso(ts)?.slice(0, 10) || '', readTimeSec: num(seconds) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function summariseReadData(r) {
  if (!r) return null;
  return {
    baseTime: iso(r.baseTime),
    totalReadTimeSec: num(r.totalReadTime),
    readDays: num(r.readDays),
    dayAverageReadTimeSec: num(r.dayAverageReadTime),
    compare: typeof r.compare === 'number' ? r.compare : null,
    byDay: periodFromReadTimes(r.readTimes),
    byBook: (Array.isArray(r.readLongest) ? r.readLongest : []).map((x) => ({
      bookId: x.book?.bookId || '',
      title: x.book?.title || x.albumInfo?.name || '',
      readTimeSec: num(x.readTime),
    })),
    readStat: (Array.isArray(r.readStat) ? r.readStat : []).map((x) => ({
      stat: x.stat || '', counts: x.counts || '',
    })),
    preferCategory: (Array.isArray(r.preferCategory) ? r.preferCategory : []).map((x) => ({
      title: x.categoryTitle || '', readingTimeSec: num(x.readingTime),
    })),
    preferTime: Array.isArray(r.preferTime) ? r.preferTime.map(num) : [],
  };
}

async function collectStats() {
  const monthly = await safeCall('/readdata/detail', { mode: 'monthly' }, '本月统计');
  const overall = await safeCall('/readdata/detail', { mode: 'overall' }, '累计统计');
  return { monthly: summariseReadData(monthly), overall: summariseReadData(overall) };
}

function assertSyncPath(rel) {
  if (!rel.startsWith(`${SYNC_DIR}/`)) {
    throw new Error(`Blocked write outside ${SYNC_DIR}/: ${rel}`);
  }
  if (rel.startsWith(`${NOTES_DIR}/`)) throw new Error('Blocked write into user notes');
}

function writeSync(name, value) {
  const rel = `${SYNC_DIR}/${name}`;
  assertSyncPath(rel);
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(value) + '\n', 'utf8');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function main() {
  if (!API_KEY && !DRY_RUN) throw new Error('缺少环境变量 WEREAD_API_KEY');
  if (!API_KEY && DRY_RUN) throw new Error('--dry-run 仍需要 WEREAD_API_KEY 才能验证接口');
  const metaPath = path.join(ROOT, 'vault.meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error('未找到 vault.meta.json，请先运行：node scripts/init_vault.mjs');
  }
  const vault = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const passphrase = await readPassphrase('Vault passphrase: ');
  const { key, salt } = openVault(vault, passphrase);

  console.log(`拉取微信读书数据（skill_version ${SKILL_VERSION}）...`);
  const shelf = await collectShelf();
  const notebooks = await collectNotebooks();
  const counts = buildNoteCounts(notebooks);
  const highlights = await collectHighlights(notebooks);
  const stats = await collectStats();
  const syncedAt = new Date().toISOString();

  const payload = {
    shelf: {
      schema: 1, type: 'shelf', syncedAt, source: 'weread-agent-gateway',
      ...shelf,
    },
    highlights: {
      schema: 1, type: 'highlights', syncedAt, source: 'weread-agent-gateway',
      items: highlights,
    },
    stats: {
      schema: 1, type: 'stats', syncedAt, source: 'weread-agent-gateway',
      ...counts, ...stats, metricDefinitions: METRIC_DEFINITIONS,
    },
    meta: {
      schema: 1, type: 'sync-meta', syncedAt,
      skillVersion: SKILL_VERSION,
      metricDefinitions: METRIC_DEFINITIONS,
      counts: {
        shelfBooks: shelf.books.length,
        shelfAlbums: shelf.albums.length,
        shelfTotal: shelf.totalCount,
        notebookBooks: notebooks.length,
        highlightItems: highlights.length,
      },
    },
  };

  if (DRY_RUN) {
    console.log('DRY RUN — 未写入任何文件。');
    console.log(JSON.stringify(payload.meta.counts, null, 2));
    console.log(`统计口径校验：noteCount = ${counts.noteCount} = ${counts.noteCountBreakdown.reviewCount} + ${counts.noteCountBreakdown.noteCount} + ${counts.noteCountBreakdown.bookmarkCount}`);
    console.log(`本月 totalReadTime = ${stats.monthly?.totalReadTimeSec ?? 'N/A'} 秒`);
    return;
  }

  writeSync('shelf.enc', encryptJSON(payload.shelf, key, salt));
  writeSync('highlights.enc', encryptJSON(payload.highlights, key, salt));
  writeSync('stats.enc', encryptJSON(payload.stats, key, salt));
  writeSync('meta.enc', encryptJSON(payload.meta, key, salt));
  writeSync('manifest.json', {
    schemaVersion: 1,
    syncedAt,
    files: ['shelf.enc', 'highlights.enc', 'stats.enc', 'meta.enc'],
  });

  console.log(`已写入 ${SYNC_DIR}/ 下的 4 个密文文件与 manifest.json。`);
  console.log(`  ${counts.noteCount} 条笔记（${counts.noteCountBreakdown.reviewCount}+${counts.noteCountBreakdown.noteCount}+${counts.noteCountBreakdown.bookmarkCount}）`);
  console.log(`  本月阅读 ${stats.monthly?.totalReadTimeSec ?? 0} 秒（取自 totalReadTime）`);
  console.log(`  书架 ${shelf.totalCount} 个条目，划线/想法 ${highlights.length} 条`);

  if (NO_COMMIT) { console.log('--no-commit：未执行任何 git 操作。'); return; }
  const changed = git(['status', '--porcelain', '--', SYNC_DIR]);
  if (!changed) { console.log('数据无变化，跳过 commit。'); return; }
  git(['add', '--', SYNC_DIR]);
  git(['commit', '-m', 'sync: update data']);
  console.log('已提交：sync: update data');
  if (PUSH) { git(['push']); console.log('已推送到远端。'); }
  else console.log('未推送。需要上线时加 --push。');
}

main().catch((e) => {
  if (e instanceof UpgradeRequired) {
    console.error(`\n[暂停] ${e.message}`);
    console.error('请按官方指引升级 weread-skills，更新 scripts/config.mjs 的 SKILL_VERSION，然后重新运行。');
    process.exit(2);
  }
  console.error(`\n同步失败：${e.message}`);
  process.exit(1);
});
