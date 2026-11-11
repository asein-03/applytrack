import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { build } = JSON.parse(await readFile('package.json', 'utf8'));
const arch = process.env.APPLY_BUILD_ARCH || process.arch;
if (!['darwin', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Package on a supported Mac or Windows build host.');
const mac = process.platform === 'darwin';
if (!mac && arch !== 'x64') throw new Error('The Windows beta currently supports x64.');
// Build outside synced folders: Finder can restore metadata during code signing.
const staging = await mkdtemp(join(tmpdir(), 'applytrack-package-'));
try {
  execFileSync(process.execPath, ['node_modules/electron-builder/cli.js', mac ? '--mac' : '--win', `--${arch}`, '--publish', 'never', `--config.directories.output=${staging}`], { stdio: 'inherit' });
  const unpacked = join(staging, mac ? arch === 'arm64' ? 'mac-arm64' : 'mac' : 'win-unpacked');
  const app = mac ? join(unpacked, `${build.productName}.app`, 'Contents') : unpacked;
  execFileSync(process.execPath, ['scripts/security-gate.mjs', '--archive', join(app, mac ? 'Resources' : 'resources', 'app.asar')], { stdio: 'inherit' });
  if (process.env.APPLY_PACKAGE_SMOKE === '1') {
    if (arch !== process.arch) throw new Error('Native smoke checks require a matching host architecture.');
    const executable = mac ? join(app, 'MacOS', build.productName) : join(app, `${build.productName}.exe`);
    execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.desktop.config.ts'], {
      stdio: 'inherit', env: { ...process.env, APPLY_DESKTOP_EXECUTABLE: executable },
    });
  }
  await mkdir('release', { recursive: true });
  for (const name of await readdir(staging)) if (/\.(dmg|zip|exe|blockmap)$/.test(name)) await cp(join(staging, name), resolve('release', name));
  console.info('Installers saved in release/.');
} finally { await rm(staging, { recursive: true, force: true }); }
