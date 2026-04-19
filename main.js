const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')

// Set UTF-8 encoding for console output
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' })
  } catch (e) {
    console.log('[MCPanel] Could not set UTF-8 encoding')
  }
}

const { spawn } = require('child_process')
const coreDownloader = require('./src/coreDownloader')
const BackupManager = require('./src/backupManager')
const PluginManager = require('./src/pluginManager')

let mainWindow
let dbReady = false
let backupManager
let pluginManager

// Initialize database
const db = require('./src/db')
db.initDb().then(() => {
  dbReady = true
  console.log('[MCPanel] Database initialized')

  // Initialize managers
  backupManager = new BackupManager(app.getPath('userData'))
  pluginManager = new PluginManager()
  console.log('[MCPanel] Managers initialized')
}).catch(err => {
  console.error('[MCPanel] Database init failed:', err)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'icon.png'),
    frame: false,
    backgroundColor: '#0a0a0c'
  })

  mainWindow.loadFile('public/index.html')
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  // Stop all running servers before quit
  const processManager = require('./src/processManager')
  await processManager.stopAll()
})

// ── Window controls ───────────────────────────────────────────────
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close()
})

// ── IPC Handlers ──────────────────────────────────────────────────
ipcMain.handle('servers:list', async () => {
  if (!dbReady) throw new Error('Database not ready')
  const { getServers } = require('./src/db')
  return getServers()
})

ipcMain.handle('servers:create', async (e, opts) => {
  const { createServer } = require('./src/db')
  const { v4: uuidv4 } = require('uuid')

  // Generate unique ID and ensure directory doesn't exist
  let id = uuidv4()
  let serversDir = path.join(app.getPath('userData'), 'servers', id)
  let attempts = 0

  while (fs.existsSync(serversDir) && attempts < 10) {
    // If directory exists, generate new UUID
    id = uuidv4()
    serversDir = path.join(app.getPath('userData'), 'servers', id)
    attempts++
  }

  if (fs.existsSync(serversDir)) {
    throw new Error('Не удалось создать уникальную директорию для сервера. Попробуйте перезапустить приложение.')
  }

  fs.mkdirSync(serversDir, { recursive: true })

  // Download server jar
  if (opts.core === 'velocity') {
    // Velocity - copy from project folder as Velocity.jar
    const srcJar = path.join(__dirname, 'Velocity.jar')
    if (!fs.existsSync(srcJar)) {
      try {
        fs.rmSync(serversDir, { recursive: true, force: true })
      } catch (cleanupErr) {
        console.warn('[MCPanel] Could not cleanup directory:', cleanupErr.message)
      }
      throw new Error('Velocity.jar не найден в папке проекта! Положите файл Velocity.jar в корень MCPanel')
    }
    fs.copyFileSync(srcJar, path.join(serversDir, 'Velocity.jar'))
  } else {
    mainWindow.webContents.send('download:progress', { id, status: 'downloading', message: `Скачиваем ${opts.core} ${opts.version}...`, percent: 0 })
    try {
      await coreDownloader.download({
        core: opts.core,
        version: opts.version,
        destDir: serversDir,
        onProgress: (percent, message) => {
          mainWindow.webContents.send('download:progress', { id, status: 'downloading', percent, message })
        }
      })
    } catch (err) {
      try {
        fs.rmSync(serversDir, { recursive: true, force: true })
      } catch (cleanupErr) {
        console.warn('[MCPanel] Could not cleanup directory:', cleanupErr.message)
      }
      let msg = `Не удалось скачать ${opts.core} ${opts.version}. `
      if (err.message.includes('404')) {
        if (opts.core === 'paper') msg += 'Попробуй другую версию (например: 1.21.4, 1.21.1, 1.20.6)'
        else if (opts.core === 'velocity') msg += 'Попробуй 3.4.0 или 3.3.0'
        else msg += 'Try another version (for example: 1.21.4, 1.20.4, 1.19.4)'
      } else {
        msg += err.message
      }
      throw new Error(msg)
    }
  }

  // Write server.properties and eula
  if (opts.core === 'velocity') {
    const tomlPath = path.join(serversDir, 'velocity.toml')
    if (fs.existsSync(tomlPath)) fs.rmSync(tomlPath, { force: true })
    fs.writeFileSync(tomlPath, buildVelocityToml(opts), 'utf8')
    // Create forwarding.secret file
    fs.writeFileSync(path.join(serversDir, 'forwarding.secret'), 'change-me-' + Math.random().toString(36).substring(7), 'utf8')
  } else {
    const props = buildServerProperties(opts)
    fs.writeFileSync(path.join(serversDir, 'server.properties'), props, 'utf8')
    fs.writeFileSync(path.join(serversDir, 'eula.txt'), 'eula=true\n', 'utf8')
  }

  const server = createServer({ id, ...opts, dir: serversDir })
  mainWindow.webContents.send('download:progress', { id, status: 'ready', message: 'Сервер готов!', percent: 100 })
  return server
})

