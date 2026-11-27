import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { startServer } from '../server.mjs';
import { checkLatestGithubRelease, downloadReleaseAsset } from './updater.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');

let mainWindow = null;
let serverHandle = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function isLocalAppUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

async function resolveInitialStudyDir() {
  const unpackedExamples = path
    .join(APP_ROOT, 'examples')
    .replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  for (const candidate of [unpackedExamples, path.join(APP_ROOT, 'examples')]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return path.join(os.homedir(), 'Documents');
}

async function pickFolderWithElectronDialog(defaultPath) {
  try {
    const res = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Seleccionar carpeta de apuntes — Speaking AI Professor',
      defaultPath: defaultPath || os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths?.length) {
      return { ok: true, cancelled: true };
    }
    return { ok: true, cancelled: false, folderPath: res.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message || 'Dialog failed' };
  }
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'Acerca de Speaking AI Professor' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Salir de Speaking AI Professor' },
            ],
          },
        ]
      : []),
    {
      label: 'Archivo',
      submenu: [
        {
          label: 'Abrir carpeta de apuntes...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                `document.getElementById('changeFolderBtn')?.click()`,
                true,
              ).catch(() => {});
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { role: 'forceReload', label: 'Forzar recarga' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamaño real' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollador' },
      ],
    },
    {
      label: 'Ventana',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Buscar actualizaciones...',
          click: () => runUpdateCheck({ interactive: true }),
        },
        { type: 'separator' },
        {
          label: 'Descargar Ollama (IA Local $0)',
          click: () => shell.openExternal('https://ollama.com/download'),
        },
        {
          label: 'Obtener API Key gratuita de Gemini',
          click: () => shell.openExternal('https://aistudio.google.com/apikey'),
        },
        { type: 'separator' },
        {
          label: 'Repositorio en GitHub',
          click: () => shell.openExternal('https://github.com/PedroRoigM/speaking-ai-professor'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let updateCheckInFlight = false;

async function runUpdateCheck({ interactive = false } = {}) {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    const info = await checkLatestGithubRelease({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPortable,
    });

    if (!info.ok) {
      if (interactive && mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Buscar actualizaciones',
          message: 'No se pudo comprobar si hay actualizaciones en este momento.',
          detail: info.error || 'Comprueba tu conexión a internet e inténtalo de nuevo.',
          buttons: ['Entendido'],
        });
      }
      return;
    }

    if (!info.hasUpdate) {
      if (interactive && mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Speaking AI Professor está actualizado',
          message: `Ya tienes la última versión (v${info.currentVersion}).`,
          buttons: ['Genial'],
        });
      }
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) return;

    const sizeMb = info.asset?.size ? ` (~${(info.asset.size / (1024 * 1024)).toFixed(0)} MB)` : '';
    const detailLines = [
      `Versión actual: v${info.currentVersion}  →  Nueva versión: ${info.latestTag}${sizeMb}`,
      info.releaseNotes ? `\nNovedades:\n${info.releaseNotes}` : '',
      info.asset
        ? '\nSi pulsas «Actualizar ahora», se descargará automáticamente el instalador exacto para tu ordenador.'
        : '\nPuedes descargar la nueva versión desde la página oficial de GitHub Releases.',
    ]
      .filter(Boolean)
      .join('\n');

    const buttons = info.asset
      ? ['Actualizar ahora', 'Ver novedades en GitHub', 'Más tarde']
      : ['Abrir GitHub Releases', 'Más tarde'];

    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Nueva versión disponible — Speaking AI Professor',
      message: `Hay una nueva actualización disponible (${info.latestTag})`,
      detail: detailLines,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });

    if (!info.asset) {
      if (choice.response === 0) shell.openExternal(info.releaseUrl).catch(() => {});
      return;
    }

    if (choice.response === 1) {
      shell.openExternal(info.releaseUrl).catch(() => {});
      return;
    }
    if (choice.response !== 0) return;

    // User confirmed update: download exact installer with live progress in title & dock/taskbar!
    const origTitle = mainWindow.getTitle();
    try {
      mainWindow.setProgressBar(0.05);
      const downloadedPath = await downloadReleaseAsset(info.asset.url, info.asset.name, ({ pct, downloadedMb, totalMb }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setTitle(`Descargando ${info.latestTag} — ${pct}% (${downloadedMb} / ${totalMb} MB) · Speaking AI Professor`);
          mainWindow.setProgressBar(Math.max(0.05, Math.min(0.99, pct / 100)));
        }
      });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(-1);
        mainWindow.setTitle(origTitle);
      }

      if (process.platform === 'win32') {
        if (isPortable) {
          shell.showItemInFolder(downloadedPath);
          spawn(downloadedPath, [], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn(downloadedPath, [], { detached: true, stdio: 'ignore' }).unref();
        }
        app.quit();
        return;
      }

      if (process.platform === 'darwin') {
        await shell.openPath(downloadedPath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Instalador listo',
            message: `Se ha abierto ${info.asset.name}`,
            detail: 'Arrastra «Speaking AI Professor» a la carpeta Aplicaciones y elige Reemplazar. Esta ventana se cerrará ahora para permitir el reemplazo.',
            buttons: ['Cerrar y actualizar'],
          });
        }
        app.quit();
        return;
      }

      // Linux AppImage
      shell.showItemInFolder(downloadedPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Actualización descargada',
          message: `Nueva versión guardada: ${info.asset.name}`,
          detail: `Se ha descargado con permisos de ejecución en:\n${downloadedPath}`,
          buttons: ['Entendido'],
        });
      }
    } catch (dlErr) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(-1);
        mainWindow.setTitle(origTitle);
        const retryChoice = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Error al descargar la actualización',
          message: 'No se pudo descargar el instalador automáticamente.',
          detail: dlErr.message || 'Puedes descargarlo directamente desde GitHub Releases.',
          buttons: ['Abrir en navegador', 'Cerrar'],
          defaultId: 0,
        });
        if (retryChoice.response === 0) shell.openExternal(info.releaseUrl).catch(() => {});
      }
    }
  } finally {
    updateCheckInFlight = false;
  }
}

function createMainWindow(url) {
  const iconPath = path.join(APP_ROOT, 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f131a',
    title: 'Speaking AI Professor',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl && !isLocalAppUrl(targetUrl)) {
      shell.openExternal(targetUrl).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl && !isLocalAppUrl(targetUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl).catch(() => {});
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(url);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    if (isLocalAppUrl(url) && (permission === 'media' || permission === 'clipboard-sanitized-write')) {
      return callback(true);
    }
    callback(false);
  });

  buildAppMenu();

  try {
    const initialDir = await resolveInitialStudyDir();
    serverHandle = await startServer({
      dir: initialDir,
      port: 3456,
      open: false,
      pickFolderNative: pickFolderWithElectronDialog,
    });
    createMainWindow(serverHandle.url);
    // Non-blocking background update check 3.5s after app launch (only prompts if a newer GitHub Release exists!)
    setTimeout(() => {
      runUpdateCheck({ interactive: false }).catch(() => {});
    }, 3500);
  } catch (err) {
    dialog.showErrorBox(
      'Speaking AI Professor — Error al iniciar',
      `No se pudo iniciar el servidor local del aula:\n\n${err.message || err}`,
    );
    app.quit();
  }

  app.on('activate', () => {
    if (!mainWindow && serverHandle?.url) {
      createMainWindow(serverHandle.url);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (isQuitting || !serverHandle) return;
  isQuitting = true;
  event.preventDefault();
  try {
    await serverHandle.close();
  } catch {}
  serverHandle = null;
  app.exit(0);
});
