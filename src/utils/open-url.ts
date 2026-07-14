import { spawn } from 'node:child_process';

/** Open an HTTP(S) URL with the platform's default browser. */
export function openUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open unsupported URL protocol: ${parsed.protocol}`);
  }

  let command: string;
  let args: string[];

  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${url}"`];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {
    // Opening the UI is a convenience; the server remains usable if it fails.
  });
  child.unref();
}
