const fs = require('fs')
const path = require('path')

/**
 * Plugin manager for Paper/Spigot servers
 */
class PluginManager {
  constructor() {
    this.modrinthApi = 'https://api.modrinth.com/v2'
  }

  /**
   * Search plugins on Modrinth
   */
  async searchPlugins(query, limit = 20) {
    const https = require('https')
    const url = `${this.modrinthApi}/search?query=${encodeURIComponent(query)}&facets=[["project_type:plugin"]]&limit=${limit}`

    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'MCPanel/1.0' } }, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            const data = JSON.parse(body)
            resolve(data.hits.map(hit => ({
              id: hit.project_id,
              slug: hit.slug,
              name: hit.title,
              description: hit.description,
              downloads: hit.downloads,
              icon: hit.icon_url,
              author: hit.author,
              categories: hit.categories
            })))
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`))
          }
        })
      }).on('error', err => {
        reject(new Error(`Failed to search plugins: ${err.message}`))
      })
    })
  }

  /**
   * Get plugin versions
   */
  async getPluginVersions(pluginId, mcVersion) {
    const https = require('https')
    const url = `${this.modrinthApi}/project/${pluginId}/version?game_versions=["${mcVersion}"]`

    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'MCPanel/1.0' } }, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            const versions = JSON.parse(body)
            resolve(versions.map(v => ({
              id: v.id,
              name: v.name,
              versionNumber: v.version_number,
              mcVersions: v.game_versions,
              downloadUrl: v.files[0]?.url,
              fileName: v.files[0]?.filename,
              size: v.files[0]?.size
            })))
          } catch (e) {
            reject(new Error(`Failed to parse versions: ${e.message}`))
          }
        })
      }).on('error', err => {
        reject(new Error(`Failed to get versions: ${err.message}`))
      })
    })
  }

  /**
   * Download plugin
   */
  async downloadPlugin(downloadUrl, serverDir, onProgress) {
    const https = require('https')
    const pluginsDir = path.join(serverDir, 'plugins')
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true })
    }

    const fileName = path.basename(new URL(downloadUrl).pathname)
    const filePath = path.join(pluginsDir, fileName)

    return new Promise((resolve, reject) => {
      https.get(downloadUrl, { headers: { 'User-Agent': 'MCPanel/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`))
        }

        const total = parseInt(res.headers['content-length'] || '0')
        let downloaded = 0

        const fileStream = fs.createWriteStream(filePath)

        res.on('data', chunk => {
          downloaded += chunk.length
          fileStream.write(chunk)
          if (onProgress && total > 0) {
            onProgress(Math.round((downloaded / total) * 100))
          }
        })

        res.on('end', () => {
          fileStream.end()
          resolve(filePath)
        })

        res.on('error', err => {
          fileStream.destroy()
          try { fs.unlinkSync(filePath) } catch {}
          reject(err)
        })

        fileStream.on('error', err => {
          fileStream.destroy()
          try { fs.unlinkSync(filePath) } catch {}
          reject(err)
        })
      }).on('error', reject)
    })
  }

  /**
   * List installed plugins
   */
  listInstalledPlugins(serverDir) {
    const pluginsDir = path.join(serverDir, 'plugins')
    console.log('[PluginManager] Checking plugins in:', pluginsDir)
    console.log('[PluginManager] Directory exists:', fs.existsSync(pluginsDir))

    if (!fs.existsSync(pluginsDir)) {
      console.log('[PluginManager] Plugins directory does not exist')
      return []
    }

    const files = fs.readdirSync(pluginsDir)
    console.log('[PluginManager] Files in plugins dir:', files)

    const jarFiles = files.filter(f => f.endsWith('.jar'))
    console.log('[PluginManager] JAR files found:', jarFiles)

    return jarFiles.map(f => ({
      name: f,
      path: path.join(pluginsDir, f),
      size: fs.statSync(path.join(pluginsDir, f)).size
    }))
  }

  /**
   * Delete plugin
   */
  deletePlugin(pluginPath) {
    if (fs.existsSync(pluginPath)) {
      fs.unlinkSync(pluginPath)
    }
  }

  /**
   * Get plugin config files
   */
  getPluginConfigs(serverDir, pluginName) {
    const pluginsDir = path.join(serverDir, 'plugins')

    // Remove .jar extension if present
    let cleanName = pluginName.replace('.jar', '')

    // Try to extract plugin name from jar filename
    const commonPatterns = [
      { pattern: /^worldedit/i, folder: 'WorldEdit' },
      { pattern: /^worldguard/i, folder: 'WorldGuard' },
      { pattern: /^essentials/i, folder: 'Essentials' },
      { pattern: /^vault/i, folder: 'Vault' },
      { pattern: /^luckperms/i, folder: 'LuckPerms' },
    ]

    let pluginFolder = null

    // Try known patterns first
    for (const { pattern, folder } of commonPatterns) {
      if (pattern.test(cleanName)) {
        const testPath = path.join(pluginsDir, folder)
        if (fs.existsSync(testPath)) {
          pluginFolder = testPath
          break
        }
      }
    }

    // If not found, try the jar name without version
    if (!pluginFolder) {
      const baseName = cleanName.replace(/-bukkit|-spigot|-paper/i, '').replace(/-[\d.]+.*$/, '')
      const variations = [
        baseName,
        baseName.charAt(0).toUpperCase() + baseName.slice(1),
        baseName.toUpperCase(),
        baseName.toLowerCase()
      ]

      for (const variant of variations) {
        const testPath = path.join(pluginsDir, variant)
        if (fs.existsSync(testPath)) {
          pluginFolder = testPath
          break
        }
      }
    }

    // Last resort: use the full jar name without extension
    if (!pluginFolder) {
      pluginFolder = path.join(pluginsDir, cleanName)
    }

    console.log('[PluginManager] Looking for configs in:', pluginFolder)
    console.log('[PluginManager] Folder exists:', fs.existsSync(pluginFolder))

    if (!fs.existsSync(pluginFolder)) {
      console.log('[PluginManager] Plugin folder does not exist')
      return []
    }

    const configs = []
    const files = fs.readdirSync(pluginFolder)
    console.log('[PluginManager] Files in plugin folder:', files)

    for (const file of files) {
      const filePath = path.join(pluginFolder, file)
      const stat = fs.statSync(filePath)

      if (stat.isFile() && (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.properties') || file.endsWith('.json') || file.endsWith('.conf'))) {
        console.log('[PluginManager] Found config file:', file)
        configs.push({
          name: file,
          path: filePath,
          size: stat.size
        })
      }
    }

    console.log('[PluginManager] Total configs found:', configs.length)
    return configs
  }

  /**
   * Browse plugin folder (files and directories)
   */
  browsePluginFolder(folderPath) {
    if (!fs.existsSync(folderPath)) {
      return { files: [], folders: [] }
    }

    const items = fs.readdirSync(folderPath)
    const files = []
    const folders = []

    for (const item of items) {
      const itemPath = path.join(folderPath, item)
      const stat = fs.statSync(itemPath)

      if (stat.isDirectory()) {
        folders.push({
          name: item,
          path: itemPath
        })
      } else {
        files.push({
          name: item,
          path: itemPath,
          size: stat.size,
          isEditable: item.endsWith('.yml') || item.endsWith('.yaml') ||
                      item.endsWith('.properties') || item.endsWith('.json') ||
                      item.endsWith('.conf') || item.endsWith('.txt')
        })
      }
    }

    return { files, folders }
  }

  /**
   * Get plugin folder path
   */
  getPluginFolderPath(serverDir, pluginName) {
    const pluginsDir = path.join(serverDir, 'plugins')
    let cleanName = pluginName.replace('.jar', '')

    const commonPatterns = [
      { pattern: /^worldedit/i, folder: 'WorldEdit' },
      { pattern: /^worldguard/i, folder: 'WorldGuard' },
      { pattern: /^essentials/i, folder: 'Essentials' },
      { pattern: /^vault/i, folder: 'Vault' },
      { pattern: /^luckperms/i, folder: 'LuckPerms' },
    ]

    for (const { pattern, folder } of commonPatterns) {
      if (pattern.test(cleanName)) {
        const testPath = path.join(pluginsDir, folder)
        if (fs.existsSync(testPath)) {
          return testPath
        }
      }
    }

    const baseName = cleanName.replace(/-bukkit|-spigot|-paper/i, '').replace(/-[\d.]+.*$/, '')
    const variations = [
      baseName,
      baseName.charAt(0).toUpperCase() + baseName.slice(1),
      baseName.toUpperCase(),
      baseName.toLowerCase()
    ]

    for (const variant of variations) {
      const testPath = path.join(pluginsDir, variant)
      if (fs.existsSync(testPath)) {
        return testPath
      }
    }

    return path.join(pluginsDir, cleanName)
  }

  /**
   * Read config file
   */
  readConfig(configPath) {
    if (!fs.existsSync(configPath)) {
      throw new Error('Config file not found')
    }
    return fs.readFileSync(configPath, 'utf8')
  }

  /**
   * Write config file
   */
  writeConfig(configPath, content) {
    fs.writeFileSync(configPath, content, 'utf8')
  }
}

module.exports = PluginManager
