import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { startServer } from '../server.mjs';

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
