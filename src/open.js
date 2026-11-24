// Open a URL or file in the default browser. No shell is involved, so odd characters in
// a path can't be interpreted as commands. Failing to open is never an error: we always
// print the address as well.

import { spawn } from 'node:child_process';

export function openInBrowser(target) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['explorer.exe', [target]]
        : ['xdg-open', [target]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
