const fs = require('fs')
const path = require('path')

/**
 * Performance monitor for server processes
 */
class PerformanceMonitor {
  constructor() {
    this.history = new Map() // serverId -> [{timestamp, cpu, ram, players}]
    this.maxHistorySize = 100 // Keep last 100 data points
  }

  /**
   * Record performance data
   */
  record(serverId, data) {
    if (!this.history.has(serverId)) {
      this.history.set(serverId, [])
    }

    const history = this.history.get(serverId)
    history.push({
      timestamp: Date.now(),
      cpu: data.cpu || 0,
      ram: data.ram || 0,
      players: data.players || 0,
      uptime: data.uptime || 0
    })

    // Keep only last N entries
    if (history.length > this.maxHistorySize) {
      history.shift()
    }
  }

  /**
   * Get performance history
   */
  getHistory(serverId, limit = 50) {
    const history = this.history.get(serverId) || []
    return history.slice(-limit)
  }

  /**
   * Get average stats
   */
  getAverageStats(serverId, minutes = 5) {
    const history = this.history.get(serverId) || []
    if (history.length === 0) return null

    const cutoff = Date.now() - (minutes * 60 * 1000)
    const recent = history.filter(h => h.timestamp >= cutoff)

    if (recent.length === 0) return null

    const sum = recent.reduce((acc, h) => ({
      cpu: acc.cpu + h.cpu,
      ram: acc.ram + h.ram,
      players: acc.players + h.players
    }), { cpu: 0, ram: 0, players: 0 })

    return {
      cpu: Math.round(sum.cpu / recent.length),
      ram: Math.round(sum.ram / recent.length),
      players: Math.round(sum.players / recent.length),
      samples: recent.length
    }
  }

  /**
   * Clear history for a server
   */
  clear(serverId) {
    this.history.delete(serverId)
  }

  /**
   * Export history to JSON
   */
  export(serverId, filePath) {
    const history = this.history.get(serverId) || []
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2))
  }
}

module.exports = PerformanceMonitor
