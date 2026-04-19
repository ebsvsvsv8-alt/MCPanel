const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mcpanel', {
  // Window
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  // Servers CRUD
  listServers:  ()     => ipcRenderer.invoke('servers:list'),
  createServer: (opts) => ipcRenderer.invoke('servers:create', opts),
  deleteServer: (id)   => ipcRenderer.invoke('servers:delete', id),
  openFolder:   (id)   => ipcRenderer.invoke('servers:openFolder', id),

  // Server control
  startServer:   (id)       => ipcRenderer.invoke('server:start', id),
  stopServer:    (id)       => ipcRenderer.invoke('server:stop', id),
  restartServer: (id)       => ipcRenderer.invoke('server:restart', id),
  sendCommand:   (id, cmd)  => ipcRenderer.invoke('server:command', { id, cmd }),
  getStats:      (id)       => ipcRenderer.invoke('server:stats', id),
  getLogs:       (id)       => ipcRenderer.invoke('server:logs', id),

  // Config
  getConfig:  (id)        => ipcRenderer.invoke('config:get', id),
  saveConfig: (id, props) => ipcRenderer.invoke('config:save', { id, props }),

  // Paper Config
  readPaperConfig:  (serverDir) => ipcRenderer.invoke('paper:read', serverDir),
  savePaperConfig:  (serverDir, content) => ipcRenderer.invoke('paper:save', { serverDir, content }),

  // Versions
  getCoreVersions: (core) => ipcRenderer.invoke('cores:versions', core),

  // Java
  getJavaStatus:  () => ipcRenderer.invoke('java:status'),
  openJavaFolder: () => ipcRenderer.invoke('java:openFolder'),

  // Backup
  createBackup:  (serverId, serverDir, worldName) => ipcRenderer.invoke('backup:create', { serverId, serverDir, worldName }),
  listBackups:   (serverId) => ipcRenderer.invoke('backup:list', serverId),
  restoreBackup: (backupPath, serverDir, worldName) => ipcRenderer.invoke('backup:restore', { backupPath, serverDir, worldName }),
  deleteBackup:  (backupPath) => ipcRenderer.invoke('backup:delete', backupPath),

  // Plugins
  searchPlugins:    (query) => ipcRenderer.invoke('plugin:search', query),
  getPluginVersions: (pluginId, mcVersion) => ipcRenderer.invoke('plugin:versions', { pluginId, mcVersion }),
  downloadPlugin:   (downloadUrl, serverDir) => ipcRenderer.invoke('plugin:download', { downloadUrl, serverDir }),
  uploadPlugin:     (serverDir, filePath) => ipcRenderer.invoke('plugin:upload', { serverDir, filePath }),
  listPlugins:      (serverDir) => ipcRenderer.invoke('plugin:list', serverDir),
  deletePlugin:     (pluginPath) => ipcRenderer.invoke('plugin:delete', pluginPath),
  getPluginConfigs: (serverDir, pluginName) => ipcRenderer.invoke('plugin:getConfigs', { serverDir, pluginName }),
  browsePluginFolder: (folderPath) => ipcRenderer.invoke('plugin:browseFolder', folderPath),
  getPluginFolderPath: (serverDir, pluginName) => ipcRenderer.invoke('plugin:getFolderPath', { serverDir, pluginName }),
  readPluginConfig: (configPath) => ipcRenderer.invoke('plugin:readConfig', configPath),
  writePluginConfig: (configPath, content) => ipcRenderer.invoke('plugin:writeConfig', { configPath, content }),

  // TCP Agent
  getTcpAgentStatus:    ()     => ipcRenderer.invoke('tcp:agent:status'),
  downloadTcpAgent:     ()     => ipcRenderer.invoke('tcp:agent:download'),
  downloadVelocityJar:  (dir,cb) => ipcRenderer.invoke('tcp:agent:downloadVelocity', dir, cb),
  testTcpConnection:    (opts) => ipcRenderer.invoke('tcp:agent:test', opts),

  // Events
  onLog:              (id, cb) => {
    const channel = `log:${id}`
    console.log('[Preload] onLog subscribed for channel:', channel)
    const handler = (_, l) => {
      console.log('[Preload] Received log event for', id, ':', l)
      cb(l)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      console.log('[Preload] onLog unsubscribed for channel:', channel)
      ipcRenderer.removeListener(channel, handler)
    }
  },
  onStats:            (id, cb) => {
    const handler = (_, s) => cb(s)
    ipcRenderer.on(`stats:${id}`, handler)
    return () => ipcRenderer.removeListener(`stats:${id}`, handler)
  },
  onServerStatus:     (cb)     => {
    const handler = (_, d) => cb(d)
    ipcRenderer.on('server:status', handler)
    return () => ipcRenderer.removeListener('server:status', handler)
  },
  onDownloadProgress: (cb)     => {
    const handler = (_, d) => cb(d)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },

  // Java preinstall events (fired on app startup)
  onJavaPreinstallProgress: (cb) => {
    const handler = (_, d) => cb(d)
    ipcRenderer.on('java:preinstall:progress', handler)
    return () => ipcRenderer.removeListener('java:preinstall:progress', handler)
  },
  onJavaPreinstallDone:     (cb) => {
    const handler = (_, d) => cb(d)
    ipcRenderer.on('java:preinstall:done', handler)
    return () => ipcRenderer.removeListener('java:preinstall:done', handler)
  },
})
