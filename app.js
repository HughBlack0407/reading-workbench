import {
  openVault, encryptJSON, decryptJSON, b64encode, b64decode,
} from './crypto-web.js';

const $ = (id) => document.getElementById(id);
const FILES = {
  shelf: 'data/sync/shelf.enc',
  highlights: 'data/sync/highlights.enc',
  stats: 'data/sync/stats.enc',
  meta: 'data/sync/meta.enc',
  notes: 'data/notes/notes.enc',
};
const LS = { config: 'rw.config', pat: 'rw.pat', draft: 'rw.draft' };
const DEFAULT_CONFIG = { owner: '', repo: '', branch: 'main' };

const state = {
  vault: null,
  key: null,
  salt: null,
  config: { ...DEFAULT_CONFIG },
  pat: null,
  readOnly: true,
  fallback: false,
  data: {},
  sha: {},
  view: 'shelf',
  selectedNoteId: null,
  editMode: 'view',
  dirty: false,
  conflict: false,
  search: '',
  status: '',
  draftRevision: 0,
  saving: false,
};

/* ---------- small helpers ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
const pad = (n) => String(n).padStart(2, '0');
function dateParts(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatDate(v) {
  const d = dateParts(v);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '—';
}
function formatDateTime(v) {
  const d = dateParts(v);
  return d ? `${formatDate(v)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—';
}
function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '—';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}
function setStatus(text) { state.status = text; $('save-state').textContent = text; }
function setGateMsg(text) { $('gate-msg').textContent = text; }
function sectionTitle(title, note) {
  const f = document.createDocumentFragment();
  f.appendChild(el('h2', null, title));
  f.appendChild(el('p', 'section-note', note));
  return f;
}
function empty(text) { return el('div', 'empty', text); }
function metricCard(value, label, source, syncedAt) {
  const c = el('div', 'card');
  c.appendChild(el('div', 'metric-label', label));
  c.appendChild(el('div', 'metric', value));
  c.appendChild(el('span', 'source', source));
  if (syncedAt) c.appendChild(el('span', 'source', `同步于 ${formatDateTime(syncedAt)}`));
  return c;
}
const b64ToString = (s) => new TextDecoder().decode(b64decode(s));
const stringToB64 = (s) => b64encode(new TextEncoder().encode(s));

/* ---------- local storage ---------- */
function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(LS.config) || '{}') }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(c) { localStorage.setItem(LS.config, JSON.stringify(c)); }
async function loadPat() {
  const raw = localStorage.getItem(LS.pat);
  if (!raw || !state.key) return null;
  try { return (await decryptJSON(JSON.parse(raw), state.key)).pat || null; }
  catch { return null; }
}
async function storePat(pat) {
  if (!pat) { localStorage.removeItem(LS.pat); state.pat = null; return; }
  const env = await encryptJSON({ pat }, state.key, state.salt);
  localStorage.setItem(LS.pat, JSON.stringify(env));
  state.pat = pat;
}

