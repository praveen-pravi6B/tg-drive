import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'
import puppeteer from 'puppeteer-core'

const PORT = Number(process.env.SMOKE_PORT || 4173)
const BASE = `http://127.0.0.1:${PORT}`
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))

function waitForPort(port, timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > timeoutMs) reject(new Error(`Port ${port} did not open`))
        else setTimeout(tryConnect, 250)
      })
    }
    tryConnect()
  })
}

async function stopServer(server) {
  if (server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

const server = spawn(process.execPath, [VITE, 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
})

let browser
let exitCode = 0

try {
  await waitForPort(PORT)

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Keep the smoke test hermetic: GramJS must not reach the real network.
      '--host-resolver-rules=MAP *.telegram.org 127.0.0.1',
    ],
  })

  const page = await browser.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // A persistent MTProto WebSocket means `networkidle0` never fires.
  const response = await page.goto(`${BASE}/login`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  if (!response || !response.ok()) throw new Error(`Login page returned ${response?.status()}`)

  await page.waitForSelector('h1', { timeout: 15000 })
  const text = await page.evaluate(() => document.body.innerText)

  if (!text.includes('TGDrive')) throw new Error('Brand text missing from the login page')
  if (!text.includes('Connect your Telegram app') && !text.includes('Scan with Telegram')) {
    throw new Error('Login view did not render a known state')
  }

  await page.goto(`${BASE}/debug`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 15000 })

  await page.goto(`${BASE}/drive`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 15000 })

  const fatalConsole = consoleErrors.filter(
    (line) =>
      !/favicon|Vue Devtools|telegram|websocket|net::|ERR_|Failed to fetch|network|\[object Event\]/i.test(
        line,
      ),
  )
  if (pageErrors.length) throw new Error(`Uncaught page errors:\n${pageErrors.join('\n')}`)
  if (fatalConsole.length) throw new Error(`Console errors:\n${fatalConsole.join('\n')}`)

  console.log('smoke: ok')
  console.log('  login view renders and starts QR login')
  console.log('  route guard: /debug and /drive redirect to /login')
  console.log('  console errors: none (outside Telegram network noise)')
  console.log(`  rendered: ${text.split('\n').filter(Boolean).slice(0, 5).join(' | ')}`)
} catch (error) {
  exitCode = 1
  console.error(`smoke: failed\n${error.stack || error}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopServer(server)
  process.exit(exitCode)
}
