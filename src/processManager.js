const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const iconv = require('iconv-lite')

const processes = new Map()  // id → { proc, stats, startTime, statsInterval, logs, logFile }

function start(server, { onLog, onStatus, onStats }) {
  console.log('[ProcessManager] start called for server:', server.id, server.name)
  if (processes.has(server.id)) {
    console.log('[ProcessManager] Server already running')
    onLog('[MCPanel] Server already running')
    return false
  }

  const ram = server.ram || 2
  const isVelocity = server.core === 'velocity'
  const jarFile = isVelocity ? 'Velocity.jar' : 'server.jar'

  // Optimized JVM flags for better performance
  const javaArgs = [
    `-Xms${Math.max(512, ram * 256)}M`,  // Dynamic min heap
    `-Xmx${ram}G`,
    '-Dfile.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
    '-jar', jarFile,
    ...(isVelocity ? [] : ['--nogui'])
  ]

  // Определяем правильную Java для этого ядра/версии
  const coreDownloader = require('./coreDownloader')
  const requiredJava = server.core === 'velocity'
    ? coreDownloader.getJavaForProxy(server.core)
    : coreDownloader.getRequiredJava(server.version)
  const javaExe = coreDownloader.getJavaExe(requiredJava) || 'java'
  console.log('[ProcessManager] Using Java:', javaExe, 'for version:', server.version)

  let proc
  try {
    console.log('[ProcessManager] Spawning process in dir:', server.dir)
    console.log('[ProcessManager] Java args:', javaArgs)
    proc = spawn(javaExe, javaArgs, {
      cwd: server.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'en_US.UTF-8' }
    })
    console.log('[ProcessManager] Process spawned with PID:', proc.pid)
  } catch (err) {
    console.error('[ProcessManager] Spawn error:', err)
    onLog('[MCPanel] Start error: ' + err.message)
    onLog('[MCPanel] Make sure Java is installed')
    onStatus('stopped')
    return false
  }

  onStatus('starting')

  const logFile = path.join(server.dir, 'console.log')

  const entry = {
    proc,
    stats: { cpu: 0, ram: 0, players: 0, uptime: 0 },
    startTime: Date.now(),
    statsInterval: null,
    logs: [],
    logFile: logFile,
    callbacks: { onLog, onStatus, onStats }
  }

  // DON'T load previous logs on restart - they're already in the UI
  // Only the new process output will be sent

  proc.stdout.on('data', (data) => {
    const lines = data.toString('utf8').split('\n').filter(l => l.trim())
    for (const line of lines) {
      entry.logs.push(line)

      // Keep only last 1000 lines in memory
      if (entry.logs.length > 1000) {
        entry.logs.shift()
      }

      // Append to file
      try {
        fs.appendFileSync(entry.logFile, line + '\n', 'utf8')

        // Trim file if too large (keep last 1000 lines)
        const stats = fs.statSync(entry.logFile)
        if (stats.size > 500000) { // ~500KB, roughly 1000+ lines
          const content = fs.readFileSync(entry.logFile, 'utf8')
          const allLines = content.split('\n').filter(l => l.trim())
          if (allLines.length > 1000) {
            const trimmed = allLines.slice(-1000)
            fs.writeFileSync(entry.logFile, trimmed.join('\n') + '\n', 'utf8')
          }
        }
      } catch (e) {
        console.error('[MCPanel] Failed to write log:', e.message)
      }

      onLog(line)
      if (line.includes('Done (') || line.includes('For help, type') || line.includes('Server started')) {
        onStatus('running')
      }
      if (line.includes('joined the game')) {
        entry.stats.players++
        onStats({ ...entry.stats })
      }
      if (line.includes('left the game')) {
        entry.stats.players = Math.max(0, entry.stats.players - 1)
        onStats({ ...entry.stats })
      }
    }
  })

  proc.stderr.on('data', (data) => {
    const lines = data.toString('utf8').split('\n').filter(l => l.trim())
    for (const line of lines) {
      const prefixed = `[ERR] ${line}`
      entry.logs.push(prefixed)

      // Keep only last 1000 lines in memory
      if (entry.logs.length > 1000) {
        entry.logs.shift()
      }

      // Append to file
      try {
        fs.appendFileSync(entry.logFile, prefixed + '\n', 'utf8')
      } catch (e) {
        console.error('[MCPanel] Failed to write error log:', e.message)
      }

      onLog(prefixed)
    }
  })

  proc.on('close', (code) => {
    processes.delete(server.id)
    if (entry.statsInterval) {
      clearInterval(entry.statsInterval)
      entry.statsInterval = null
    }

    onStatus('stopped')
    const stopMsg = '[MCPanel] Server stopped (code: ' + code + ')'
    entry.logs.push(stopMsg)

    // Append stop message to log file
    try {
      fs.appendFileSync(entry.logFile, stopMsg + '\n', 'utf8')
    } catch (e) {
      console.error('[MCPanel] Failed to write stop log:', e.message)
    }

    onLog(stopMsg)
  })

  proc.on('error', (err) => {
    const errorMsg = '[MCPanel] Process error: ' + err.message
    entry.logs.push(errorMsg)
    onLog(errorMsg)
    onStatus('stopped')
    processes.delete(server.id)
  })

  processes.set(server.id, entry)

  entry.statsInterval = setInterval(() => {
    if (!processes.has(server.id)) return
    entry.stats.uptime = Math.floor((Date.now() - entry.startTime) / 1000)
    try {
      const mem = process.memoryUsage()
      entry.stats.ram = Math.round(mem.heapUsed / 1024 / 1024)
    } catch {}
    onStats({ ...entry.stats })
  }, 10000) // Update every 10 seconds instead of 5

  return true
}

