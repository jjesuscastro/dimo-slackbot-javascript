'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const TIME_ZONE = 'Asia/Manila';
const UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const dbPath = process.env.STATS_DB_PATH || path.join(process.cwd(), 'data', 'stats.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS file_stats (
    id INTEGER PRIMARY KEY,
    checked_at TEXT NOT NULL,
    uploader_id TEXT NOT NULL,
    uploader_display_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    naming_ok INTEGER NOT NULL,
    has_mraid_open INTEGER NOT NULL,
    has_window_open INTEGER NOT NULL,
    uploaded INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    issue_details TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_file_stats_checked_at ON file_stats(checked_at);
  CREATE INDEX IF NOT EXISTS idx_file_stats_uploader ON file_stats(uploader_id, checked_at);
`);

const insertFile = db.prepare(`INSERT INTO file_stats
  (checked_at, uploader_id, uploader_display_name, filename, naming_ok,
   has_mraid_open, has_window_open, uploaded, outcome, issue_details)
  VALUES (@checked_at, @uploader_id, @uploader_display_name, @filename,
   @naming_ok, @has_mraid_open, @has_window_open, @uploaded, @outcome, @issue_details)`);

function recordFiles(files) {
  const transaction = db.transaction((rows) => rows.forEach((row) => insertFile.run(row)));
  transaction(files);
}

function localDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfWeek(dateString) {
  const weekday = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  return shiftDate(dateString, -weekday);
}

function localMidnightIso(dateString) {
  return new Date(Date.parse(`${dateString}T00:00:00Z`) - UTC_OFFSET_MS).toISOString();
}

function periodRange(period, now = new Date()) {
  const today = localDate(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  let start;
  let end;
  switch (period) {
    case 'today': start = today; end = shiftDate(today, 1); break;
    case 'week': start = startOfWeek(today); end = shiftDate(today, 1); break;
    case 'month': start = monthStart; end = shiftDate(today, 1); break;
    case 'yesterday': start = shiftDate(today, -1); end = today; break;
    case 'lastweek': start = shiftDate(startOfWeek(today), -7); end = startOfWeek(today); break;
    case 'lastmonth': {
      const previous = new Date(`${monthStart}T00:00:00Z`);
      previous.setUTCMonth(previous.getUTCMonth() - 1);
      start = previous.toISOString().slice(0, 10);
      end = monthStart;
      break;
    }
    case 'all': return { start: null, end: null };
    default: throw new Error('Unknown statistics period.');
  }
  return { start: localMidnightIso(start), end: localMidnightIso(end) };
}

const periodLabels = {
  today: 'Current day', week: 'Current week (Sunday to today)', month: 'Current month',
  yesterday: 'Yesterday', lastweek: 'Last week (Sunday to Saturday)',
  lastmonth: 'Last month', all: 'All time',
};

function getStats(period) {
  const range = periodRange(period);
  const where = range.start ? 'WHERE checked_at >= ? AND checked_at < ?' : '';
  const args = range.start ? [range.start, range.end] : [];
  const totals = db.prepare(`SELECT COUNT(*) AS processed,
    SUM(uploaded) AS uploaded,
    SUM(CASE WHEN naming_ok = 0 THEN 1 ELSE 0 END) AS naming_issues,
    SUM(CASE WHEN has_mraid_open = 0 THEN 1 ELSE 0 END) AS missing_mraid_open,
    SUM(has_window_open) AS window_open_issues,
    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failures
    FROM file_stats ${where}`).get(...args);
  const topUploaders = db.prepare(`SELECT uploader_id, uploader_display_name,
    COUNT(*) AS processed, SUM(uploaded) AS uploaded
    FROM file_stats ${where} GROUP BY uploader_id, uploader_display_name
    ORDER BY uploaded DESC, processed DESC LIMIT 10`).all(...args);
  return { period, label: periodLabels[period], range, totals: Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, value || 0]),
  ), topUploaders };
}

function getCsvRows(period) {
  const range = periodRange(period);
  const where = range.start ? 'WHERE checked_at >= ? AND checked_at < ?' : '';
  const args = range.start ? [range.start, range.end] : [];
  return db.prepare(`SELECT checked_at, uploader_id, uploader_display_name, filename,
    naming_ok, has_mraid_open, has_window_open, uploaded, outcome, issue_details
    FROM file_stats ${where} ORDER BY checked_at ASC, id ASC`).all(...args);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const columns = ['checked_at', 'uploader_id', 'uploader_display_name', 'filename',
    'naming_ok', 'has_mraid_open', 'has_window_open', 'uploaded', 'outcome', 'issue_details'];
  return [columns.join(','), ...rows.map((row) => columns.map((column) => {
    const value = row[column];
    return csvEscape(typeof value === 'number' && ['naming_ok', 'has_mraid_open', 'has_window_open', 'uploaded'].includes(column)
      ? Boolean(value) : value);
  }).join(','))].join('\r\n');
}

module.exports = { recordFiles, getStats, getCsvRows, toCsv, periodLabels };
