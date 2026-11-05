// Non-secret constants. No API key, token, or passphrase belongs in this file.
export const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';

// Must match the `version` field in ~/.workbuddy/skills/weread-skills/SKILL.md.
// If the gateway returns upgrade_info, stop and follow its instructions, then bump this value.
export const SKILL_VERSION = '1.0.5';

export const SYNC_DIR = 'data/sync';
export const NOTES_DIR = 'data/notes';

// Verbatim metric definitions, carried into data/sync/meta.enc so the UI can cite them.
export const METRIC_DEFINITIONS = {
  totalReadTimeSec: {
    source: '/readdata/detail',
    field: 'totalReadTime',
    unit: 'second',
    note: '当前请求周期的总阅读/收听时长（秒）。禁止用 readTimes 累加替代。',
  },
  byDay: {
    source: '/readdata/detail',
    field: 'readTimes',
    unit: 'second',
    note: '仅用于按日明细展示，不替代 totalReadTime 作为总量口径。',
  },
  noteCount: {
    source: '/user/notebooks',
    formula: 'reviewCount + noteCount + bookmarkCount',
    note: 'noteCount 是划线数不是总数；reviewCount 已含个人点评，不得重复累加。',
  },
  shelfTotal: {
    source: '/shelf/sync',
    formula: 'books.length + albums.length + (mp 非空 ? 1 : 0)',
    note: '专辑/有声书按书架条目计入。',
  },
  progress: {
    source: '/book/getprogress',
    field: 'book.progress',
    unit: 'percent',
    note: '0-100 的整数，1 表示 1%，仅 100 代表读完。',
  },
};

export const DEFAULT_MAX_BOOKS = 8;
export const DEFAULT_MAX_NOTE_BOOKS = 10;
export const DEFAULT_THROTTLE_MS = 300;