/* ---------- GitHub contents API ---------- */
function apiBase() {
  const c = state.config;
  return `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents`;
}
function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (state.pat) h.Authorization = `Bearer ${state.pat}`;
  return h;
}
async function ghError(r) {
  const map = {
    401: '令牌失效，请在设置中更换 PAT',
    403: '权限不足或已限流，确认 PAT 的 Contents 为 Read and write',
    404: '文件不存在',
    422: '请求被拒绝，文件可能已在别处创建',
  };
  if (r.status === 429 || r.status === 403) {
    const reset = r.headers.get('X-RateLimit-Reset');
    if (reset) {
      const t = new Date(Number(reset) * 1000);
      return new Error(`${map[r.status] || '请求受限'}，配额重置 ${formatDateTime(t)}`);
    }
  }
  return new Error(map[r.status] || `GitHub API HTTP ${r.status}`);
}
async function readSameOrigin(path) {
  try {
    const r = await fetch(`./${path}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`同域读取失败 HTTP ${r.status}`);
    return { sha: null, text: await r.text(), fallback: true };
  } catch (e) {
    throw new Error(`${e.message}。请检查仓库地址，或在设置中配置只读令牌。`);
  }
}
async function readDataFile(path) {
  const url = `${apiBase()}/${path}?ref=${encodeURIComponent(state.config.branch)}`;
  let r;
  try {
    r = await fetch(url, { headers: ghHeaders(), credentials: 'omit', cache: 'no-store' });
  } catch { return readSameOrigin(path); }
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 429) {
    if (!state.pat) return readSameOrigin(path);
    throw await ghError(r);
  }
  if (!r.ok) throw await ghError(r);
  const j = await r.json();
  return { sha: j.sha, text: b64ToString(j.content), fallback: false };
}
async function writeDataFile(path, text, sha) {
  const body = {
    message: 'notes: update',
    content: stringToB64(text),
    branch: state.config.branch,
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${apiBase()}/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  if (r.status === 409) return { conflict: true };
  if (!r.ok) throw await ghError(r);
  const j = await r.json();
  return { conflict: false, sha: j.content.sha };
}

/* ---------- boot / unlock ---------- */
function bindStaticEvents() {
  $('gate-unlock').addEventListener('click', unlock);
  $('gate-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('gate-toggle-config').addEventListener('click', () => {
    $('gate-config').classList.toggle('hidden');
  });
  $('btn-lock').addEventListener('click', lock);
  $('btn-reload').addEventListener('click', async () => {
    try {
      commitEditor();
      if (state.dirty) {
        download(`reading-local-draft-${formatDate(new Date())}.json`,
          JSON.stringify({ exportedAt: new Date().toISOString(), notes: state.data.notes }, null, 2));
      }
      state.draftRevision += 1;
      localStorage.removeItem(LS.draft);
      await loadData();
      state.conflict = false;
      state.dirty = false;
      state.editMode = 'view';
      setStatus('已重新加载云端内容');
      render();
    } catch (e) { setStatus(`重新加载失败：${e.message}`); }
  });
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => {
      commitEditor();
      state.view = btn.dataset.view;
      render();
    });
  }
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
      e.preventDefault();
      if (!state.readOnly && state.editMode === 'edit') saveNotes();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

async function boot() {
  bindStaticEvents();
  try {
    const r = await fetch('./vault.meta.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('未找到 vault.meta.json。请先在电脑上运行 init_vault.mjs 并提交该文件。');
    state.vault = await r.json();
  } catch {
    $('boot').classList.add('hidden');
    $('setup').classList.remove('hidden');
    return;
  }
  state.config = loadConfig();
  $('cfg-owner').value = state.config.owner;
  $('cfg-repo').value = state.config.repo;
  $('cfg-branch').value = state.config.branch;
  if (!state.config.owner || !state.config.repo) $('gate-config').classList.remove('hidden');
  $('boot').classList.add('hidden');
  $('gate').classList.remove('hidden');
}

async function unlock() {
  const btn = $('gate-unlock');
  btn.disabled = true;
  setGateMsg('正在派生密钥…');
  // Let the browser paint the message before the 600k-iteration KDF blocks.
  await new Promise((r) => setTimeout(r, 30));
  try {
    const pass = $('gate-pass').value;
    const { key, salt } = await openVault(state.vault, pass);
    state.key = key;
    state.salt = salt;

    const c = {
      owner: $('cfg-owner').value.trim(),
      repo: $('cfg-repo').value.trim(),
      branch: $('cfg-branch').value.trim() || 'main',
    };
    if (!c.owner || !c.repo) throw new Error('请先填写仓库所有者与仓库名');
    state.config = c;
    saveConfig(c);

    state.pat = await loadPat();
    state.readOnly = !state.pat;
    state.fallback = false;
    await loadData();

    $('gate-pass').value = '';
    setGateMsg('');
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    if (!state.dirty && !state.conflict) setStatus(state.readOnly ? '只读模式' : '可编辑');
    render();
  } catch (e) {
    setGateMsg(e.message.includes('mismatch') ? '口令无法解密，请重试' : e.message);
    state.key = null;
    state.salt = null;
  } finally { btn.disabled = false; }
}

function lock() {
  clear($('main'));
  state.key = null; state.salt = null; state.pat = null;
  state.data = {}; state.sha = {}; state.readOnly = true;
  state.dirty = false; state.conflict = false; state.editMode = 'view';
  state.selectedNoteId = null; state.view = 'shelf'; state.status = '';
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('gate-pass').value = '';
}

async function loadData() {
  const keys = Object.keys(FILES);
  state.fallback = false;
  state.conflict = false;
  state.dirty = false;
  for (let i = 0; i < keys.length; i += 1) {
    setStatus(`正在读取仓库数据… ${i + 1}/${keys.length}`);
    const f = await readDataFile(FILES[keys[i]]);
    if (!f) { state.data[keys[i]] = null; state.sha[keys[i]] = null; continue; }
    let env;
    try { env = JSON.parse(f.text); } catch { throw new Error(`${keys[i]} 不是有效的密文文件`); }
    try { state.data[keys[i]] = await decryptJSON(env, state.key); }
    catch { throw new Error(`${keys[i]} 解密失败：口令不一致或数据已损坏`); }
    state.sha[keys[i]] = f.sha;
    if (f.fallback) state.fallback = true;
  }
  if (!state.data.notes) state.data.notes = { schema: 1, type: 'notes', updatedAt: null, notes: [] };
  if (!Array.isArray(state.data.notes.notes)) state.data.notes.notes = [];
  await restoreDraft();
}

/* ---------- Markdown (safe DOM construction, no innerHTML) ---------- */
function inline(parent, text) {
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith('**')) parent.appendChild(el('strong', null, t.slice(2, -2)));
    else if (t.startsWith('*')) parent.appendChild(el('em', null, t.slice(1, -1)));
    else if (t.startsWith('`')) parent.appendChild(el('code', null, t.slice(1, -1)));
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
      const url = link ? link[2] : '';
      if (/^https?:\/\//i.test(url)) {
        const a = el('a', null, link[1]);
        a.href = url; a.rel = 'noopener noreferrer'; a.target = '_blank';
        parent.appendChild(a);
      } else parent.appendChild(document.createTextNode(t));
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  const lines = String(md || '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      const pre = el('pre'); pre.appendChild(el('code', null, buf.join('\n')));
      frag.appendChild(pre); continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      const level = (line.match(/^#+/) || ['#'])[0].length;
      const h = el(`h${level}`); inline(h, line.replace(/^#+\s+/, ''));
      frag.appendChild(h); i += 1; continue;
    }
    if (/^>\s?/.test(line)) {
      const b = el('blockquote'); inline(b, line.replace(/^>\s?/, ''));
      frag.appendChild(b); i += 1; continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const ul = el('ul');
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const li = el('li'); inline(li, lines[i].replace(/^[-*]\s+/, ''));
        ul.appendChild(li); i += 1;
      }
      frag.appendChild(ul); continue;
    }
    if (/^---+\s*$/.test(line)) { frag.appendChild(el('hr')); i += 1; continue; }
    if (line.trim() === '') { i += 1; continue; }
    const p = el('p'); inline(p, line); frag.appendChild(p); i += 1;
  }
  return frag;
}

/* ---------- views ---------- */
function render() {
  $('mode-badge').textContent = state.readOnly ? '只读' : '可编辑';
  const synced = state.data.meta?.syncedAt || state.data.shelf?.syncedAt;
  $('sync-time').textContent = synced ? `同步于 ${formatDateTime(synced)}` : '暂无同步数据';
  $('save-state').textContent = state.status
    + (state.fallback ? ' · 同域缓存读取，可能滞后' : '');
  $('conflict').classList.toggle('hidden', !state.conflict);
  for (const b of document.querySelectorAll('.nav-item')) {
    b.classList.toggle('active', b.dataset.view === state.view);
  }
  const main = $('main');
  clear(main);
  const view = {
    shelf: renderShelf,
    highlights: renderHighlights,
    notes: renderNotes,
    stats: renderStats,
    settings: renderSettings,
  }[state.view] || renderShelf;
  view(main);
}

function bookCard(b) {
  const card = el('div', 'book');
  if (b.cover) {
    const img = document.createElement('img');
    img.src = b.cover; img.alt = ''; img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(el('div', 'cover-fallback')));
    card.appendChild(img);
  } else card.appendChild(el('div', 'cover-fallback'));

  const info = el('div', 'book-info');
  info.appendChild(el('div', 'book-title', b.title || '未命名'));
  info.appendChild(el('div', 'book-author', b.author || ''));
  const bar = el('div', 'bar');
  const fill = document.createElement('i');
  fill.style.width = `${Math.max(0, Math.min(100, Number(b.progress) || 0))}%`;
  bar.appendChild(fill);
  info.appendChild(bar);
  info.appendChild(el('div', 'book-meta',
    b.progress == null ? '进度未获取' : `进度 ${Number(b.progress)}% · 最近 ${formatDate(b.readUpdateTime)}`));
  info.appendChild(el('span', 'source', '来源：/book/getprogress 的 book.progress（0-100 整数）'));
  card.appendChild(info);
  return card;
}

function renderShelf(root) {
  root.appendChild(sectionTitle('最近在读', '书架与阅读进度来自微信读书官方接口，仅在本机运行同步脚本后更新。'));
  const s = state.data.shelf;
  if (!s) { root.appendChild(empty('尚未同步书架数据。请在电脑上运行 scripts/sync_weread.mjs。')); return; }
  const cards = el('div', 'cards');
  cards.appendChild(metricCard(String(s.totalCount), '书架条目', '来源：/shelf/sync · books + albums + mp', s.syncedAt));
  cards.appendChild(metricCard(String(s.recent?.length || 0), '最近在读', '来源：/shelf/sync 的 readUpdateTime 排序', s.syncedAt));
  cards.appendChild(metricCard(String((s.books || []).filter((b) => b.finishReading).length), '已读完', '来源：/shelf/sync 的 finishReading', s.syncedAt));
  root.appendChild(cards);

  const map = new Map((s.books || []).map((b) => [b.bookId, b]));
  const ids = s.recent?.length ? s.recent : (s.books || []).slice(0, 12).map((b) => b.bookId);
  const grid = el('div', 'books');
  for (const id of ids) { const b = map.get(id); if (b) grid.appendChild(bookCard(b)); }
  root.appendChild(grid);
  root.appendChild(el('span', 'source', '书架条目口径：books.length + albums.length + (mp 非空 ? 1 : 0)，专辑/有声书按书架条目计入。'));
}

function quoteCard(it) {
  const q = el('div', 'quote');
  const meta = el('div', 'quote-meta');
  meta.appendChild(el('span', 'tag', it.kind === 'highlight' ? '划线' : '想法'));
  if (it.chapter) meta.appendChild(document.createTextNode(`${it.chapter} · `));
  meta.appendChild(document.createTextNode(formatDate(it.createdAt)));
  q.appendChild(meta);
  if (it.note) {
    q.appendChild(el('div', 'quote-text', it.note));
    q.appendChild(el('div', 'quote-note', it.text));
  } else q.appendChild(el('div', 'quote-text', it.text));
  return q;
}
function renderHighlightList(container) {
  clear(container);
  const h = state.data.highlights;
  const q = (state.search || '').trim().toLowerCase();
  const items = (h?.items || []).filter((it) => {
    if (!q) return true;
    return [it.text, it.note, it.bookTitle, it.chapter].some((v) => String(v || '').toLowerCase().includes(q));
  });
  if (!items.length) { container.appendChild(empty('没有匹配的内容。')); return; }
  const groups = new Map();
  for (const it of items) {
    const k = it.bookTitle || '未归类';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const [title, list] of groups) {
    const g = el('div', 'group');
    g.appendChild(el('div', 'group-title', `${title} · ${list.length} 条`));
    for (const it of list.slice(0, 100)) g.appendChild(quoteCard(it));
    container.appendChild(g);
  }
}
function renderHighlights(root) {
  root.appendChild(sectionTitle('划线想法', '来自微信读书，只读。内容取自 /book/bookmarklist 与 /review/list/mine。'));
  const h = state.data.highlights;
  if (!h || !h.items?.length) { root.appendChild(empty('尚未同步划线与想法数据。')); return; }
  const toolbar = el('div', 'toolbar');
  const input = el('input', 'field');
  input.type = 'search';
  input.placeholder = '搜索原文、想法或书名';
  input.value = state.search || '';
  toolbar.appendChild(input);
  root.appendChild(toolbar);
  const listWrap = el('div');
  root.appendChild(listWrap);
  input.addEventListener('input', () => { state.search = input.value; renderHighlightList(listWrap); });
  renderHighlightList(listWrap);
  root.appendChild(el('span', 'source', `共 ${h.items.length} 条 · 同步于 ${formatDateTime(h.syncedAt)} · 书签只计入数量，不导出内容。`));
}

function currentNote() {
  return (state.data.notes?.notes || []).find((n) => n.id === state.selectedNoteId) || null;
}
function commitEditor() {
  const t = $('note-title');
  const b = $('note-body');
  if (!t || !b) return;
  const n = currentNote();
  if (!n) return;
  n.title = t.value;
  n.body = b.value;
}
async function saveDraft() {
  if (!state.key || !state.data.notes) return;
  commitEditor();
  const revision = ++state.draftRevision;
  const key = state.key;
  const draft = {
    notes: structuredClone(state.data.notes), baseSha: state.sha.notes, at: Date.now(),
  };
  try {
    const env = await encryptJSON(draft, key, state.salt);
    if (revision === state.draftRevision && state.key === key) {
      localStorage.setItem(LS.draft, JSON.stringify(env));
    }
  } catch { /* storage unavailable: keep the in-memory editor only */ }
}
async function restoreDraft() {
  const raw = localStorage.getItem(LS.draft);
  if (!raw) return;
  try {
    const d = await decryptJSON(JSON.parse(raw), state.key);
    if (!d.notes || !Array.isArray(d.notes.notes)) return;
    if (Number(d.at) <= (Date.parse(state.data.notes.updatedAt || 0) || 0)) return;
    state.data.notes = d.notes;
    state.dirty = true;
    if (d.baseSha !== state.sha.notes) {
      state.conflict = true;
      setStatus('云端笔记已变化，本机草稿已保留，不能直接保存');
    } else setStatus('已恢复未保存的草稿');
  } catch { /* ignore stale or unreadable drafts */ }
}

function renderNoteDetail(box, note) {
  if (state.readOnly || state.editMode !== 'edit') {
    box.appendChild(el('h2', null, note.title || '无标题'));
    box.appendChild(el('div', 'source', `更新于 ${formatDateTime(note.updatedAt)} · ${note.tags?.length ? note.tags.join(' / ') : '无标签'}`));
    const prose = el('div', 'prose');
    prose.appendChild(renderMarkdown(note.body || ''));
    box.appendChild(prose);
    if (!state.readOnly) {
      const row = el('div', 'editor-actions');
      const edit = el('button', 'primary', '编辑');
      edit.addEventListener('click', () => { state.editMode = 'edit'; render(); });
      row.appendChild(edit);
      box.appendChild(row);
    }
    return;
  }

  const title = el('input', 'title-input');
  title.type = 'text'; title.id = 'note-title'; title.value = note.title || '';
  box.appendChild(title);
  const ta = document.createElement('textarea');
  ta.id = 'note-body';
  ta.value = note.body || '';
  ta.placeholder = '支持标题、粗体、斜体、行内代码、列表、引用、分隔线、代码块与链接';
  box.appendChild(ta);

  const row = el('div', 'editor-actions');
  const save = el('button', 'primary', '保存');
  save.disabled = state.conflict;
  save.addEventListener('click', saveNotes);
  row.appendChild(save);
  const preview = el('button', 'ghost', '预览');
  preview.addEventListener('click', () => { commitEditor(); state.editMode = 'view'; render(); });
  row.appendChild(preview);
  const del = el('button', 'ghost', '删除');
  del.addEventListener('click', deleteNote);
  row.appendChild(del);
  box.appendChild(row);
  box.appendChild(el('p', 'notice', '保存会向仓库提交一次变更。Ctrl/Cmd+S 可快速保存；未保存内容会加密暂存在本机。'));

  for (const node of [title, ta]) {
    node.addEventListener('input', () => { state.dirty = true; setStatus('有未保存的修改'); saveDraft(); });
  }
}

function createNote() {
  commitEditor();
  const id = `n-${Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2))).join('-')}`;
  const now = new Date().toISOString();
  state.data.notes.notes.push({
    id, title: '新笔记', body: '', bookId: null, tags: [], createdAt: now, updatedAt: now,
  });
  state.selectedNoteId = id;
  state.editMode = 'edit';
  state.dirty = true;
  render();
  saveDraft();
}
async function deleteNote() {
  if (!window.confirm('确定删除这篇笔记？删除后会立即写入仓库。')) return;
  commitEditor();
  state.data.notes.notes = state.data.notes.notes.filter((n) => n.id !== state.selectedNoteId);
  state.selectedNoteId = null;
  state.editMode = 'view';
  state.dirty = true;
  await saveDraft();
  await saveNotes();
}
async function saveNotes() {
  if (state.readOnly) { setStatus('当前为只读模式'); return; }
  if (state.conflict) { setStatus('请先下载本机草稿并重新加载云端笔记'); return; }
  if (state.saving) return;
  commitEditor();
  const n = currentNote();
  if (n) n.updatedAt = new Date().toISOString();
  state.data.notes.updatedAt = new Date().toISOString();
  await saveDraft();
  state.saving = true;
  const savedRevision = state.draftRevision;
  let text;
  try {
    const env = await encryptJSON(state.data.notes, state.key, state.salt);
    text = `${JSON.stringify(env)}\n`;
  } catch (e) {
    state.saving = false;
    setStatus(`加密失败：${e.message}`);
    return;
  }
  if (new Blob([text]).size > 900000) {
    setStatus('笔记数据超过 800KB，请先导出备份并拆分');
    state.saving = false;
    return;
  }
  setStatus('保存中…');
  try {
    const res = await writeDataFile(FILES.notes, text, state.sha.notes);
    if (res.conflict) {
      state.conflict = true;
      await saveDraft();
      setStatus('保存未生效：云端内容已在别处更新');
      state.saving = false;
      render();
      return;
    }
    state.sha.notes = res.sha;
    state.conflict = false;
    if (savedRevision === state.draftRevision) {
      state.dirty = false;
      state.draftRevision += 1;
      localStorage.removeItem(LS.draft);
      setStatus(`已保存 · ${new Date().toLocaleTimeString('zh-CN')}`);
    } else {
      state.dirty = true;
      await saveDraft();
      setStatus('先前修改已保存，仍有未保存内容');
    }
  } catch (e) {
    await saveDraft();
    setStatus(`保存失败：${e.message}`);
  }
  state.saving = false;
  render();
}

function renderNotes(root) {
  root.appendChild(sectionTitle('我的笔记',
    state.readOnly ? '只读模式。笔记由电脑端写入，此设备仅查看。' : '笔记以密文保存在仓库，保存后其他设备刷新即可看到。'));
  const notes = state.data.notes?.notes || [];
  const layout = el('div', 'notes-layout');
  const list = el('div', 'note-list');
  if (!state.readOnly) {
    const add = el('button', 'note-item editable-only', '+ 新建笔记');
    add.addEventListener('click', createNote);
    list.appendChild(add);
  }
  for (const n of [...notes].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))) {
    const b = el('button', `note-item${n.id === state.selectedNoteId ? ' active' : ''}`);
    b.appendChild(el('span', 't', n.title || '无标题'));
    b.appendChild(el('span', 'd', formatDate(n.updatedAt)));
    b.addEventListener('click', () => {
      commitEditor(); state.selectedNoteId = n.id; state.editMode = 'view'; render();
    });
    list.appendChild(b);
  }
  layout.appendChild(list);
  const editor = el('div', 'note-editor');
  const note = currentNote();
  if (!note) editor.appendChild(empty(state.readOnly ? '从左侧选择一篇笔记。' : '从左侧选择一篇笔记，或新建一篇。'));
  else renderNoteDetail(editor, note);
  layout.appendChild(editor);
  root.appendChild(layout);
  root.appendChild(el('span', 'source', '笔记由使用者撰写，与微信读书同步数据分开存储；同步脚本不会覆盖这里的内容。'));
}

function renderStats(root) {
  root.appendChild(sectionTitle('阅读统计', '每个数字均标注原始接口与字段；口径不混用，不互相推算。'));
  const s = state.data.stats;
  if (!s) { root.appendChild(empty('尚未同步阅读统计数据。')); return; }
  const cards = el('div', 'cards');
  cards.appendChild(metricCard(formatDuration(s.monthly?.totalReadTimeSec), '本月阅读', '来源：/readdata/detail · totalReadTime（秒）', s.syncedAt));
  cards.appendChild(metricCard(String(s.monthly?.readDays ?? '—'), '本月阅读天数', '来源：/readdata/detail · readDays', s.syncedAt));
  cards.appendChild(metricCard(formatDuration(s.overall?.totalReadTimeSec), '累计阅读', '来源：/readdata/detail · mode=overall · totalReadTime（秒）', s.syncedAt));
  cards.appendChild(metricCard(String(s.noteCount), '笔记总数', '来源：/user/notebooks · 三项之和', s.syncedAt));
  root.appendChild(cards);

  root.appendChild(el('h3', null, '笔记数构成'));
  const b = s.noteCountBreakdown || {};
  for (const [k, label] of [['reviewCount', '想法/点评'], ['noteCount', '划线'], ['bookmarkCount', '书签']]) {
    const row = el('div', 'list-row');
    row.appendChild(el('span', null, label + (k === 'noteCount' ? '（划线数，非总数）' : '')));
    row.appendChild(el('span', null, String(b[k] ?? 0)));
    root.appendChild(row);
  }
  root.appendChild(el('span', 'source', `三项合计 ${s.noteCount} = reviewCount + noteCount + bookmarkCount。reviewCount 已含个人点评，不重复累加。`));

  const days = s.monthly?.byDay || [];
  if (days.length) {
    root.appendChild(el('h3', null, '本月按日明细'));
    root.appendChild(el('span', 'source', '来源：/readdata/detail · readTimes（分桶明细）。仅用于按日展示，不替代 totalReadTime 作为总量口径。'));
    const max = Math.max(1, ...days.map((d) => Number(d.readTimeSec) || 0));
    const bars = el('div', 'bars');
    for (const d of days) {
      const row = el('div', 'bar-row');
      row.appendChild(el('span', null, d.date || '—'));
      const track = el('div', 'bar-track');
      const i = document.createElement('i');
      i.style.width = `${Math.round((Number(d.readTimeSec) || 0) / max * 100)}%`;
      track.appendChild(i);
      row.appendChild(track);
      row.appendChild(el('span', null, formatDuration(d.readTimeSec)));
      bars.appendChild(row);
    }
    root.appendChild(bars);
  }

  const books = s.monthly?.byBook || [];
  if (books.length) {
    root.appendChild(el('h3', null, '本月读得最多'));
    root.appendChild(el('span', 'source', '来源：/readdata/detail · readLongest[].readTime（秒）。'));
    for (const x of books) {
      const row = el('div', 'list-row');
      row.appendChild(el('span', null, x.title || '未命名'));
      row.appendChild(el('span', null, formatDuration(x.readTimeSec)));
      root.appendChild(row);
    }
  }
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderSettings(root) {
  root.appendChild(sectionTitle('设置', '仓库地址与写回令牌只保存在当前浏览器，不会上传。'));

  const b1 = el('div', 'settings-block');
  b1.appendChild(el('h3', null, '仓库'));
  const f1 = el('label', null, '所有者');
  const i1 = el('input'); i1.type = 'text'; i1.value = state.config.owner; f1.appendChild(i1); b1.appendChild(f1);
  const f2 = el('label', null, '仓库名');
  const i2 = el('input'); i2.type = 'text'; i2.value = state.config.repo; f2.appendChild(i2); b1.appendChild(f2);
  const f3 = el('label', null, '分支');
  const i3 = el('input'); i3.type = 'text'; i3.value = state.config.branch; f3.appendChild(i3); b1.appendChild(f3);
  const row1 = el('div', 'row');
  const saveCfg = el('button', 'primary', '保存仓库地址');
  saveCfg.addEventListener('click', async () => {
    state.config = {
      owner: i1.value.trim(), repo: i2.value.trim(), branch: i3.value.trim() || 'main',
    };
    saveConfig(state.config);
    try { await loadData(); setStatus('仓库地址已更新'); render(); }
    catch (e) { setStatus(`读取失败：${e.message}`); }
  });
  row1.appendChild(saveCfg);
  b1.appendChild(row1);
  root.appendChild(b1);

  const b2 = el('div', 'settings-block');
  b2.appendChild(el('h3', null, '写回令牌'));
  b2.appendChild(el('p', 'notice', state.readOnly
    ? '当前为只读模式：未配置写回令牌，适合手机查看。'
    : '当前为可编辑模式：令牌只保存在这台设备，并用口令加密。'));
  const f4 = el('label', null, 'fine-grained PAT');
  const i4 = el('input'); i4.type = 'password'; i4.autocomplete = 'off'; i4.placeholder = '仅本仓库 Contents: Read and write'; f4.appendChild(i4);
  b2.appendChild(f4);
  const row2 = el('div', 'row');
  const savePat = el('button', 'primary', '保存并切换为可编辑');
  savePat.addEventListener('click', async () => {
    const v = i4.value.trim();
    if (!v) { setStatus('请输入令牌'); return; }
    await storePat(v);
    state.readOnly = false;
    i4.value = '';
    try { await loadData(); setStatus('已切换为可编辑'); render(); }
    catch (e) { setStatus(`读取失败：${e.message}`); render(); }
  });
  row2.appendChild(savePat);
  const clearPat = el('button', 'ghost', '清除，改为只读');
  clearPat.addEventListener('click', async () => {
    await storePat(null);
    state.readOnly = true;
    setStatus('已切换为只读');
    render();
  });
  row2.appendChild(clearPat);
  b2.appendChild(row2);
  b2.appendChild(el('p', 'notice', '令牌会暴露在浏览器运行时，因此请使用仅授权单个仓库、权限为 Contents: Read and write、带有效期的 fine-grained PAT，并定期轮换。'));
  root.appendChild(b2);

  const b3 = el('div', 'settings-block');
  b3.appendChild(el('h3', null, '备份'));
  const row3 = el('div', 'row');
  const plain = el('button', 'ghost', '导出明文备份');
  plain.addEventListener('click', () => {
    download(`reading-backup-${formatDate(new Date())}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), data: state.data }, null, 2));
    setStatus('明文备份已下载，请离线保管');
  });
  row3.appendChild(plain);
  const cipher = el('button', 'ghost', '导出密文备份');
  cipher.addEventListener('click', async () => {
    const out = {};
    for (const k of Object.keys(FILES)) {
      if (state.data[k]) out[k] = await encryptJSON(state.data[k], state.key, state.salt);
    }
    download(`reading-vault-${formatDate(new Date())}.json`,
      JSON.stringify({ vault: state.vault, exportedAt: new Date().toISOString(), envelopes: out }, null, 2));
    setStatus('密文备份已下载，需同一口令才能解开');
  });
  row3.appendChild(cipher);
  b3.appendChild(row3);
  b3.appendChild(el('p', 'notice', '明文备份包含全部已解密内容，请离线保管。忘记口令无法恢复，密文备份只能用同一口令解开。'));
  root.appendChild(b3);

  const b4 = el('div', 'settings-block');
  b4.appendChild(el('h3', null, '安全边界'));
  b4.appendChild(el('p', 'notice', '页面与仓库公开，任何人都能访问页面、下载全部密文，并看到文件名、提交时间与文件大小。口令只在本地用于解密，没有服务端账号或会话。'));
  b4.appendChild(el('p', 'notice', '此方案保护内容机密性，不保护访问权限；拿到已解锁设备的人、恶意浏览器扩展或页面脚本注入，都可能读到内存中的密钥与令牌。'));
  root.appendChild(b4);
}

boot();
