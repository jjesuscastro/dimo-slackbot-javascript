'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dbPath = process.env.STATS_DB_PATH || path.join(process.cwd(), 'data', 'stats.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS project_collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES project_collections(id) ON DELETE CASCADE,
    source_file_id TEXT NOT NULL,
    entry_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    content BLOB NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE(project_id, source_file_id, entry_name)
  );
  CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id, id);
`);
db.pragma('foreign_keys = ON');

const listProjectsQuery = db.prepare(`SELECT p.id, p.name, COUNT(f.id) AS file_count
  FROM project_collections p LEFT JOIN project_files f ON f.project_id = p.id
  GROUP BY p.id ORDER BY p.name COLLATE NOCASE`);

function listProjects() {
  return listProjectsQuery.all();
}

function addProjectFiles(projectName, files) {
  const name = projectName.trim();
  if (!name || name.length > 80) throw new Error('Project names must be between 1 and 80 characters.');
  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO project_collections (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
      .run(name, new Date().toISOString());
    const project = db.prepare('SELECT id, name FROM project_collections WHERE name = ? COLLATE NOCASE').get(name);
    const removeSameFilename = db.prepare(`DELETE FROM project_files
      WHERE project_id = ? AND filename = ? COLLATE NOCASE`);
    const insert = db.prepare(`INSERT INTO project_files
      (project_id, source_file_id, entry_name, filename, content, added_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, source_file_id, entry_name) DO NOTHING`);
    let added = 0;
    let replaced = 0;
    for (const file of files) {
      const previousMatches = removeSameFilename.run(project.id, file.filename).changes;
      const inserted = insert.run(project.id, file.sourceFileId, file.entryName, file.filename,
        file.bytes, new Date().toISOString()).changes;
      if (previousMatches) replaced += previousMatches;
      else added += inserted;
    }
    return { project, added, replaced };
  });
  return transaction();
}

function getProjectFiles(projectId) {
  return db.prepare(`SELECT id, filename, content FROM project_files
    WHERE project_id = ? ORDER BY id`).all(projectId);
}

function getProjectFileNames(projectId) {
  return db.prepare(`SELECT id, filename FROM project_files WHERE project_id = ? ORDER BY id`).all(projectId);
}

function getProject(projectId) {
  return db.prepare('SELECT id, name FROM project_collections WHERE id = ?').get(projectId);
}

function clearProjectFiles(projectId, fileIds) {
  if (!fileIds?.length) return 0;
  const placeholders = fileIds.map(() => '?').join(', ');
  return db.prepare(`DELETE FROM project_files WHERE project_id = ? AND id IN (${placeholders})`)
    .run(projectId, ...fileIds).changes;
}

function removeProjectFiles(projectId, fileIds) {
  return clearProjectFiles(projectId, fileIds);
}

module.exports = {
  listProjects, addProjectFiles, getProjectFiles, getProjectFileNames,
  getProject, clearProjectFiles, removeProjectFiles,
};
