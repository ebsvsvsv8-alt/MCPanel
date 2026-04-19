const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

/**
 * Utility functions for MCPanel
 */
class Utils {
  /**
   * Format bytes to human readable
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
  }

  /**
   * Format uptime to human readable
   */
  static formatUptime(seconds) {
    if (seconds < 60) return `${seconds}с`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}м`
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return `${hours}ч ${mins}м`
  }

  /**
   * Check if port is available
   */
  static isPortAvailable(port) {
    try {
      if (process.platform === 'win32') {
        const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
        return output.trim().length === 0
      } else {
        const output = execSync(`lsof -i :${port}`, { encoding: 'utf8' })
        return output.trim().length === 0
      }
    } catch {
      return true // If command fails, assume port is available
    }
  }

  /**
   * Get system info
   */
  static getSystemInfo() {
    const os = require('os')
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime()
    }
  }

  /**
   * Validate server name
   */
  static validateServerName(name) {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Название не может быть пустым' }
    }
    if (name.length > 50) {
      return { valid: false, error: 'Название слишком длинное (макс 50 символов)' }
    }
    if (!/^[a-zA-Zа-яА-Я0-9\s\-_]+$/.test(name)) {
      return { valid: false, error: 'Недопустимые символы в названии' }
    }
    return { valid: true }
  }

  /**
   * Validate port
   */
  static validatePort(port) {
    const num = parseInt(port)
    if (isNaN(num) || num < 1 || num > 65535) {
      return { valid: false, error: 'Порт должен быть от 1 до 65535' }
    }
    return { valid: true, port: num }
  }

  /**
   * Generate random port
   */
  static generateRandomPort(min = 25565, max = 25665) {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  /**
   * Clean old log files
   */
  static cleanOldLogs(serverDir, daysOld = 7) {
    const logsDir = path.join(serverDir, 'logs')
    if (!fs.existsSync(logsDir)) return 0

    const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000)
    let cleaned = 0

    const files = fs.readdirSync(logsDir)
    for (const file of files) {
      const filePath = path.join(logsDir, file)
      const stat = fs.statSync(filePath)
      if (stat.mtime.getTime() < cutoff) {
        fs.unlinkSync(filePath)
        cleaned++
      }
    }

    return cleaned
  }

  /**
   * Get disk space info
   */
  static getDiskSpace(dirPath) {
    try {
      if (process.platform === 'win32') {
        const drive = path.parse(dirPath).root
        const output = execSync(`wmic logicaldisk where "DeviceID='${drive.replace('\\', '')}'" get FreeSpace,Size`, { encoding: 'utf8' })
        const lines = output.trim().split('\n').filter(l => l.trim())
        if (lines.length > 1) {
          const [free, total] = lines[1].trim().split(/\s+/).map(Number)
          return { free, total, used: total - free }
        }
      } else {
        const output = execSync(`df -k "${dirPath}"`, { encoding: 'utf8' })
        const lines = output.trim().split('\n')
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/)
          return {
            total: parseInt(parts[1]) * 1024,
            used: parseInt(parts[2]) * 1024,
            free: parseInt(parts[3]) * 1024
          }
        }
      }
    } catch (e) {
      console.error('Failed to get disk space:', e)
    }
    return null
  }
}

module.exports = Utils
