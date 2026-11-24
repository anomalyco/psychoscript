// Serves the Psychoscript landing page (site/) on psychoscript.com and dev.psychoscript.com.
type Env = { ASSETS: { fetch(request: Request): Promise<Response> } }

function secure(headers: Headers) {
  headers.set("Strict-Transport-Security", "max-age=31536000")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
}

// Static assets ignore Range, which Safari needs for audio playback.
async function ranged(request: Request, response: Response, headers: Headers): Promise<Response> {
  headers.set("Accept-Ranges", "bytes")
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "")
  if (response.status !== 200 || !match || (!match[1] && !match[2])) {
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  const body = await response.arrayBuffer()
  const size = body.byteLength
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (start > end || start >= size) {
    headers.set("Content-Range", `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`)
  headers.set("Content-Length", String(end - start + 1))
  return new Response(request.method === "HEAD" ? null : body.slice(start, end + 1), { status: 206, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === "www.psychoscript.com") {
      url.hostname = "psychoscript.com"
      return Response.redirect(url.toString(), 301)
    }

    const isDev = url.hostname === "dev.psychoscript.com"
    if (isDev && url.pathname === "/robots.txt") {
      const headers = new Headers({
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
        "X-Robots-Tag": "noindex, nofollow",
      })
      secure(headers)
      return new Response(request.method === "HEAD" ? null : "User-agent: *\nDisallow: /\n", {
        status: 200,
        headers,
      })
    }

    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    const path = url.pathname
    if (path === "/" || /\.(html|txt|xml|webmanifest)$/.test(path)) {
      headers.set("Cache-Control", "public, max-age=0, must-revalidate")
    } else {
      headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
    }
    secure(headers)
    if (isDev) headers.set("X-Robots-Tag", "noindex, nofollow")
    if (/\.(mp3|mp4|webm)$/.test(path)) return ranged(request, response, headers)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
