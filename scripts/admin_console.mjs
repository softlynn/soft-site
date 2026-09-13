import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm",
};

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function isAllowedAdminOrigin(origin, allowedOrigins) {
  if (!origin || allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

// Only the production UI and public assets are served; no repository files.
export function createAdminConsole({ buildRoot, publicRoot }) {
  return async function serve(req, res, pathname) {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    if (pathname === "/console") {
      res.writeHead(302, { Location: "/console/admin", "Cache-Control": "no-store" }); res.end(); return true;
    }
    const isConsole = pathname.startsWith("/console/");
    const isPublic = pathname.startsWith("/data/") || pathname.startsWith("/uploads/") || pathname.startsWith("/media/") || /^\/(favicon|meta_image)\.[a-z]+$/.test(pathname);
    if (!isConsole && !isPublic) return false;
    const root = path.resolve(isPublic ? publicRoot : buildRoot);
    let relative;
    try { relative = decodeURIComponent(isConsole ? pathname.slice(9) : pathname.slice(1)); }
    catch { res.writeHead(400); res.end("Invalid path"); return true; }
    if (!relative || (isConsole && !path.extname(relative))) relative = "index.html";
    const target = path.resolve(root, relative);
    if (!inside(root, target) || relative.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
      res.writeHead(404); res.end("Not found"); return true;
    }
    const contentType = mimeTypes[path.extname(target).toLowerCase()];
    if (!contentType) { res.writeHead(404); res.end("Not found"); return true; }
    try {
      const [realRoot, realTarget, stat] = await Promise.all([fs.realpath(root), fs.realpath(target), fs.stat(target)]);
      if (!inside(realRoot, realTarget) || !stat.isFile()) { res.writeHead(404); res.end("Not found"); return true; }
      res.setHeader("Content-Type", contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("Cache-Control", relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      if (relative === "index.html") {
        const html = (await fs.readFile(realTarget, "utf8")).replace(/<head>/i, '<head><base href="/console/">');
        res.end(req.method === "HEAD" ? undefined : html);
      } else {
        const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return true; }
        res.setHeader("Content-Length", stat.size);
        if (req.method === "HEAD") res.end();
        else await pipeline(createReadStream(realTarget), res);
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      res.writeHead(relative === "index.html" ? 503 : 404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(relative === "index.html" ? "Build the site once with npm run build, then reopen admin from Softuchive." : "Not found");
    }
    return true;
  };
}
