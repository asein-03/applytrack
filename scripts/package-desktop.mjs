import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Build outside synced folders: Finder can restore metadata during code signing.
const staging = await mkdtemp(join(tmpdir(), 'applytrack-package-'));
try {
  execFileSync(process.execPath, ['node_modules/electron-builder/cli.js', '--mac', '--arm64', `--config.directories.output=${staging}`], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/security-gate.mjs', '--archive', join(staging, 'mac-arm64', 'ApplyTrack.app', 'Contents', 'Resources', 'app.asar')], { stdio: 'inherit' });
  await mkdir('release', { recursive: true });
  for (const name of await readdir(staging)) if (/\.(dmg|zip|blockmap)$/.test(name)) await cp(join(staging, name), resolve('release', name));
  console.info('Installers saved in release/.');
} finally { await rm(staging, { recursive: true, force: true }); }
