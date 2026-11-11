const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    // Finder metadata can be inherited in synced build folders and prevents signing.
    execFileSync('/usr/bin/xattr', ['-cr', join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)]);
  }
};