// ── Server control ────────────────────────────────────────────────
ipcMain.handle('server:start', async (e, id) => {
  console.log('[Main] server:start called for id:', id)
  const { getServer } = require('./src/db')
  const server = getServer(id)
  console.log('[Main] Found server:', server)
  if (!server) throw new Error('Сервер не найден')
  const processManager = require('./src/processManager')
  console.log('[Main] Calling processManager.start...')
  const result = await processManager.start(server, {
    onLog: (line) => {
      console.log('[Main] Log:', line)
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        console.log('[Main] Sending log to renderer:', `log:${id}`)
        try {
          mainWindow.webContents.send(`log:${id}`, line)
          console.log('[Main] Log sent successfully')
        } catch (err) {
          console.error('[Main] Error sending log:', err)
        }
      } else {
        console.error('[Main] mainWindow is null, destroyed, or webContents unavailable!')
      }
    },
    onStats: (stats) => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(`stats:${id}`, stats)
      }
    },
    onStatus: (status) => {
      console.log('[Main] Status changed to:', status, 'for server:', id)
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        console.log('[Main] Sending status events')
        mainWindow.webContents.send(`status:${id}`, status)
        mainWindow.webContents.send('server:status', { id, status })
      }
    }
  })
  console.log('[Main] processManager.start result:', result)
  return result
})

// ── Backup management ─────────────────────────────────────────
ipcMain.handle('backup:create', async (e, { serverId, serverDir, worldName }) => {
  if (!backupManager) throw new Error('Backup manager not initialized')
  return await backupManager.createBackup(serverId, serverDir, worldName)
})

ipcMain.handle('backup:list', async (e, serverId) => {
  if (!backupManager) throw new Error('Backup manager not initialized')
  return backupManager.listBackups(serverId)
})

ipcMain.handle('backup:restore', async (e, { backupPath, serverDir, worldName }) => {
  if (!backupManager) throw new Error('Backup manager not initialized')
  return await backupManager.restoreBackup(backupPath, serverDir, worldName)
})

ipcMain.handle('backup:delete', async (e, backupPath) => {
  if (!backupManager) throw new Error('Backup manager not initialized')
  backupManager.deleteBackup(backupPath)
  return true
})

// ── Plugin management ─────────────────────────────────────────
ipcMain.handle('plugin:search', async (e, query) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return await pluginManager.searchPlugins(query)
})

ipcMain.handle('plugin:versions', async (e, { pluginId, mcVersion }) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return await pluginManager.getPluginVersions(pluginId, mcVersion)
})

ipcMain.handle('plugin:download', async (e, { downloadUrl, serverDir }) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return await pluginManager.downloadPlugin(downloadUrl, serverDir, (pct) => {
    mainWindow.webContents.send('plugin:downloadProgress', pct)
  })
})

