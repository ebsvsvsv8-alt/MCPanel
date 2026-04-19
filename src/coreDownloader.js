const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { app } = require('electron')

// ── Java versions we pre-install ──────────────────────────────
const JAVA_VERSIONS = [8, 17, 21]

// Which Java a MC version needs
function getRequiredJava(mcVersion) {
  // Non-versioned cores always need Java 21
  if (!mcVersion || !mcVersion.includes('.')) return 21
  const minor = parseInt(mcVersion.split('.')[1], 10)
  if (isNaN(minor)) return 21
  if (minor >= 21) return 21
  if (minor >= 17) return 17
  return 8
}

// ── Paths ─────────────────────────────────────────────────────

// Bundled java: <project root>/<version>/bin/java.exe  (e.g. 17/bin/java.exe)
function getBundledJavaExe(javaVersion) {
  // Try multiple root candidates: __dirname/../, process.cwd(), app.getAppPath()
  const candidates = [
    path.join(__dirname, '..'),
    process.cwd(),
    app.getAppPath(),
  ]
  for (const root of candidates) {
    const base = path.join(root, String(javaVersion))
    const winExe = path.join(base, 'bin', 'java.exe')
    console.log(`[MCPanel] Checking bundled Java ${javaVersion} at: ${winExe}`)
    if (fs.existsSync(winExe)) {
      console.log(`[MCPanel] Found bundled Java ${javaVersion} at ${winExe}`)
      return winExe
    }
    const unixExe = path.join(base, 'bin', 'java')
    if (fs.existsSync(unixExe)) {
      console.log(`[MCPanel] Found bundled Java ${javaVersion} (unix) at ${unixExe}`)
      return unixExe
    }
  }
  console.log(`[MCPanel] Bundled Java ${javaVersion} not found in any candidate root`)
  return null
}

function getJavaBaseDir() {
  return path.join(app.getPath('userData'), 'java')
}

function getJavaInstallDir(javaVersion) {
  return path.join(getJavaBaseDir(), `jdk-${javaVersion}`)
}

function getJavaExe(javaVersion) {
  // 1. Bundled java in project root (8/, 17/, 21/)
  const bundled = getBundledJavaExe(javaVersion)
  if (bundled) return bundled

  // 2. Downloaded java in userData
  const base = getJavaInstallDir(javaVersion)
  const winExe = path.join(base, 'bin', 'java.exe')
  if (fs.existsSync(winExe)) return winExe
  const unixExe = path.join(base, 'bin', 'java')
  if (fs.existsSync(unixExe)) return unixExe
  return null
}

function isJavaReady(javaVersion) {
  return getJavaExe(javaVersion) !== null
}

// ── Java download URL (Adoptium Temurin) ──────────────────────
function getAdoptiumUrl(javaVersion) {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  // Use direct release asset URL pattern which doesn't redirect as much
  return `https://api.adoptium.net/v3/binary/latest/${javaVersion}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`
}

// ── Download a single Java version ───────────────────────────
// Returns the exe path when done. Safe to call if already installed.
async function downloadJava(javaVersion, onProgress) {
  if (isJavaReady(javaVersion)) {
    onProgress && onProgress(100, `Java ${javaVersion} уже установлена`)
    return getJavaExe(javaVersion)
  }

  const isWindows = process.platform === 'win32'
  const baseDir = getJavaBaseDir()
  const installDir = getJavaInstallDir(javaVersion)
  const archiveExt = isWindows ? 'zip' : 'tar.gz'
  const archivePath = path.join(baseDir, `jdk-${javaVersion}.${archiveExt}`)
  const lockPath = archivePath + '.lock'

  fs.mkdirSync(baseDir, { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })

  // Delete archive if it exists but is suspiciously small (corrupted/partial download)
  const MIN_ARCHIVE_SIZE = 10 * 1024 * 1024 // 10 MB minimum — a real JDK zip is ~100+ MB
  if (fs.existsSync(archivePath)) {
    const stat = fs.statSync(archivePath)
    if (stat.size < MIN_ARCHIVE_SIZE) {
      console.log(`[MCPanel] Архив Java ${javaVersion} повреждён или неполный (${stat.size} байт), удаляем...`)
      try { fs.unlinkSync(archivePath) } catch (e) {
        console.error(`[MCPanel] Не удалось удалить повреждённый архив: ${e.message}`)
      }
    }
  }

  // If another process already downloaded the archive, skip download
  if (!fs.existsSync(archivePath)) {
    // Write a lock file so parallel calls know download is in progress
    fs.writeFileSync(lockPath, process.pid.toString())

    onProgress && onProgress(0, `Скачиваем Java ${javaVersion}...`)

    try {
      const url = getAdoptiumUrl(javaVersion)
      await downloadFile(url, archivePath, (pct) => {
        onProgress && onProgress(Math.round(pct * 0.8), `Скачиваем Java ${javaVersion}... ${pct}%`)
      })
    } catch (err) {
      // Clean up partial download
      try { fs.unlinkSync(archivePath) } catch {}
      try { fs.unlinkSync(lockPath) } catch {}
      throw err
    }

    try { fs.unlinkSync(lockPath) } catch {}
  }

  onProgress && onProgress(82, `Распаковываем Java ${javaVersion}...`)

  try {
    if (isWindows) {
      // Write PS1 to temp file — avoids ALL inline quoting/newline issues
      const psScriptPath = path.join(baseDir, `extract-jdk-${javaVersion}.ps1`)
      const psLines = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$src = "${archivePath.replace(/\\/g, '/')}"`,
        `$dst = "${installDir.replace(/\\/g, '/')}"`,
        '$zip = [System.IO.Compression.ZipFile]::OpenRead($src)',
        'foreach ($entry in $zip.Entries) {',
        '  $destPath = Join-Path $dst $entry.FullName',
        '  $destDir = Split-Path $destPath -Parent',
        '  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }',
        '  if ($entry.Name -ne "") {',
        '    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)',
        '  }',
        '}',
        '$zip.Dispose()',
      ]
      fs.writeFileSync(psScriptPath, psLines.join('\r\n'), 'utf8')
      try {
        execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psScriptPath}"`, { timeout: 300000 })
      } finally {
        try { fs.unlinkSync(psScriptPath) } catch {}
      }

      // Adoptium nests files inside jdk-xx.x.x+build/ — move them up one level
      const inner = fs.readdirSync(installDir).find(f => /^jdk/i.test(f) && fs.statSync(path.join(installDir, f)).isDirectory())
      if (inner) {
        const innerPath = path.join(installDir, inner)
        for (const f of fs.readdirSync(innerPath)) {
          const src = path.join(innerPath, f)
          const dst = path.join(installDir, f)
          if (!fs.existsSync(dst)) fs.renameSync(src, dst)
        }
        try { fs.rmSync(innerPath, { recursive: true, force: true }) } catch {}
      }
    } else {
      execSync(`tar -xzf "${archivePath}" -C "${installDir}" --strip-components=1`, { timeout: 300000 })
    }
  } catch (extractErr) {
    // Clean up bad archive so next run re-downloads
    try { fs.unlinkSync(archivePath) } catch {}
    throw new Error(`Ошибка распаковки: ${extractErr.message}`)
  }

  // Remove archive after successful extract
  try { fs.unlinkSync(archivePath) } catch {}

  onProgress && onProgress(100, `Java ${javaVersion} готова!`)

  const exe = getJavaExe(javaVersion)
  if (!exe) throw new Error(`Java ${javaVersion} установлена, но java.exe не найден в ${installDir}`)
  return exe
}

