#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { scrape } = require('./scraper');

const program = new Command();

program
  .name('scraper')
  .description('Headless browser scraper with cookie and JS support (Playwright)')
  .version('1.0.0');

program
  .command('fetch <url>')
  .description('Fetch a URL and print its content')
  .option('-c, --cookies <json>', 'JSON array of cookie objects, e.g. \'[{"name":"token","value":"abc"}]\'')
  .option('-j, --js <script>', 'JavaScript snippet to evaluate on the page (must be an expression)')
  .option('-H, --header <key=value...>', 'Extra HTTP headers (repeatable)')
  .option('-t, --timeout <ms>', 'Navigation timeout in ms', '30000')
  .option('-w, --wait-until <event>', 'load | domcontentloaded | networkidle | commit', 'networkidle')
  .option('-s, --selector <css>', 'Wait for this CSS selector before returning')
  .option('--screenshot <file>', 'Save a PNG screenshot to <file>')
  .option('--user-agent <ua>', 'Custom User-Agent string')
  .option('--html', 'Print full HTML instead of visible text')
  .option('--json', 'Print full result as JSON')
  .action(async (url, opts) => {
    try {
      const cookies = opts.cookies ? JSON.parse(opts.cookies) : [];

      const headers = {};
      for (const h of opts.header ?? []) {
        const idx = h.indexOf('=');
        if (idx === -1) {
          console.error(`Invalid header (expected key=value): ${h}`);
          process.exit(1);
        }
        headers[h.slice(0, idx)] = h.slice(idx + 1);
      }

      const result = await scrape(url, {
        cookies,
        jsToExecute: opts.js ?? null,
        headers,
        timeout: Number(opts.timeout),
        waitUntil: opts.waitUntil,
        waitForSelector: opts.selector ?? null,
        screenshot: !!opts.screenshot,
        userAgent: opts.userAgent ?? null,
      });

      if (opts.screenshot && result.screenshot) {
        const dest = path.resolve(opts.screenshot);
        fs.writeFileSync(dest, Buffer.from(result.screenshot, 'base64'));
        console.error(`Screenshot saved to ${dest}`);
      }

      if (opts.json) {
        const out = { ...result };
        if (out.screenshot) out.screenshot = '<base64 omitted>';
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      if (opts.html) {
        console.log(result.html);
        return;
      }

      console.log(`Title  : ${result.title}`);
      console.log(`URL    : ${result.url}`);
      console.log(`Cookies: ${result.cookies.length} cookie(s)`);
      if (opts.js) {
        console.log(`JS result: ${JSON.stringify(result.jsResult)}`);
      }
      console.log('\n--- Text content ---\n');
      console.log(result.text);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

program
  .command('eval-cookies <url> <cookieFile>')
  .description('Load cookies from a JSON file, navigate, and save updated cookies back')
  .option('-t, --timeout <ms>', 'Navigation timeout in ms', '30000')
  .action(async (url, cookieFile, opts) => {
    try {
      const cookies = JSON.parse(fs.readFileSync(path.resolve(cookieFile), 'utf8'));
      const result = await scrape(url, {
        cookies,
        timeout: Number(opts.timeout),
      });

      fs.writeFileSync(
        path.resolve(cookieFile),
        JSON.stringify(result.cookies, null, 2),
      );

      console.log(`Navigated to: ${result.url}`);
      console.log(`Saved ${result.cookies.length} cookie(s) back to ${cookieFile}`);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