ipcMain.handle('plugin:upload', async (e, { serverDir, filePath }) => {
  const pluginsDir = path.join(serverDir, 'plugins')
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true })
  }

  const fileName = path.basename(filePath)
  const destPath = path.join(pluginsDir, fileName)

  try {
    fs.copyFileSync(filePath, destPath)
    return destPath
  } catch (err) {
    throw new Error(`Failed to copy plugin: ${err.message}`)
  }
})

ipcMain.handle('plugin:list', async (e, serverDir) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return pluginManager.listInstalledPlugins(serverDir)
})

ipcMain.handle('plugin:delete', async (e, pluginPath) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  pluginManager.deletePlugin(pluginPath)
  return true
})

ipcMain.handle('plugin:getConfigs', async (e, { serverDir, pluginName }) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return pluginManager.getPluginConfigs(serverDir, pluginName)
})

ipcMain.handle('plugin:browseFolder', async (e, folderPath) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return pluginManager.browsePluginFolder(folderPath)
})

ipcMain.handle('plugin:getFolderPath', async (e, { serverDir, pluginName }) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return pluginManager.getPluginFolderPath(serverDir, pluginName)
})

ipcMain.handle('plugin:readConfig', async (e, configPath) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  return pluginManager.readConfig(configPath)
})

ipcMain.handle('plugin:writeConfig', async (e, { configPath, content }) => {
  if (!pluginManager) throw new Error('Plugin manager not initialized')
  pluginManager.writeConfig(configPath, content)
  return true
})

ipcMain.handle('server:stop', async (e, id) => {
  const processManager = require('./src/processManager')
  return await processManager.stop(id)
})

ipcMain.handle('server:restart', async (e, id) => {
  const processManager = require('./src/processManager')
  return await processManager.restart(id)
})

ipcMain.handle('server:command', async (e, { id, cmd }) => {
  const processManager = require('./src/processManager')
  return await processManager.sendCommand(id, cmd)
})

ipcMain.handle('server:stats', async (e, id) => {
  const processManager = require('./src/processManager')
  return processManager.getStats(id) || { cpu: 0, ram: 0, players: 0, uptime: 0 }
})

ipcMain.handle('server:logs', async (e, id) => {
  const processManager = require('./src/processManager')
  const { getServer } = require('./src/db')

  // If server is running, return logs from memory
  if (processManager.isRunning(id)) {
    return processManager.getLogs(id)
  }

  // If server is stopped, load from file
  const server = getServer(id)
  if (!server) return []

  const logFile = path.join(server.dir, 'console.log')
  if (!fs.existsSync(logFile)) return []

  try {
    const content = fs.readFileSync(logFile, 'utf8')
    const lines = content.split('\n').filter(l => l.trim())
    return lines.slice(-1000) // Last 1000 lines
  } catch (e) {
    console.error('[MCPanel] Failed to read logs:', e)
    return []
  }
})

