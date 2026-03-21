import activeWindow from 'active-win';
import { spawn } from 'node:child_process';
import windowManagerPackage from 'node-window-manager';
import { createEmptyActiveContext, isProbablyBrowser } from '../shared/models.js';

const { windowManager } = windowManagerPackage;

export class WindowsService {
  captureSystemContext() {
    const current = activeWindow.sync();
    if (!current) {
      return createEmptyActiveContext();
    }

    const processName = current.owner?.name ?? '';
    const processPath = current.owner?.path ?? '';
    return {
      timestamp: new Date().toISOString(),
      source: 'windows',
      title: current.title ?? '',
      windowId: current.id ?? null,
      processId: current.owner?.processId ?? null,
      processName,
      processPath,
      isBrowser: isProbablyBrowser(processName) || isProbablyBrowser(processPath),
      browserName: isProbablyBrowser(processName) ? processName : '',
      url: '',
      domain: '',
      confidence: 0.55,
    };
  }

  minimizeWindow(windowId) {
    const win = this.#findWindow(windowId);
    if (!win) {
      return false;
    }

    try {
      win.minimize();
      return true;
    } catch {
      return false;
    }
  }

  restoreWindow(windowId) {
    const win = this.#findWindow(windowId);
    if (!win) {
      return false;
    }

    try {
      win.restore();
      win.bringToTop();
      return true;
    } catch {
      return false;
    }
  }

  async closeActiveBrowserTab(windowId) {
    const win = this.#findWindow(windowId);
    if (!win) {
      return false;
    }

    try {
      win.bringToTop();
    } catch {
      // ignore
    }

    const script = `$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 40; $wshell.SendKeys('^w')`;
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ], {
        windowsHide: true,
        stdio: 'ignore',
      });

      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  #findWindow(windowId) {
    if (windowId == null) {
      return null;
    }

    return windowManager.getWindows().find((candidate) => candidate.id === windowId && candidate.isWindow());
  }
}

export default WindowsService;
