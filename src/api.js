'use strict';

require('dotenv').config();

const http = require('http');
const { scrape } = require('./scraper');

const PORT = process.env.PORT || 3000;

/**
 * Minimal HTTP API — no framework dependency.
 *
 * POST /scrape
 * Body (JSON):
 * {
 *   "url": "https://example.com",
 *   "cookies": [...],          // optional
 *   "jsToExecute": "...",      // optional JS expression
 *   "headers": {...},          // optional
 *   "timeout": 30000,          // optional
 *   "waitUntil": "networkidle",// optional
 *   "waitForSelector": ".main",// optional
 *   "screenshot": false,       // optional
 *   "userAgent": "..."         // optional
 * }
 */
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/scrape') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only POST /scrape is supported' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { url, ...options } = payload;

    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '"url" field is required' }));
      return;
    }

    try {
      const result = await scrape(url, options);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Scraper API listening on http://localhost:${PORT}`);
  console.log('POST /scrape  { url, cookies?, jsToExecute?, headers?, ... }');
});