// ── Server management ─────────────────────────────────────────────
ipcMain.handle('servers:delete', async (e, id) => {
  const { getServer, deleteServer } = require('./src/db')
  const server = getServer(id)
  if (!server) throw new Error('Сервер не найден')

  const processManager = require('./src/processManager')
  if (processManager.isRunning(id)) {
    await processManager.stop(id)
    // Wait a bit for process to fully stop
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  try {
    if (fs.existsSync(server.dir)) {
      fs.rmSync(server.dir, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('[MCPanel] Failed to delete server directory:', err)
    // Continue anyway to remove from DB
  }

  deleteServer(id)
  return true
})

ipcMain.handle('servers:openFolder', async (e, id) => {
  const { getServer } = require('./src/db')
  const server = getServer(id)
  if (!server) throw new Error('Сервер не найден')
  shell.openPath(server.dir)
  return true
})

// ── Core versions ───────────────────────────────────────────────────
ipcMain.handle('cores:versions', async (e, core) => {
  const coreDownloader = require('./src/coreDownloader')
  return await coreDownloader.getVersions(core)
})

// ── Config management ─────────────────────────────────────────────
ipcMain.handle('config:get', async (e, id) => {
  const { getServer } = require('./src/db')
  const server = getServer(id)
  if (!server) return null
  const propsPath = path.join(server.dir, server.core === 'velocity' ? 'velocity.toml' : 'server.properties')
  if (!fs.existsSync(propsPath)) return {}
  const content = fs.readFileSync(propsPath, 'utf8')
  const config = server.core === 'velocity' ? parseVelocityToml(content) : parseServerProperties(content)

  // For Velocity, read forwarding secret
  if (server.core === 'velocity') {
    const secretPath = path.join(server.dir, 'forwarding.secret')
    if (fs.existsSync(secretPath)) {
      config['forwarding-secret'] = fs.readFileSync(secretPath, 'utf8').trim()
    }
  }

  return config
})

ipcMain.handle('config:save', async (e, { id, props }) => {
  const { getServer, updateServer } = require('./src/db')
  const server = getServer(id)
  if (!server) throw new Error('Сервер не найден')

  // Validate port
  const newPort = parseInt(props['server-port'] || props['bind']?.split(':')[1] || server.port)
  if (newPort < 1 || newPort > 65535) throw new Error(`Порт должен быть от 1 до 65535 (указан: ${newPort})`)

  const propsPath = path.join(server.dir, server.core === 'velocity' ? 'velocity.toml' : 'server.properties')
  const newContent = server.core === 'velocity'
    ? buildVelocityTomlFromProps(props, server)
    : buildServerPropertiesFromProps(props, server)

  fs.writeFileSync(propsPath, newContent, 'utf8')

  // For Velocity, save forwarding secret to file
  if (server.core === 'velocity' && props['forwarding-secret']) {
    const secretPath = path.join(server.dir, 'forwarding.secret')
    fs.writeFileSync(secretPath, props['forwarding-secret'], 'utf8')
  }

  // Update server object
  if (server.core === 'velocity') {
    const bindMatch = (props['bind'] || '').match(/:(\d+)$/)
    const port = bindMatch ? parseInt(bindMatch[1]) : server.port
    const max = parseInt(props['show-max-players']) || server.maxPlayers
    const name = props['motd'] || server.name
    server.port = port; server.maxPlayers = max; server.name = name
  } else {
    const port = parseInt(props['server-port']) || server.port
    const max = parseInt(props['max-players']) || server.maxPlayers
    const name = props['server-name'] || server.name
    server.port = port; server.maxPlayers = max; server.name = name
  }
  updateServer(id, { port: server.port, maxPlayers: server.maxPlayers, name: server.name })
  return true
})

// ── Paper Config ──────────────────────────────────────────────────
ipcMain.handle('paper:read', async (e, serverDir) => {
  // Try new location first (1.19+)
  let paperPath = path.join(serverDir, 'config', 'paper-global.yml')
  if (!fs.existsSync(paperPath)) {
    // Try old location (1.18 and below)
    paperPath = path.join(serverDir, 'paper.yml')
    if (!fs.existsSync(paperPath)) {
      return Promise.reject(new Error('paper.yml not found. Make sure this is a Paper server and it has been started at least once.'))
    }
  }
  return fs.readFileSync(paperPath, 'utf8')
})

ipcMain.handle('paper:save', async (e, { serverDir, content }) => {
  // Try new location first (1.19+)
  let paperPath = path.join(serverDir, 'config', 'paper-global.yml')
  if (!fs.existsSync(paperPath)) {
    // Try old location (1.18 and below)
    paperPath = path.join(serverDir, 'paper.yml')
  }

  fs.writeFileSync(paperPath, content, 'utf8')
  return true
})

// ── Java management ───────────────────────────────────────────────
ipcMain.handle('java:status', async () => {
  const coreDownloader = require('./src/coreDownloader')
  const status = {}
  for (const ver of coreDownloader.JAVA_VERSIONS) {
    status[ver] = coreDownloader.isJavaReady(ver)
  }
  return status
})

ipcMain.handle('java:openFolder', async () => {
  const coreDownloader = require('./src/coreDownloader')
  const javaDir = coreDownloader.getJavaBaseDir()
  if (fs.existsSync(javaDir)) {
    shell.openPath(javaDir)
  } else {
    throw new Error('Папка Java не найдена')
  }
  return true
})

// ── TCP Agent ─────────────────────────────────────────────────────
ipcMain.handle('tcp:agent:status', async () => {
  // Check if TCP agent is available (placeholder)
  return { available: false }
})

ipcMain.handle('tcp:agent:download', async () => {
  // Download TCP agent (placeholder)
  throw new Error('TCP Agent download not implemented')
})

ipcMain.handle('tcp:agent:downloadVelocity', async (e, dir, cb) => {
  const tcpTester = require('./src/tcpTester')
  await tcpTester.downloadVelocityJar(dir, (pct) => {
    mainWindow.webContents.send('tcp:agent:downloadProgress', pct)
  })
  return true
})

ipcMain.handle('tcp:agent:test', async (e, opts) => {
  const tcpTester = require('./src/tcpTester')
  return await tcpTester.testTcpConnection(opts)
})

// ── Config builders ───────────────────────────────────────────────
function buildServerPropertiesFromProps(props, server) {
  const defaults = {
    'server-port': server.port,
    'max-players': server.maxPlayers,
    'server-name': server.name,
    'gamemode': 'survival',
    'difficulty': 'normal',
    'motd': server.name,
    'online-mode': 'true',
    'enable-query': 'false',
    'enable-rcon': 'false',
    'level-name': 'world',
    'view-distance': '10',
    'simulation-distance': '8',
    'white-list': 'false',
    'pvp': 'true',
    'allow-flight': 'false',
    'spawn-monsters': 'true',
    'spawn-npcs': 'true',
    'generate-structures': 'true',
    'max-world-size': '29999984',
    'network-compression-threshold': '256',
    'resource-pack-shapeless-recipes': 'false',
    'function-permission-level': '2',
    'enforce-secure-profile': 'true',
    'hide-online-players': 'false',
    ...props
  }
  return Object.entries(defaults).map(([k, v]) => `${k}=${v}`).join('\n')
}

function buildVelocityTomlFromProps(props, server) {
  // Parse servers JSON if provided
  let serversSection = 'lobby = "127.0.0.1:25565"'
  if (props['servers']) {
    try {
      const serversObj = JSON.parse(props['servers'])
      serversSection = Object.entries(serversObj)
        .map(([name, addr]) => `${name} = "${addr}"`)
        .join('\n')
    } catch (e) {
      console.error('[MCPanel] Failed to parse servers JSON:', e)
    }
  }

  // Parse try order if provided
  let tryOrder = '["lobby"]'
  if (props['try']) {
    const tryArray = props['try'].split(',').map(s => s.trim()).filter(s => s)
    tryOrder = '[\n    "' + tryArray.join('",\n    "') + '"\n]'
  }

  const port = parseInt(props['bind']?.split(':')[1]) || server.port
  const motd = props['motd'] || `<#09add3>${server.name}`
  const maxPlayers = parseInt(props['show-max-players']) || server.maxPlayers

  return `# Config version. Do not change this
config-version = "2.7"

# What port should the proxy be bound to? By default, we'll bind to all addresses on port 25565.
bind = "0.0.0.0:${port}"

# What should be the MOTD? This gets displayed when the player adds your server to
# their server list. Only MiniMessage format is accepted.
motd = "${motd}"

# What should we display for the maximum number of players?
show-max-players = ${maxPlayers}

# Should we authenticate players with Mojang? By default, this is on.
online-mode = ${props['online-mode'] || 'true'}

# Should the proxy enforce the new public key security standard? By default, this is on.
force-key-authentication = ${props['force-key-authentication'] || 'true'}

# If client's ISP/AS sent from this proxy is different from the one from Mojang's
# authentication server, the player is kicked. This disallows some VPN and proxy
# connections but is a weak form of protection.
prevent-client-proxy-connections = ${props['prevent-client-proxy-connections'] || 'false'}

# Should we forward IP addresses and other data to backend servers?
player-info-forwarding-mode = "${props['player-info-forwarding-mode'] || 'NONE'}"

# If you are using modern or BungeeGuard IP forwarding, configure a file that contains a unique secret here.
forwarding-secret-file = "forwarding.secret"

# Announce whether or not your server supports Forge.
announce-forge = ${props['announce-forge'] || 'false'}

# If enabled (default is false) and the proxy is in online mode, Velocity will kick
# any existing player who is online if a duplicate connection attempt is made.
kick-existing-players = ${props['kick-existing-players'] || 'false'}

# Should Velocity pass server list ping requests to a backend server?
ping-passthrough = "${props['ping-passthrough'] || 'DISABLED'}"

# If enabled (default is true) player IP addresses will be replaced by <ip address withheld> in logs
enable-player-address-logging = ${props['enable-player-address-logging'] || 'true'}

[servers]
# Configure your servers here. Each key represents the server's name, and the value
# represents the IP address of the server to connect to.
${serversSection}

# In what order we should try servers when a player logs in or is kicked from a server.
try = ${tryOrder}

[forced-hosts]
# Configure your forced hosts here.

[advanced]
# How large a Minecraft packet has to be before we compress it. Setting this to zero will
# compress all packets, and setting it to -1 will disable compression entirely.
compression-threshold = ${props['compression-threshold'] || '256'}

# How much compression should be done (from 0-9). The default is -1, which uses the
# default level of 6.
compression-level = ${props['compression-level'] || '-1'}

# How fast (in milliseconds) are clients allowed to connect after the last connection? By
# default, this is three seconds. Disable this by setting this to 0.
login-ratelimit = ${props['login-ratelimit'] || '3000'}

# Specify a custom timeout for connection timeouts here. The default is five seconds.
connection-timeout = ${props['connection-timeout'] || '5000'}

# Specify a read timeout for connections here. The default is 30 seconds.
read-timeout = ${props['read-timeout'] || '30000'}

# Enables compatibility with HAProxy's PROXY protocol. If you don't know what this is for, then
# don't enable it.
haproxy-protocol = false

# Enables TCP fast open support on the proxy. Requires the proxy to run on Linux.
tcp-fast-open = false

# Enables BungeeCord plugin messaging channel support on Velocity.
bungee-plugin-message-channel = true

# Shows ping requests to the proxy from clients.
show-ping-requests = false

# By default, Velocity will attempt to gracefully handle situations where the user unexpectedly
# loses connection to the server without an explicit disconnect message by attempting to fall the
# user back, except in the case of read timeouts. BungeeCord will disconnect the user instead.
failover-on-unexpected-server-disconnect = true

# Declares the proxy commands to 1.13+ clients.
announce-proxy-commands = true

# Enables logging of command executions
log-command-executions = false

# Enables logging of player connections when connecting to the proxy, switching servers
# and disconnecting from the proxy.
log-player-connections = true

[query]
# Whether to enable responding to GameSpy 4 query responses or not.
enabled = false

# If enabled, on what port should the query protocol listen on?
port = ${port}

# This is the map name that is reported to the query services.
map = "Velocity"

# Whether plugins should be shown in query response by default or not
show-plugins = false
`
}

// ── Property builders (for initial server creation) ───────────────
function buildServerProperties(opts) {
  return [
    `server-port=${opts.port || 25565}`,
    `max-players=${opts.maxPlayers || 20}`,
    `server-name=${opts.name || 'MCPanel Server'}`,
    `gamemode=${opts.gamemode || 'survival'}`,
    `difficulty=${opts.difficulty || 'normal'}`,
    `motd=${opts.name || 'MCPanel Server'}`,
    `online-mode=true`,
    `enable-query=false`,
    `enable-rcon=false`,
    `level-name=world`,
    `view-distance=10`,
    `simulation-distance=8`,
    `white-list=false`,
    `pvp=true`,
    `allow-flight=false`,
    `spawn-monsters=true`,
    `spawn-npcs=true`,
    `generate-structures=true`,
    `max-world-size=29999984`,
    `network-compression-threshold=256`,
    `resource-pack-shapeless-recipes=false`,
    `function-permission-level=2`,
    `enforce-secure-profile=true`,
    `hide-online-players=false`
  ].join('\n')
}

function buildVelocityToml(opts) {
  return `# Config version. Do not change this
config-version = "2.7"

# What port should the proxy be bound to? By default, we'll bind to all addresses on port 25565.
bind = "0.0.0.0:${opts.port || 25565}"

# What should be the MOTD? This gets displayed when the player adds your server to
# their server list. Only MiniMessage format is accepted.
motd = "<#09add3>${opts.name || 'Мой сервер'}"

# What should we display for the maximum number of players?
show-max-players = ${opts.maxPlayers || 20}

# Should we authenticate players with Mojang? By default, this is on.
online-mode = true

# Should the proxy enforce the new public key security standard? By default, this is on.
force-key-authentication = true

# If client's ISP/AS sent from this proxy is different from the one from Mojang's
# authentication server, the player is kicked. This disallows some VPN and proxy
# connections but is a weak form of protection.
prevent-client-proxy-connections = false

# Should we forward IP addresses and other data to backend servers?
# Available options:
# - "none":        No forwarding will be done. All players will appear to be connecting
#                  from the proxy and will have offline-mode UUIDs.
# - "legacy":      Forward player IPs and UUIDs in a BungeeCord-compatible format. Use this
#                  if you run servers using Minecraft 1.12 or lower.
# - "bungeeguard": Forward player IPs and UUIDs in a format supported by the BungeeGuard
#                  plugin. Use this if you run servers using Minecraft 1.12 or lower, and are
#                  unable to implement network level firewalling (on a shared host).
# - "modern":      Forward player IPs and UUIDs as part of the login process using
#                  Velocity's native forwarding. Only applicable for Minecraft 1.13 or higher.
player-info-forwarding-mode = "NONE"

# If you are using modern or BungeeGuard IP forwarding, configure a file that contains a unique secret here.
# The file is expected to be UTF-8 encoded and not empty.
forwarding-secret-file = "forwarding.secret"

# Announce whether or not your server supports Forge.
announce-forge = false

# If enabled (default is false) and the proxy is in online mode, Velocity will kick
# any existing player who is online if a duplicate connection attempt is made.
kick-existing-players = false

# Should Velocity pass server list ping requests to a backend server?
# Available options:
# - "disable":     No pass-through will be done. The velocity.toml and server-icon.png
#                  will determine the initial server list ping response.
# - "mods":        Passes only the mod list from your backend server into the response.
#                  The first server in your try list (or forced host) with a mod list will be
#                  used. If no backend servers can be contacted, Velocity won't display any
#                  mod information.
# - "description": Uses the description and mod list from the backend server. The first
#                  server in the try (or forced host) list that responds is used for the
#                  description and mod list.
# - "all":         Uses the backend server's response as the proxy response. The Velocity
#                  configuration is used if no servers could be contacted.
ping-passthrough = "DISABLED"

# If enabled (default is true) player IP addresses will be replaced by <ip address withheld> in logs
enable-player-address-logging = true

[servers]
# Configure your servers here. Each key represents the server's name, and the value
# represents the IP address of the server to connect to.
lobby = "127.0.0.1:25565"

# In what order we should try servers when a player logs in or is kicked from a server.
try = [
    "lobby"
]

[forced-hosts]
# Configure your forced hosts here.

[advanced]
# How large a Minecraft packet has to be before we compress it. Setting this to zero will
# compress all packets, and setting it to -1 will disable compression entirely.
compression-threshold = 256

# How much compression should be done (from 0-9). The default is -1, which uses the
# default level of 6.
compression-level = -1

# How fast (in milliseconds) are clients allowed to connect after the last connection? By
# default, this is three seconds. Disable this by setting this to 0.
login-ratelimit = 3000

# Specify a custom timeout for connection timeouts here. The default is five seconds.
connection-timeout = 5000

# Specify a read timeout for connections here. The default is 30 seconds.
read-timeout = 30000

# Enables compatibility with HAProxy's PROXY protocol. If you don't know what this is for, then
# don't enable it.
haproxy-protocol = false

# Enables TCP fast open support on the proxy. Requires the proxy to run on Linux.
tcp-fast-open = false

# Enables BungeeCord plugin messaging channel support on Velocity.
bungee-plugin-message-channel = true

# Shows ping requests to the proxy from clients.
show-ping-requests = false

# By default, Velocity will attempt to gracefully handle situations where the user unexpectedly
# loses connection to the server without an explicit disconnect message by attempting to fall the
# user back, except in the case of read timeouts. BungeeCord will disconnect the user instead.
failover-on-unexpected-server-disconnect = true

# Declares the proxy commands to 1.13+ clients.
announce-proxy-commands = true

# Enables logging of command executions
log-command-executions = false

# Enables logging of player connections when connecting to the proxy, switching servers
# and disconnecting from the proxy.
log-player-connections = true

[query]
# Whether to enable responding to GameSpy 4 query responses or not.
enabled = false

# If enabled, on what port should the query protocol listen on?
port = ${opts.port || 25565}

# This is the map name that is reported to the query services.
map = "Velocity"

# Whether plugins should be shown in query response by default or not
show-plugins = false
`
}

// ── Property parsers ──────────────────────────────────────────────
function parseServerProperties(text) {
  const result = {}
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue
    const [key, ...val] = line.split('=')
    result[key.trim()] = val.join('=').trim()
  }
  return result
}

function parseVelocityToml(text) {
  const result = {}
  const lines = text.split('\n')
  let inServersSection = false
  let inForcedHostsSection = false
  let serversObj = {}
  let tryArray = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Check for sections
    if (line === '[servers]') {
      inServersSection = true
      inForcedHostsSection = false
      continue
    } else if (line === '[forced-hosts]') {
      inServersSection = false
      inForcedHostsSection = true
      continue
    } else if (line.startsWith('[')) {
      inServersSection = false
      inForcedHostsSection = false
      continue
    }

    if (line.startsWith('#') || !line.includes('=')) continue

    const eq = line.indexOf('=')
    const key = line.substring(0, eq).trim()
    let val = line.substring(eq + 1).trim()

    // Remove quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }

    // Parse try array in servers section
    if (inServersSection && key === 'try') {
      // Parse array format: try = ["lobby", "survival"]
      const match = val.match(/\[(.*)\]/)
      if (match) {
        tryArray = match[1].split(',').map(s => s.trim().replace(/['"]/g, ''))
      }
      continue
    }

    // Parse servers in servers section
    if (inServersSection) {
      serversObj[key] = val
      continue
    }

    result[key] = val
  }

  // Add servers as JSON string
  if (Object.keys(serversObj).length > 0) {
    result['servers'] = JSON.stringify(serversObj, null, 2)
  }

  // Add try as comma-separated string
  if (tryArray.length > 0) {
    result['try'] = tryArray.join(',')
  }

  return result
}