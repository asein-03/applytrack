import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const credentials = [
  ['private-key', /(?:^|\n)\s*-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['supabase-secret-key', /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ['google-oauth-secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['google-access-token', /\bya29\.[A-Za-z0-9_-]{20,}/],
  ['google-refresh-token', /\b1\/\/[A-Za-z0-9_-]{40,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
];
const privatePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.local|data|backups?|recordings|screenshots|test-results|playwright-report)(?:\/|$)|\.(?:sqlite\d*(?:-[a-z]+)?|db(?:-[a-z]+)?|eml|p12|pfx|key|pem)$/i;
const testPath = /(?:^|\/)(?:tests?|__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function isPrivateEmail(value) {
  const domain = value.toLowerCase().split('@').at(-1);
  return domain && !['example.com', 'example.org', 'example.net', 'localhost', 'users.noreply.github.com'].includes(domain) && !domain.endsWith('.example') && !domain.endsWith('.localhost') && !domain.endsWith('.local') && !domain.endsWith('.invalid') && !domain.endsWith('.test') && value.toLowerCase() !== 'noreply@github.com';
}
export function inspectContent(path, bytes, { personalEmail = true, knownSecrets = [] } = {}) {
  const text = bytes.toString('utf8');
  const kinds = credentials.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      if (payload.role && payload.role !== 'anon') kinds.push('nonpublic-jwt');
    } catch { /* Non-JWT strings are covered by the provider credential rules. */ }
  }
  if (knownSecrets.some(secret => secret.length >= 8 && bytes.includes(secret))) kinds.push('local-private-value');
  if (personalEmail && [...text.matchAll(emailPattern)].some(match => isPrivateEmail(match[0]))) kinds.push('public-email-literal');
  return [...new Set(kinds)].map(type => ({ path, type }));
}
export function inspectPath(path, packaged = false) {
  const name = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (privatePath.test(name) && !(name === '.env.example' && !packaged)) return [{ path, type: 'private-file-path' }];
  if (packaged && testPath.test(name)) return [{ path, type: 'packaged-test-file' }];
  if (packaged && !/^(?:node_modules|desktop-dist|dist|extension)\/|^package\.json$/.test(name)) return [{ path, type: 'unexpected-package-file' }];
  if (packaged && name.startsWith('desktop-dist/') && !/^desktop-dist\/(?:main\.cjs|preload\.cjs|picker-preload\.cjs|cloud-config\.json|(?:tray|icon)\.png|source-picker\.(?:html|css|js))$/.test(name)) return [{ path, type: 'unexpected-desktop-file' }];
  if (packaged && name.startsWith('extension/') && !/^extension\/(?:manifest\.json|background\.js|content\.js|popup\.(?:html|css|js))$/.test(name)) return [{ path, type: 'unexpected-extension-file' }];
  if (packaged && name.startsWith('dist/') && !/^dist\/(?:index\.html|assets\/[^/]+\.(?:js|css|woff2?|ttf|otf|svg|png|ico)|ocr\/[a-z0-9.-]+\/(?:worker\.min\.js|lang\/eng\.traineddata\.gz|core\/tesseract-core(?:-simd)?(?:-lstm)?\.wasm(?:\.js)?))$/.test(name)) return [{ path, type: 'unexpected-web-file' }];
  return [];
}
export function inspectCloudConfig(path, bytes) {
  try {
    const config = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(config).sort().join(',') !== 'publishableKey,url' || typeof config.url !== 'string' || typeof config.publishableKey !== 'string') return [{ path, type: 'unexpected-cloud-config' }];
    if (config.url && new URL(config.url).protocol !== 'https:') return [{ path, type: 'insecure-cloud-url' }];
    if (!config.publishableKey || /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) return [];
    const payload = JSON.parse(Buffer.from(config.publishableKey.split('.')[1] || '', 'base64url').toString('utf8'));
    return payload.role === 'anon' ? [] : [{ path, type: 'nonpublic-cloud-key' }];
  } catch { return [{ path, type: 'invalid-cloud-config' }]; }
}

function git(args, options = {}) { return execFileSync('git', args, { maxBuffer: 128 * 1024 * 1024, ...options }); }
function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesIn(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}
export async function runGate(args = process.argv.slice(2)) {
  const findings = [], knownSecrets = [], counts = { sourceFiles: 0, historicalBlobs: 0, builtFiles: 0, archiveFiles: 0 };
  if (existsSync('.env')) {
    const values = parseEnv(readFileSync('.env', 'utf8'));
    for (const [key, value] of Object.entries(values)) if (/(?:SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|KEY)/i.test(key) && !/(?:PUBLISHABLE|ANON)/i.test(key) && value.length >= 8) knownSecrets.push(Buffer.from(value));
  }
  if (existsSync('data/mail-key')) knownSecrets.push(readFileSync('data/mail-key'));
  const scan = (path, bytes, options = {}) => {
    findings.push(...inspectContent(path, bytes, { personalEmail: !/^(?:(?:history:)?package-lock\.json$|(?:archive:)?dist\/ocr\/)/.test(path), knownSecrets, ...options }));
    if (path.endsWith('desktop-dist/cloud-config.json')) findings.push(...inspectCloudConfig(path, bytes));
  };
  for (const path of git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) {
    if (!existsSync(path)) continue;
    findings.push(...inspectPath(path)); scan(path, readFileSync(path)); counts.sourceFiles++;
  }
  if (args.includes('--history')) {
    const objects = git(['rev-list', '--objects', '--all']).toString().split('\n').filter(Boolean);
    const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: objects.map(line => line.split(' ')[0]).join('\n') }).toString().trim().split('\n');
    for (let index = 0; index < types.length; index++) {
      if (!types[index].endsWith(' blob')) continue;
      const [id] = types[index].split(' '); const path = objects[index].slice(id.length + 1);
      findings.push(...inspectPath(path)); scan(`history:${path}`, git(['cat-file', 'blob', id])); counts.historicalBlobs++;
    }
  }
  if (args.includes('--build')) for (const directory of ['dist', 'desktop-dist']) {
    if (!existsSync(directory)) { findings.push({ path: directory, type: 'missing-build-output' }); continue; }
    for (const path of filesIn(directory)) { findings.push(...inspectPath(path, true)); scan(path, readFileSync(path)); counts.builtFiles++; }
  }
  const archiveIndex = args.indexOf('--archive');
  if (archiveIndex !== -1) {
    const archive = args[archiveIndex + 1];
    if (!archive || !existsSync(archive)) findings.push({ path: 'app.asar', type: 'missing-archive' });
    else {
      const asar = await import('@electron/asar');
      const names = asar.listPackage(archive);
      for (const entry of names) {
        const path = entry.replace(/^\//, ''); const stat = asar.statFile(archive, path);
        if (stat.files) continue;
        findings.push(...inspectPath(path, true));
        if (stat.link) { findings.push({ path, type: 'archive-symlink' }); continue; }
        const bytes = asar.extractFile(archive, path);
        scan(`archive:${path}`, bytes, { personalEmail: !path.startsWith('node_modules/') && !path.startsWith('dist/ocr/') }); counts.archiveFiles++;
      }
      for (const required of ['desktop-dist/main.cjs', 'desktop-dist/cloud-config.json', 'dist/index.html', 'extension/manifest.json', 'package.json']) if (!names.includes(`/${required}`)) findings.push({ path: required, type: 'missing-package-file' });
    }
  }
  const emailBaseIndex = args.indexOf('--email-base');
  if (emailBaseIndex !== -1) {
    const base = args[emailBaseIndex + 1];
    if (!/^[a-f0-9]{40}$/.test(base || '') || /^0+$/.test(base)) throw new Error('Provide a valid commit ID for the new-commit email check.');
    let range = 'HEAD';
    try {
      git(['cat-file', '-e', `${base}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      range = `${base}..HEAD`;
    } catch { /* After a history rewrite, audit every current commit if the previous base is unavailable. */ }
    for (const row of git(['log', range, '--format=%H%x09%ae%x09%ce']).toString().trim().split('\n').filter(Boolean)) {
      const [id, author, committer] = row.split('\t');
      if (isPrivateEmail(author)) findings.push({ path: `commit:${id}`, type: 'public-author-email' });
      if (isPrivateEmail(committer)) findings.push({ path: `commit:${id}`, type: 'public-committer-email' });
    }
  }
  const unique = [...new Map(findings.map(item => [`${item.path}:${item.type}`, item])).values()];
  console.info(JSON.stringify({ ...counts, findings: unique }, null, 2));
  return unique.length ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runGate(); }
  catch { console.error('Security gate could not complete. No credential values were logged.'); process.exitCode = 1; }
}
