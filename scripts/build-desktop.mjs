import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.SUPABASE_URL || '';
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if (url && new URL(url).protocol !== 'https:') throw new Error('Cloud connections must use HTTPS.');
if (publishableKey && !publishableKey.startsWith('sb_publishable_')) {
  let role;
  try { role = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString()).role; } catch {}
  if (role !== 'anon') throw new Error('Only a public Supabase key can be packaged.');
}
await mkdir('desktop-dist', { recursive: true });
await build({ entryPoints: ['desktop/main.ts'], outfile: 'desktop-dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' });
for (const name of ['preload', 'picker-preload']) await build({ entryPoints: [`desktop/${name}.ts`], outfile: `desktop-dist/${name}.cjs`, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
for (const name of ['source-picker.html', 'source-picker.css', 'source-picker.js']) await copyFile(`desktop/${name}`, `desktop-dist/${name}`);
await writeFile('desktop-dist/cloud-config.json', JSON.stringify({ url, publishableKey }));

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, checksum]);
}
function lineDistance(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
function icon(size, template = false) {
  const scan = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) / size, py = (y + 0.5) / size;
    const rounded = Math.hypot(Math.max(Math.abs(px - .5) - .28, 0), Math.max(Math.abs(py - .5) - .28, 0)) < .17;
    const tick = Math.min(lineDistance(px, py, .28, .51, .44, .67), lineDistance(px, py, .44, .67, .73, .34)) < .043;
    const i = y * (size * 4 + 1) + 1 + x * 4;
    scan[i] = scan[i + 1] = scan[i + 2] = template ? 0 : tick ? 255 : 27;
    scan[i + 3] = template ? tick ? 255 : 0 : rounded ? 255 : 0;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
await writeFile('desktop-dist/icon.png', icon(1024));
await writeFile('desktop-dist/tray.png', icon(72, true));
console.info('Desktop files built.');