function stop(id) {
  return new Promise((resolve) => {
    const entry = processes.get(id)
    if (!entry) {
      resolve()
      return
    }

    if (entry.statsInterval) {
      clearInterval(entry.statsInterval)
      entry.statsInterval = null
    }

    // Check if process is already dead
    if (entry.proc.killed || entry.proc.exitCode !== null) {
      processes.delete(id)
      resolve()
      return
    }

    let timeout = null

    const closeHandler = () => {
      if (timeout) clearTimeout(timeout)
      processes.delete(id)
      resolve()
    }

    entry.proc.once('close', closeHandler)

    try {
      // Check if stdin is writable before writing
      if (entry.proc.stdin && !entry.proc.stdin.destroyed && entry.proc.stdin.writable) {
        entry.proc.stdin.write('stop\n')
      } else {
        // If stdin is not available, just kill the process
        entry.proc.kill('SIGTERM')
      }

      timeout = setTimeout(() => {
        if (processes.has(id)) {
          try {
            entry.proc.kill('SIGTERM')
          } catch (e) {
            console.error('[MCPanel] Error killing process:', e)
          }
        }
      }, 8000)
    } catch (e) {
      entry.proc.removeListener('close', closeHandler)
      try {
        entry.proc.kill()
      } catch {}
      resolve()
    }
  })
}

async function stopAll() {
  const ids = Array.from(processes.keys())
  await Promise.all(ids.map(id => stop(id)))
}

function sendCommand(id, cmd) {
  const entry = processes.get(id)
  if (!entry) return
  try { entry.proc.stdin.write(cmd + '\n') } catch {}
}

function getStats(id) {
  const entry = processes.get(id)
  return entry ? entry.stats : null
}

function getLogs(id) {
  const entry = processes.get(id)
  return entry ? entry.logs : []
}

function isRunning(id) {
  return processes.has(id)
}

async function restart(id) {
  const entry = processes.get(id)
  if (!entry) return

  const { onLog, onStatus, onStats } = entry.callbacks

  await stop(id)
  await new Promise(resolve => setTimeout(resolve, 1000))

  const { getServer } = require('./db')
  const server = getServer(id)
  if (server) {
    start(server, { onLog, onStatus, onStats })
  }
}

module.exports = { start, stop, stopAll, restart, sendCommand, getStats, getLogs, isRunning }
