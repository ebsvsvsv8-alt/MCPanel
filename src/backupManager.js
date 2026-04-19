const fs = require('fs')
const path = require('path')

/**
 * Backup manager for Minecraft servers
 */
class BackupManager {
  constructor(baseDir) {
    this.baseDir = baseDir
    this.backupsDir = path.join(baseDir, 'backups')
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true })
    }
  }

  /**
   * Create a backup of server world
   */
  async createBackup(serverId, serverDir, worldName = 'world') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const backupName = `${serverId}_${timestamp}`
    const backupPath = path.join(this.backupsDir, backupName)

    const worldPath = path.join(serverDir, worldName)
    if (!fs.existsSync(worldPath)) {
      throw new Error(`World folder not found: ${worldName}`)
    }

    // Create backup directory
    fs.mkdirSync(backupPath, { recursive: true })

    // Copy world folder
    await this.copyDir(worldPath, path.join(backupPath, worldName))

    // Save metadata
    const metadata = {
      serverId,
      worldName,
      timestamp: new Date().toISOString(),
      size: this.getDirSize(backupPath)
    }
    fs.writeFileSync(
      path.join(backupPath, 'backup.json'),
      JSON.stringify(metadata, null, 2)
    )

    return { path: backupPath, ...metadata }
  }

  /**
   * List all backups for a server
   */
  listBackups(serverId) {
    if (!fs.existsSync(this.backupsDir)) return []

    const backups = []
    const dirs = fs.readdirSync(this.backupsDir)

    for (const dir of dirs) {
      if (!dir.startsWith(serverId)) continue

      const backupPath = path.join(this.backupsDir, dir)
      const metaPath = path.join(backupPath, 'backup.json')

      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        backups.push({ name: dir, path: backupPath, ...meta })
      }
    }

    return backups.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  }

  /**
   * Restore backup
   */
  async restoreBackup(backupPath, serverDir, worldName = 'world') {
    const worldBackupPath = path.join(backupPath, worldName)
    const worldPath = path.join(serverDir, worldName)

    if (!fs.existsSync(worldBackupPath)) {
      throw new Error('Backup world not found')
    }

    // Remove old world
    if (fs.existsSync(worldPath)) {
      fs.rmSync(worldPath, { recursive: true, force: true })
    }

    // Restore from backup
    await this.copyDir(worldBackupPath, worldPath)
  }

  /**
   * Delete backup
   */
  deleteBackup(backupPath) {
    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true })
    }
  }

  /**
   * Copy directory recursively
   */
  async copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  /**
   * Get directory size in bytes
   */
  getDirSize(dirPath) {
    let size = 0
    const files = fs.readdirSync(dirPath, { withFileTypes: true })

    for (const file of files) {
      const filePath = path.join(dirPath, file.name)
      if (file.isDirectory()) {
        size += this.getDirSize(filePath)
      } else {
        size += fs.statSync(filePath).size
      }
    }

    return size
  }
}

module.exports = BackupManager
