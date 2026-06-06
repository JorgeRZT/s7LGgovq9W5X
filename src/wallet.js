'use strict';

const fs   = require('fs');
const path = require('path');

const WALLET_FILE = path.resolve(__dirname, '..', 'wallet.json');

function loadWallet() {
  if (!fs.existsSync(WALLET_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveWallet(entries) {
  fs.writeFileSync(WALLET_FILE, JSON.stringify(entries, null, 2));
}

module.exports = { loadWallet, saveWallet };