// ── Pre-install ALL java versions at startup ──────────────────
// Returns Map<javaVersion, { status: 'ready'|'downloading'|'error', exe, error }>
async function preinstallAllJava(onProgress) {
  const results = new Map()

  // Download all 3 in parallel
  await Promise.all(JAVA_VERSIONS.map(async (ver) => {
    try {
      const exe = await downloadJava(ver, (pct, msg) => {
        onProgress && onProgress(ver, pct, msg)
      })
      results.set(ver, { status: 'ready', exe })
    } catch (err) {
      results.set(ver, { status: 'error', error: err.message })
      onProgress && onProgress(ver, -1, `Ошибка Java ${ver}: ${err.message}`)
    }
  }))

  return results
}

// Returns exe path for the Java needed by a given MC version
function getJavaForMc(mcVersion) {
  const ver = getRequiredJava(mcVersion)
  return getJavaExe(ver) || 'java'
}

// ── Minecraft version lists ───────────────────────────────────
const MC_VERSIONS_FALLBACK = [
  '1.21.4','1.21.3','1.21.2','1.21.1','1.21',
  '1.20.6','1.20.4','1.20.2','1.20.1','1.20',
  '1.19.4','1.19.3','1.19.2','1.19.1','1.19',
  '1.18.2','1.18.1','1.18',
  '1.17.1','1.17',
  '1.16.5','1.16.4','1.16.3','1.16.2','1.16.1',
  '1.15.2','1.15.1','1.15',
  '1.14.4','1.14.3','1.14.2','1.14.1','1.14',
  '1.13.2','1.13.1','1.13',
  '1.12.2','1.12.1','1.12',
  '1.11.2','1.11','1.10.2',
  '1.9.4','1.9','1.8.9','1.8.8','1.8','1.7.10'
]

async function getVersions(core) {
  try {
    switch (core) {
      case 'paper':   return await getPaperVersions()
      case 'fabric':  return await getFabricVersions()
      case 'vanilla': return await getVanillaVersions()
      case 'forge':   return MC_VERSIONS_FALLBACK.filter(v => {
        // Forge популярные версии
        const forgeVersions = ['1.21.1','1.20.6','1.20.4','1.20.1','1.19.4','1.19.2','1.18.2','1.16.5','1.12.2','1.10.2','1.8.9','1.7.10']
        return forgeVersions.includes(v)
      })
      case 'velocity': return ['3.3.0']
      default:        return MC_VERSIONS_FALLBACK
    }
  } catch (err) {
    console.error('[MCPanel] Failed to fetch versions:', err)
    return MC_VERSIONS_FALLBACK.slice(0, 30)
  }
}

async function getPaperVersions() {
  const d = await fetchJson('https://api.papermc.io/v2/projects/paper')
  return (d.versions || []).reverse()
}
async function getFabricVersions() {
  const d = await fetchJson('https://meta.fabricmc.net/v2/versions/game')
  return d.filter(v => v.stable).map(v => v.version)
}
async function getVanillaVersions() {
  const d = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json')
  return d.versions.filter(v => v.type === 'release').map(v => v.id)
}

// ── Download server jar ───────────────────────────────────────
async function download({ core, version, destDir, onProgress }) {
  // Java should already be installed; just grab the exe path
  const javaVer = getRequiredJava(version)
  const javaExe = getJavaExe(javaVer) || 'java'
  fs.writeFileSync(path.join(destDir, '.java_exe'), javaExe)

  onProgress && onProgress(0, `Скачиваем ${core} ${version}...`)
  const url = await getDownloadUrl(core, version)
  if (!url) throw new Error(`Не найден URL для ${core} ${version}`)

  const jarPath = path.join(destDir, 'server.jar')

  // Remove partial download if exists
  if (fs.existsSync(jarPath)) {
    try {
      fs.unlinkSync(jarPath)
    } catch (e) {
      console.warn('[MCPanel] Could not remove old jar:', e.message)
    }
  }

  // Try curl first (more reliable), fallback to Node.js https
  try {
    await downloadWithCurl(url, jarPath, (pct) => {
      onProgress && onProgress(pct, `Скачиваем ядро... ${pct}%`)
    })
  } catch (curlErr) {
    console.log('[MCPanel] curl failed, trying Node.js https:', curlErr.message)
    await downloadFile(url, jarPath, (pct) => {
      onProgress && onProgress(pct, `Скачиваем ядро... ${pct}%`)
    })
  }
}

