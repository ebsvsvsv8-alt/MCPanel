const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let db

function initDb() {
  const initSqlJs = require('sql.js')
  const dbPath = path.join(app.getPath('userData'), 'mcpanel.db')

  // sql.js is synchronous after init, but init itself returns a Promise
  // We use a trick: store the db synchronously via execSync-style init
  // Actually we call this from an async context in main.js — so we return a Promise
  return initSqlJs().then(SQL => {
    let data = null
    if (fs.existsSync(dbPath)) {
      data = fs.readFileSync(dbPath)
    }
    db = data ? new SQL.Database(data) : new SQL.Database()

    db.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        core TEXT NOT NULL,
        version TEXT NOT NULL,
        port INTEGER DEFAULT 25565,
        maxPlayers INTEGER DEFAULT 20,
        gamemode TEXT DEFAULT 'survival',
        difficulty TEXT DEFAULT 'normal',
        dir TEXT NOT NULL,
        status TEXT DEFAULT 'stopped',
        javaPath TEXT DEFAULT NULL,
        javaVersion INTEGER DEFAULT NULL,
        ram INTEGER DEFAULT 2,
        createdAt INTEGER DEFAULT (strftime('%s','now'))
      );
    `)

    // Миграция
    try { db.run(`ALTER TABLE servers ADD COLUMN javaPath TEXT DEFAULT NULL`) } catch {}
    try { db.run(`ALTER TABLE servers ADD COLUMN javaVersion INTEGER DEFAULT NULL`) } catch {}
    try { db.run(`ALTER TABLE servers ADD COLUMN ram INTEGER DEFAULT 2`) } catch {}

    // Save DB to disk on every write
    _save(dbPath)
    _dbPath = dbPath
  })
}

let _dbPath = null

function _save() {
  if (!db || !_dbPath) return
  const data = db.export()
  fs.writeFileSync(_dbPath, Buffer.from(data))
}

function _rowsToObjects(result) {
  if (!result || result.length === 0) return []
  const { columns, values } = result[0]
  return values.map(row => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
}

function getServers() {
  const res = db.exec('SELECT * FROM servers ORDER BY createdAt DESC')
  return _rowsToObjects(res)
}

function getServer(id) {
  const res = db.exec('SELECT * FROM servers WHERE id = ?', [id])
  const rows = _rowsToObjects(res)
  return rows[0] || null
}

function createServer({ id, name, core, version, port, maxPlayers, gamemode, difficulty, dir, javaPath, javaVersion, ram }) {
  db.run(
    `INSERT INTO servers (id, name, core, version, port, maxPlayers, gamemode, difficulty, dir, javaPath, javaVersion, ram)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, core, version,
     port || 25565, maxPlayers || 20,
     gamemode || 'survival', difficulty || 'normal',
     dir,
     javaPath || null, javaVersion || null,
     ram || 2]
  )
  _save()
  return getServer(id)
}

function updateServer(id, fields) {
  if (!fields || Object.keys(fields).length === 0) return
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ')
  db.run(`UPDATE servers SET ${sets} WHERE id = ?`, [...Object.values(fields), id])
  _save()
}

function updateServerStatus(id, status) {
  db.run('UPDATE servers SET status = ? WHERE id = ?', [status, id])
  _save()
}

function deleteServer(id) {
  db.run('DELETE FROM servers WHERE id = ?', [id])
  _save()
}

module.exports = { initDb, getServers, getServer, createServer, updateServer, updateServerStatus, deleteServer }
