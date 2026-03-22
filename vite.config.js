import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const ENV_FILE = path.resolve('.env')
const CONFIG_FILE = path.resolve('config.json')

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
    watch: { ignored: ['**/.env', '**/config.json'] },
  },
})
