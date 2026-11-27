const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Electron-builder afterPack hook:
 * Re-applies a valid ad-hoc code signature on macOS bundles when building without
 * a commercial Apple Developer certificate, preventing macOS Gatekeeper from
 * misreporting the app as "damaged" after Chrome/Safari quarantine.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK) return; // Paid certificate signing will run in normal sign phase

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[afterPack] Ad-hoc re-signing macOS bundle: ${appPath}`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] Verified valid ad-hoc signature on ${appName}`);
};