async function getDownloadUrl(core, version) {
  switch (core) {
    case 'paper': {
      const b = await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`)
      if (!b.builds || b.builds.length === 0) throw new Error('Нет доступных сборок')
      const latest = b.builds[b.builds.length - 1]
      const jar = latest.downloads.application.name
      return `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latest.build}/downloads/${jar}`
    }
    case 'fabric': {
      const ins = await fetchJson('https://meta.fabricmc.net/v2/versions/installer')
      const loaders = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${version}`)
      if (!ins || ins.length === 0) throw new Error('Нет доступных установщиков Fabric')
      if (!loaders || loaders.length === 0) throw new Error('Нет доступных загрузчиков Fabric')
      const loader = loaders[0].loader.version
      const installer = ins[0].version
      return `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`
    }
    case 'vanilla': {
      const m = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json')
      const entry = m.versions.find(v => v.id === version)
      if (!entry) throw new Error('Версия не найдена')
      const vd = await fetchJson(entry.url)
      return vd.downloads.server.url
    }
    case 'forge': {
      // Forge versions mapping (MC version -> Forge version)
      const forgeVersions = {
        '1.21.1': '52.0.29',
        '1.20.6': '50.1.0',
        '1.20.4': '49.1.0',
        '1.20.1': '47.3.0',
        '1.19.4': '45.2.0',
        '1.19.2': '43.4.0',
        '1.18.2': '40.2.21',
        '1.16.5': '36.2.39',
        '1.12.2': '14.23.5.2860',
        '1.10.2': '12.18.3.2511',
        '1.8.9': '11.15.1.2318',
        '1.7.10': '10.13.4.1614'
      }
      const forgeVer = forgeVersions[version]
      if (!forgeVer) throw new Error(`Forge version not found for MC ${version}`)
      return `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}-${forgeVer}/forge-${version}-${forgeVer}-installer.jar`
    }
    default:
      throw new Error(`Неизвестное ядро: ${core}`)
  }
}

// ── HTTP helpers ──────────────────────────────────────────────
function downloadWithCurl(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process')
    const curl = spawn('curl', [
      '-L', // Follow redirects
      '-o', dest,
      '--progress-bar',
      '--retry', '3',
      '--retry-delay', '2',
      '--max-time', '300',
      url
    ])

    let lastProgress = 0
    curl.stderr.on('data', (data) => {
      const str = data.toString()
      // Parse curl progress bar
      const match = str.match(/(\d+)%/)
      if (match) {
        const pct = parseInt(match[1])
        if (pct !== lastProgress) {
          lastProgress = pct
          onProgress && onProgress(pct)
        }
      }
    })

    curl.on('close', (code) => {
      if (code === 0) {
        // Verify file exists and has reasonable size
        if (fs.existsSync(dest)) {
          const stats = fs.statSync(dest)
          if (stats.size < 1024 * 1024) {
            try { fs.unlinkSync(dest) } catch {}
            return reject(new Error(`Загруженный файл слишком мал (${stats.size} байт)`))
          }
          resolve()
        } else {
          reject(new Error('Файл не был создан'))
        }
      } else {
        try { fs.unlinkSync(dest) } catch {}
        reject(new Error(`curl завершился с кодом ${code}`))
      }
    })

    curl.on('error', (err) => {
      try { fs.unlinkSync(dest) } catch {}
      reject(err)
    })
  })
}

function fetchJson(url, depth = 0) {
  if (depth > 10) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, { headers: { 'User-Agent': 'MCPanel/1.0' } }, (res) => {
      if ([301,302,307,308].includes(res.statusCode)) {
        const loc = res.headers.location
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href
        return fetchJson(next, depth + 1).then(resolve).catch(reject)
      }
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)) }
      })
    }).on('error', reject)
  })
}

