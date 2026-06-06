'use strict';

const https = require('https');

/**
 * Envía un mensaje de Telegram.
 *
 * @param {string} text         Texto HTML del mensaje
 * @param {{ token: string, chatId: string }} opts
 * @returns {Promise<void>}
 */
function sendTelegram(text, { token, chatId }) {
  return new Promise((resolve, reject) => {
    if (!token || !chatId) {
      console.warn('[Telegram] token o chatId no configurados — notificación omitida');
      return resolve(null);
    }

    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error('[Telegram] Error:', parsed.description);
            return reject(new Error(parsed.description));
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendTelegram };
