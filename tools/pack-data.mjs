#!/usr/bin/env node
/**
 * Packs <in>/dataset.json into ui/data/dex.js: gzip level 9, base64.
 * The page inflates it with DecompressionStream('gzip') — no third-party
 * decompressor needs to ship inside the 4 MiB plugin budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const input = path.resolve(process.argv[2] || 'build/dataset.json');
const output = path.resolve(process.argv[3] || 'ui/data/dex.js');

const raw = fs.readFileSync(input);
const gz = zlib.gzipSync(raw, { level: 9 });
const b64 = gz.toString('base64');
const js = '/* Leaguepedia 数据快照，gzip+base64。由 tools/pack-data.mjs 生成，请勿手工编辑。 */\n' +
  'window.__DEX__="' + b64 + '";\n';
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, js);
const out = fs.statSync(output).size;
console.log(JSON.stringify({
  output,
  dataset: (raw.length / 1048576).toFixed(2) + ' MB',
  gzip: (gz.length / 1048576).toFixed(2) + ' MB',
  dexJs: (out / 1048576).toFixed(2) + ' MB',
  budget: '4.00 MB',
}, null, 1));
