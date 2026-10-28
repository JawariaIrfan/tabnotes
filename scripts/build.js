// Builds the release package using only Node.js built-ins (no npm install):
//
//   node scripts/build.js
//
// Output:
//   dist/TabNotes-v<version>/       clean copy of the files the extension needs
//   dist/TabNotes-v<version>.zip    same files, manifest.json at the ZIP root
//
// The build fails if a file referenced by manifest.json or an HTML page is
// missing, if a file outside the allowlist is present, or if the written ZIP
// does not read back byte-for-byte.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tabnotes');
const DIST = path.join(ROOT, 'dist');

// Every file shipped in the release. Anything else in tabnotes/ fails the build,
// so new files must be added here on purpose.
const FILES = [
  'manifest.json',
  'background.js',
  'nav-hook.js',
  'common.js',
  'saver.js',
  'content.js',
  'popup.html',
  'popup.js',
  'manage.html',
  'manage.js',
  'ui.css',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

// Fixed timestamp so the same sources always produce the same ZIP bytes.
const ZIP_DATE = new Date(2026, 0, 1, 0, 0, 0);

function fail(msg) {
  console.error('BUILD FAILED: ' + msg);
  process.exit(1);
}

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// ---- checks ------------------------------------------------------------------

function referencedFiles(manifest) {
  const refs = new Set();
  const add = (p) => p && refs.add(p.replace(/^\.?\//, ''));
  add(manifest.background && manifest.background.service_worker);
  add(manifest.options_page);
  if (manifest.action) {
    add(manifest.action.default_popup);
    Object.values(manifest.action.default_icon || {}).forEach(add);
  }
  Object.values(manifest.icons || {}).forEach(add);
  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }
  // Local src/href references in the extension's HTML pages.
  for (const page of [...refs].filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(SRC, page), 'utf8');
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      if (/^[a-z]+:/i.test(m[1]) || m[1].startsWith('#')) fail(`${page} references a non-local URL: ${m[1]}`);
      add(path.posix.join(path.posix.dirname(page), m[1]));
    }
  }
  return refs;
}

function check(manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (manifest.name !== 'TabNotes') fail('unexpected extension name: ' + manifest.name);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail('version must look like 1.2.3');
  if (!manifest.description || manifest.description.length > 132) fail('description missing or longer than 132 chars');

  const present = listFiles(SRC);
  const unexpected = present.filter((f) => !FILES.includes(f));
  if (unexpected.length) fail('files in tabnotes/ that are not in the allowlist: ' + unexpected.join(', '));
  const missing = FILES.filter((f) => !present.includes(f));
  if (missing.length) fail('allowlisted files missing: ' + missing.join(', '));
  const unshipped = [...referencedFiles(manifest)].filter((f) => !FILES.includes(f));
  if (unshipped.length) fail('referenced but not shipped: ' + unshipped.join(', '));

  for (const f of FILES.filter((x) => /\.(js|json|html|css)$/.test(x))) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    if (/\bhttps?:\/\/(?!www\.w3\.org\/2000\/svg|\*\/)/.test(text)) fail(`${f} contains a remote URL`);
  }
}

// ---- ZIP (store/deflate, UTF-8 names, forward slashes) ----------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function makeZip(entries) {
  const { time, date } = dosDateTime(ZIP_DATE);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by (MS-DOS / FAT)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Independent reader used to verify the archive that was just written. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error('CRC mismatch for ' + name);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// ---- main ----------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
check(manifest);

const label = `TabNotes-v${manifest.version}`;
const outDir = path.join(DIST, label);
const zipPath = path.join(DIST, label + '.zip');

fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });

const entries = FILES.map((name) => ({ name, data: fs.readFileSync(path.join(SRC, ...name.split('/'))) }));
for (const { name, data } of entries) {
  const dest = path.join(outDir, ...name.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
}

const zip = makeZip(entries);
fs.writeFileSync(zipPath, zip);

const readBack = readZip(fs.readFileSync(zipPath));
const names = [...readBack.keys()];
if (!names.includes('manifest.json')) fail('manifest.json is not at the ZIP root');
if (names.some((n) => n.includes('\\'))) fail('ZIP entry uses a backslash');
if (names.length !== entries.length) fail('ZIP entry count mismatch');
for (const { name, data } of entries) {
  if (!readBack.get(name) || !readBack.get(name).equals(data)) fail('ZIP content mismatch for ' + name);
}

console.log(`Built ${label}`);
console.log('  folder: ' + outDir);
console.log('  zip:    ' + zipPath + ` (${zip.length} bytes, ${entries.length} files)`);
for (const n of names) console.log('    ' + n);
