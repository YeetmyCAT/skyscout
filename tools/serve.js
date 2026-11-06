// Local static server for testing. No caching, so edits always reach the browser.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), port = +process.argv[2] || 8133;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p == '/') p = '/index.html';
  const f = path.join(root, path.normalize(p));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
}).listen(port, () => console.log('serving', root, 'on', port));
