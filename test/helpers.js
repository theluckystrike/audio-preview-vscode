'use strict';
const path = require('path');
const FIX = path.join(__dirname, 'fixtures');
const { FileSource } = require('../src/core/source');
const { readMetadata } = require('../src/core/metadata');
async function meta(name) { const s = await FileSource.open(path.join(FIX, name)); try { return await readMetadata(s, name); } finally { await s.close(); } }
module.exports = { FIX, meta };
