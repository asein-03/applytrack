import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const versions = { 'tesseract.js': '6.0.1', 'tesseract.js-core': '6.1.2', '@tesseract.js-data/eng': '1.0.0' };
const packages = {};
for (const [name, expected] of Object.entries(versions)) {
  const manifest = require.resolve(`${name}/package.json`);
  const installed = JSON.parse(await readFile(manifest, 'utf8'));
  if (installed.version !== expected) throw new Error(`OCR preparation requires ${name}@${expected}. Run npm ci with the committed lockfile.`);
  packages[name] = dirname(manifest);
}
const runtime = 'tesseract-6.0.1-core-6.1.2-eng-1.0.0';
const files = [
  ['worker.min.js', join(packages['tesseract.js'], 'dist/worker.min.js')],
  ['lang/eng.traineddata.gz', join(packages['@tesseract.js-data/eng'], '4.0.0_best_int/eng.traineddata.gz')],
  ...['tesseract-core', 'tesseract-core-simd', 'tesseract-core-lstm', 'tesseract-core-simd-lstm'].flatMap(name =>
    ['.wasm.js', '.wasm'].map(extension => [`core/${name}${extension}`, join(packages['tesseract.js-core'], `${name}${extension}`)])),
];
// npm ci verifies these pinned packages against package-lock.json integrity hashes.
const assets = await Promise.all(files.map(async ([name, path]) => ({ name, bytes: await readFile(path) })));
const output = join(root, 'public/ocr');
await rm(output, { recursive: true, force: true });
for (const { name, bytes } of assets) {
  const destination = join(output, runtime, name);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
console.info('Prepared local OCR runtime and English language data.');
