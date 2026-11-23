// Local preview with hot reload: `bun dev.mjs [port]` from tools/.
// Serves site/ on 127.0.0.1 and reloads every open page when a file changes.
import { watch } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../site/', import.meta.url).pathname
const port = Number(process.argv[2] || 4737)
const clients = new Set()
const encoder = new TextEncoder()
const hook = `<script>new EventSource('/__reload').onmessage = () => location.reload()</script>`

let timer
watch(root, { recursive: true }, () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    for (const client of clients) {
      try {
        client.enqueue(encoder.encode('data: reload\n\n'))
      } catch {
        clients.delete(client)
      }
    }
  }, 120)
})
setInterval(() => {
  for (const client of clients) {
    try {
      client.enqueue(encoder.encode(': ping\n\n'))
    } catch {
      clients.delete(client)
    }
  }
}, 20000)

Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
    if (path === '/__reload') {
      let self
      const stream = new ReadableStream({
        start(controller) {
          self = controller
          clients.add(controller)
          controller.enqueue(encoder.encode(': hello\n\n'))
        },
        cancel() {
          clients.delete(self)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
    }
    const file = Bun.file(join(root, path.endsWith('/') ? `${path}index.html` : path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const headers = { 'cache-control': 'no-store' }
    if (file.name.endsWith('.html'))
      return new Response((await file.text()).replace('</body>', `${hook}</body>`), {
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      })
    return new Response(file, { headers })
  },
})
console.log(`http://127.0.0.1:${port}/ with hot reload`)
