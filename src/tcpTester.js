const net = require('net')
const coreDownloader = require('./coreDownloader')

async function downloadVelocityJar(destDir, onProgress) {
  return await coreDownloader.downloadVelocityJar(destDir, onProgress)
}

async function testTcpConnection(opts) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let resolved = false

    socket.setTimeout(5000)
    socket.connect(opts.port, opts.host, () => {
      socket.write(JSON.stringify({ cmd: 'auth', user: opts.user, pass: opts.pass }) + '\n')
    })

    socket.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'auth_ok') {
            if (!resolved) { resolved = true; resolve({ ok: true }) }
            socket.end()
          } else if (msg.type === 'auth_fail') {
            if (!resolved) { resolved = true; resolve({ ok: false, error: 'Неверный логин/пароль' })}
            socket.end()
          }
        } catch {}
      }
    })

    socket.on('error', (err) => {
      if (!resolved) { resolved = true; resolve({ ok: false, error: err.message }) }
      socket.destroy()
    })

    socket.on('timeout', () => {
      if (!resolved) { resolved = true; resolve({ ok: false, error: 'Таймаут соединения' }) }
      socket.destroy()
    })
  })
}

module.exports = { downloadVelocityJar, testTcpConnection }