function downloadFile(url, dest, onProgress, depth = 0, retries = 3) {
  if (depth > 10) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'MCPanel/1.0',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      },
      timeout: 60000
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode)) {
        const loc = res.headers.location
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href
        return downloadFile(next, dest, onProgress, depth + 1, retries).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      const total = parseInt(res.headers['content-length'], 10) || 0
      let downloaded = 0
      const file = fs.createWriteStream(dest)
      let lastProgress = 0

      res.on('data', chunk => {
        downloaded += chunk.length
        if (total > 0 && onProgress) {
          const progress = Math.round((downloaded / total) * 100)
          if (progress !== lastProgress) {
            lastProgress = progress
            onProgress(progress)
          }
        }
      })

      res.pipe(file)

      file.on('finish', () => {
        file.close(() => {
          // Verify file size after closing
          try {
            const stats = fs.statSync(dest)
            if (stats.size < 1024 * 1024) { // Less than 1MB is suspicious
              try { fs.unlinkSync(dest) } catch {}
              return reject(new Error(`Загруженный файл слишком мал (${stats.size} байт)`))
            }
          } catch (statErr) {
            // If we can't stat the file, something went wrong
            try { fs.unlinkSync(dest) } catch {}
            return reject(new Error(`Не удалось проверить загруженный файл: ${statErr.message}`))
          }

          if (onProgress) onProgress(100)
          resolve()
        })
      })

      file.on('error', err => {
        file.close()
        try { fs.unlinkSync(dest) } catch {}

        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
          console.log(`[MCPanel] File write error (${err.code}), retrying... (${retries} attempts left)`)
          setTimeout(() => {
            downloadFile(url, dest, onProgress, depth, retries - 1).then(resolve).catch(reject)
          }, 2000)
        } else {
          reject(err)
        }
      })

      res.on('error', err => {
        file.close()
        try { fs.unlinkSync(dest) } catch {}

        if (retries > 0) {
          console.log(`[MCPanel] Response error (${err.code || err.message}), retrying... (${retries} attempts left)`)
          setTimeout(() => {
            downloadFile(url, dest, onProgress, depth, retries - 1).then(resolve).catch(reject)
          }, 2000)
        } else {
          reject(err)
        }
      })
    })

    req.on('timeout', () => {
      req.destroy()
      if (retries > 0) {
        console.log(`[MCPanel] Download timeout, retrying... (${retries} attempts left)`)
        setTimeout(() => {
          downloadFile(url, dest, onProgress, depth, retries - 1).then(resolve).catch(reject)
        }, 2000)
      } else {
        reject(new Error('Download timeout'))
      }
    })

    req.on('error', err => {
      if (retries > 0 && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND')) {
        console.log(`[MCPanel] Network error (${err.code}), retrying... (${retries} attempts left)`)
        setTimeout(() => {
          downloadFile(url, dest, onProgress, depth, retries - 1).then(resolve).catch(reject)
        }, 2000)
      } else {
        reject(err)
      }
    })
  })
}

async function downloadVelocityJar(destDir, onProgress) {
  const jarPath = path.join(destDir, 'Velocity.jar')
  const url = `https://api.papermc.io/v2/projects/velocity/versions/3.4.0-SNAPSHOT/builds/504/downloads/velocity-3.4.0-SNAPSHOT-504.jar`
  await downloadFile(url, jarPath, onProgress)
}

// ── Java for proxies ───────────────────────────────────────────
function getJavaForProxy(core) {
  if (core === 'velocity') return 21  // Velocity 3.5.0 needs Java 21
  return 17  // For other proxies like BungeeCord
}

module.exports = {
  JAVA_VERSIONS,
  getRequiredJava,
  getJavaBaseDir,
  getJavaInstallDir,
  getJavaExe,
  isJavaReady,
  downloadJava,
  preinstallAllJava,
  getJavaForMc,
  getVersions,
  download,
  getDownloadUrl,
  // TCP Agent
  downloadVelocityJar,
  // Java
  getJavaForProxy,
}
