import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import http from 'http'

const ENV_FILE = path.resolve('.env')
const CONFIG_FILE = path.resolve('config.json')
const ANKI_FORMAT_FILE = path.resolve('ankiformat.json')
const MODES_DIR = path.resolve('modes')
const LOG_DIR = path.resolve('logs')

function parseEnv() {
  if (!fs.existsSync(ENV_FILE)) return {}
  const lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n')
  const keys = {}
  const providers = { ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini', GROK: 'grok' }
  for (const line of lines) {
    const match = line.match(/^VITE_(\w+)_API_KEY=(.*)$/)
    if (match) {
      const provider = providers[match[1]]
      if (provider) keys[provider] = match[2].trim()
    }
  }
  return keys
}

function writeEnv(keys) {
  const providers = { anthropic: 'ANTHROPIC', openai: 'OPENAI', gemini: 'GEMINI', grok: 'GROK' }
  let existing = []
  if (fs.existsSync(ENV_FILE)) {
    existing = fs.readFileSync(ENV_FILE, 'utf-8').split('\n')
      .filter((l) => !l.match(/^VITE_\w+_API_KEY=/))
      .filter((l) => l.trim() !== '')
  }
  const keyLines = Object.entries(keys)
    .filter(([, v]) => v)
    .map(([k, v]) => `VITE_${providers[k] || k.toUpperCase()}_API_KEY=${v}`)
  const content = [...existing, ...keyLines].join('\n') + '\n'
  fs.writeFileSync(ENV_FILE, content, 'utf-8')
}

function readConfig() {
  try {
    return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {}
  } catch { return {} }
}

function writeConfig(data) {
  const existing = readConfig()
  const merged = { ...existing, ...data }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
}

function apiPlugin() {
  return {
    name: 'api-plugin',
    configureServer(server) {
      // API keys endpoint
      server.middlewares.use('/api/keys', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(parseEnv()))
        } else if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try {
              writeEnv(JSON.parse(body))
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
        } else {
          res.statusCode = 405
          res.end('')
        }
      })

      // Log endpoint — writes OCR pipeline logs to logs/ directory
      server.middlewares.use('/api/log', (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try {
              if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
              const logFile = path.join(LOG_DIR, `ocr-${timestamp}.log`)
              fs.writeFileSync(logFile, body, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, file: logFile }))
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
        } else {
          res.statusCode = 405
          res.end('')
        }
      })

      // AnkiConnect proxy endpoint
      server.middlewares.use('/api/anki', (req, res) => {
        if (req.method === 'POST') {
          // Vite may have already parsed the body — check req.body first
          const forwardBody = (bodyStr) => {
            console.log('[Anki proxy] forwarding:', bodyStr.substring(0, 200))
            const ankiReq = http.request(
              { hostname: '127.0.0.1', port: 8765, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } },
              (ankiRes) => {
                let data = ''
                ankiRes.on('data', (chunk) => { data += chunk })
                ankiRes.on('end', () => {
                  console.log('[Anki proxy] response:', data.substring(0, 200))
                  res.setHeader('Content-Type', 'application/json')
                  res.end(data)
                })
              }
            )
            ankiReq.on('error', (err) => {
              console.log('[Anki proxy] error:', err.message)
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Anki is not running or AnkiConnect is not installed' }))
            })
            ankiReq.write(bodyStr)
            ankiReq.end()
          }
          // Handle both pre-parsed body and raw stream
          if (req.body) {
            forwardBody(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
          } else {
            let raw = ''
            req.on('data', (chunk) => { raw += chunk })
            req.on('end', () => forwardBody(raw))
          }
        } else {
          res.statusCode = 405
          res.end('')
        }
      })

      // Anki format endpoint
      server.middlewares.use('/api/ankiformat', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          try {
            const data = fs.existsSync(ANKI_FORMAT_FILE)
              ? fs.readFileSync(ANKI_FORMAT_FILE, 'utf-8')
              : '{}'
            res.end(data)
          } catch { res.end('{}') }
        } else if (req.method === 'POST') {
          const handleBody = (bodyStr) => {
            try {
              fs.writeFileSync(ANKI_FORMAT_FILE, bodyStr, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          }
          if (req.body) {
            handleBody(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
          } else {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => handleBody(body))
          }
        } else {
          res.statusCode = 405
          res.end('')
        }
      })

      // Knowledge base endpoint — MUST be before /api/modes (prefix matching)
      // GET ?mode=X → list files + content
      // POST ?mode=X (JSON {filename, content}) → upload file
      // DELETE ?mode=X&file=Y → delete file
      // PATCH ?mode=X&file=Y → toggle enable/disable
      server.middlewares.use('/api/modes/knowledge', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const url = new URL(req.url, 'http://x')
        const modeName = url.searchParams.get('mode') || ''
        const sanitized = (modeName || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
        const knowledgeDir = path.join(MODES_DIR, sanitized, 'knowledge')

        if (!sanitized) { res.end(JSON.stringify({ files: [], content: null, fileCount: 0 })); return }

        if (req.method === 'GET') {
          try {
            if (!fs.existsSync(knowledgeDir)) { res.end(JSON.stringify({ files: [], content: null, fileCount: 0 })); return }
            const allFiles = fs.readdirSync(knowledgeDir)
            const files = allFiles.filter(f => f.match(/\.(txt|md)(\.disabled)?$/i)).map(f => {
              const disabled = f.endsWith('.disabled')
              const name = disabled ? f.replace(/\.disabled$/, '') : f
              const size = fs.statSync(path.join(knowledgeDir, f)).size
              return { name, disabled, size }
            })
            const enabledFiles = allFiles.filter(f => f.match(/\.(txt|md)$/i))
            const content = enabledFiles.map(f => {
              const text = fs.readFileSync(path.join(knowledgeDir, f), 'utf-8')
              return `--- ${f} ---\n${text}`
            }).join('\n\n')
            res.end(JSON.stringify({ files, content: content || null, fileCount: enabledFiles.length }))
          } catch { res.end(JSON.stringify({ files: [], content: null, fileCount: 0 })) }
        } else if (req.method === 'POST') {
          const handleBody = (bodyStr) => {
            try {
              if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true })
              const { filename, content } = JSON.parse(bodyStr)
              const safeName = (filename || 'file.txt').replace(/[<>:"/\\|?*]/g, '')
              fs.writeFileSync(path.join(knowledgeDir, safeName), content, 'utf-8')
              res.end(JSON.stringify({ ok: true, filename: safeName }))
            } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })) }
          }
          if (req.body) { handleBody(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) }
          else { let b = ''; req.on('data', c => b += c); req.on('end', () => handleBody(b)) }
        } else if (req.method === 'DELETE') {
          try {
            const fileName = url.searchParams.get('file')
            if (!fileName) { res.statusCode = 400; res.end('{"error":"no file"}'); return }
            const safeName = fileName.replace(/[<>:"/\\|?*]/g, '')
            const filePath = path.join(knowledgeDir, safeName)
            const disabledPath = filePath + '.disabled'
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
            if (fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath)
            res.end('{"ok":true}')
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })) }
        } else if (req.method === 'PATCH') {
          try {
            const fileName = url.searchParams.get('file')
            if (!fileName) { res.statusCode = 400; res.end('{"error":"no file"}'); return }
            const safeName = fileName.replace(/[<>:"/\\|?*]/g, '')
            const filePath = path.join(knowledgeDir, safeName)
            const disabledPath = filePath + '.disabled'
            if (fs.existsSync(disabledPath)) {
              fs.renameSync(disabledPath, filePath)
              res.end(JSON.stringify({ ok: true, disabled: false }))
            } else if (fs.existsSync(filePath)) {
              fs.renameSync(filePath, disabledPath)
              res.end(JSON.stringify({ ok: true, disabled: true }))
            } else {
              res.statusCode = 404; res.end('{"error":"file not found"}')
            }
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })) }
        } else { res.statusCode = 405; res.end('') }
      })

      // Modes endpoint — per-mode named folders in modes/ directory
      // Each mode: modes/<sanitized-name>/config.json
      // Meta: modes/_meta.json
      server.middlewares.use('/api/modes', (req, res) => {
        if (!fs.existsSync(MODES_DIR)) fs.mkdirSync(MODES_DIR, { recursive: true })
        const metaFile = path.join(MODES_DIR, '_meta.json')

        // Sanitize mode name for folder: remove invalid chars, trim, fallback to id
        const sanitizeName = (name, id) => {
          const clean = (name || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
          return clean || `mode-${id}`
        }

        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          try {
            const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf-8')) : {}

            // Migrate legacy numbered folders/files
            const entries = fs.readdirSync(MODES_DIR)
            for (const entry of entries) {
              const full = path.join(MODES_DIR, entry)
              // Legacy flat file: 1.json → read, create named folder
              if (entry.match(/^\d+\.json$/)) {
                try {
                  const mode = JSON.parse(fs.readFileSync(full, 'utf-8'))
                  const folderName = sanitizeName(mode.name, mode.id)
                  const newDir = path.join(MODES_DIR, folderName)
                  if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true })
                  fs.writeFileSync(path.join(newDir, 'config.json'), JSON.stringify(mode, null, 2), 'utf-8')
                  fs.unlinkSync(full)
                } catch {}
              }
              // Legacy numbered folder: 1/ → read config, rename to named folder
              if (entry.match(/^\d+$/) && fs.statSync(full).isDirectory()) {
                const cfgFile = path.join(full, 'config.json')
                if (fs.existsSync(cfgFile)) {
                  try {
                    const mode = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'))
                    const folderName = sanitizeName(mode.name, mode.id)
                    if (folderName !== entry) {
                      const newDir = path.join(MODES_DIR, folderName)
                      if (!fs.existsSync(newDir)) fs.renameSync(full, newDir)
                    }
                  } catch {}
                }
              }
            }

            // Read all mode folders
            const allDirs = fs.readdirSync(MODES_DIR).filter((d) => {
              const full = path.join(MODES_DIR, d)
              return d !== '_meta.json' && d !== 'Default' && fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'config.json'))
            })
            const modes = allDirs.map((d) => {
              try { return JSON.parse(fs.readFileSync(path.join(MODES_DIR, d, 'config.json'), 'utf-8')) } catch { return null }
            }).filter(Boolean)
            res.end(JSON.stringify({ modes, activeModeId: meta.activeModeId || (modes[0]?.id) || 1 }))
          } catch { res.end('{"modes":[],"activeModeId":1}') }
        } else if (req.method === 'POST') {
          const handleBody = (bodyStr) => {
            try {
              const data = JSON.parse(bodyStr)
              if (data.modes) {
                // Track which folders should exist
                const activeFolders = new Set(['_meta.json'])
                for (const mode of data.modes) {
                  const folderName = sanitizeName(mode.name, mode.id)
                  activeFolders.add(folderName)
                  const dir = path.join(MODES_DIR, folderName)
                  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
                  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(mode, null, 2), 'utf-8')
                }
                // Remove folders for deleted/renamed modes
                fs.readdirSync(MODES_DIR).forEach((d) => {
                  const full = path.join(MODES_DIR, d)
                  if (d !== 'Default' && fs.statSync(full).isDirectory() && !activeFolders.has(d)) {
                    fs.rmSync(full, { recursive: true, force: true })
                  }
                })
                // Save meta
                fs.writeFileSync(metaFile, JSON.stringify({ activeModeId: data.activeModeId }), 'utf-8')
              }
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch (e) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: e.message }))
            }
          }
          if (req.body) {
            handleBody(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
          } else {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => handleBody(body))
          }
        } else {
          res.statusCode = 405
          res.end('')
        }
      })

      // (old knowledge endpoint removed — moved before /api/modes)

      // Launch overlay endpoint
      let overlayProcess = null
      server.middlewares.use('/api/launch-overlay', (req, res) => {
        if (req.method === 'POST') {
          res.setHeader('Content-Type', 'application/json')
          if (overlayProcess && !overlayProcess.killed) {
            res.end(JSON.stringify({ ok: true, status: 'already running' }))
            return
          }
          try {
            const { spawn } = require('child_process')
            const electronPath = require.resolve('electron/cli.js')
            overlayProcess = spawn(process.execPath, [electronPath, path.resolve('electron/main.js')], {
              stdio: 'inherit', detached: false,
            })
            overlayProcess.on('exit', () => { overlayProcess = null })
            res.end(JSON.stringify({ ok: true, status: 'launched' }))
          } catch (e) {
            try {
              const { spawn } = require('child_process')
              overlayProcess = spawn('npx', ['electron', path.resolve('electron/main.js')], {
                stdio: 'inherit', detached: false, shell: true,
              })
              overlayProcess.on('exit', () => { overlayProcess = null })
              res.end(JSON.stringify({ ok: true, status: 'launched via npx' }))
            } catch (e2) {
              res.end(JSON.stringify({ error: 'Electron not installed. Run: npm install electron --save-optional' }))
            }
          }
        } else { res.statusCode = 405; res.end('') }
      })

      // Ensure directory endpoint
      server.middlewares.use('/api/ensure-dir', (req, res) => {
        if (req.method === 'POST') {
          const handleBody = (bodyStr) => {
            try {
              const { dir } = JSON.parse(bodyStr)
              const full = path.resolve(dir)
              if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true })
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, path: full }))
            } catch (e) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: e.message }))
            }
          }
          if (req.body) { handleBody(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) }
          else { let b = ''; req.on('data', c => b += c); req.on('end', () => handleBody(b)) }
        } else { res.statusCode = 405; res.end('') }
      })

      // Config endpoint
      server.middlewares.use('/api/config', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(readConfig()))
        } else if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try {
              writeConfig(JSON.parse(body))
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
        } else {
          res.statusCode = 405
          res.end('')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    port: 3000,
    open: true,
    watch: { ignored: ['**/.env', '**/config.json', '**/ankiformat.json', '**/modes/**'] },
  },
})
