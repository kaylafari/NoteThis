import { app, BrowserWindow, desktopCapturer, dialog, Menu, safeStorage, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

app.setName('Cadence');

// Finder launches do not inherit a shell's Homebrew PATH. Keep configured PATH
// entries and add common install locations for ffmpeg, ffprobe and Python.
if (process.platform === 'darwin') {
  process.env.PATH = [...new Set([...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(path.delimiter);
}

let mainWindow: BrowserWindow | null = null;
let server: { port: number; close: () => Promise<void> } | null = null;
let origin = '';
let shuttingDown = false;

function isLocalApp(url: string) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function openExternal(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
      void shell.openExternal(parsed.href).catch(() => undefined);
    }
  } catch { /* Disallow malformed URLs and executable URL schemes. */ }
}

function configurePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const local = contents === mainWindow?.webContents && isLocalApp(requestingOrigin) && details.isMainFrame;
    if (!local) return false;
    if (permission === 'media') return details.mediaType === 'audio';
    return permission === 'display-capture';
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const local = contents === mainWindow?.webContents && isLocalApp(details.requestingUrl) && details.isMainFrame;
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
    const audioOnly = permission === 'media' && mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio');
    callback(Boolean(local && (audioOnly || permission === 'display-capture')));
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!mainWindow || request.frame !== mainWindow.webContents.mainFrame || !isLocalApp(request.securityOrigin) || !request.userGesture || !request.audioRequested) {
      callback({});
      return;
    }
    try {
      // A tiny video source is required by Chromium's getDisplayMedia API. The
      // renderer sends only the mixed audio track to MediaRecorder.
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length || request.frame?.isDestroyed()) { callback({}); return; }
      callback({ video: sources[0], audio: 'loopback' });
    } catch (error) {
      console.error('System-audio capture permission or source error:', error);
      callback({});
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Cadence',
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#f4f1eb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  const win = mainWindow;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalApp(url)) { event.preventDefault(); openExternal(url); }
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'Unsaved recording',
      message: 'Close Cadence and discard the unsaved recording?',
      detail: 'Save the recording before closing to keep the audio.',
      buttons: ['Keep recording', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) event.preventDefault();
  });
  void win.loadURL(origin).catch(error => {
    if (!win.isDestroyed()) {
      dialog.showErrorBox('Cadence could not load', `The local application page could not be opened. Restart Cadence and try again.\n\n${error instanceof Error ? error.message : String(error)}`);
      win.close();
    }
  });
}

const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow && origin) createWindow();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    // Python helpers must remain real files outside the asar archive.
    process.env.CADENCE_RESOURCE_DIR = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const serverModule = await import(pathToFileURL(path.join(app.getAppPath(), 'dist-server', 'index.mjs')).href);
    const secretCodec = {
      encrypt(value: string) {
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
          throw new Error('The operating system secure credential store is unavailable. Unlock your keychain or configure a system keyring before saving provider credentials.');
        }
        return safeStorage.encryptString(value).toString('base64');
      },
      decrypt(value: string) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock the operating system credential store to access saved credentials.');
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
      },
    };
    server = await serverModule.startServer({
      port: 0,
      dataDir: app.getPath('userData'),
      staticDir: path.join(app.getAppPath(), 'dist'),
      desktop: true,
      secretCodec,
    });
    origin = `http://127.0.0.1:${server!.port}`;
    configurePermissions();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Recording and permissions help', click: () => {
        void dialog.showMessageBox({
          type: 'info',
          title: 'Record a meeting',
          message: 'Choose microphone, system audio, or both. Check that each selected input meter moves before recording your call.',
          detail: (process.platform === 'darwin'
            ? 'In System Settings → Privacy & Security, allow Cadence to use Microphone and System Audio Recording (or Screen & System Audio Recording). Restart Cadence after changing permissions. '
            : 'Allow microphone and system-audio recording in your operating system privacy settings. System capture availability depends on your platform. ') + 'Use headphones to reduce echo. Pause when needed, then finish and save to keep your audio and create the transcript.',
        });
      } }] },
    ]));
    createWindow();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
  }).catch(error => {
    console.error('Cadence startup failed:', error);
    dialog.showErrorBox('Cadence could not start', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  // Closing windows first preserves the renderer's unsaved-recording dialog.
  // will-quit below runs only once all windows have accepted closing.
  if (shuttingDown) event.preventDefault();
});
app.on('will-quit', event => {
  if (!server || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  const runningServer = server;
  server = null;
  void runningServer.close().catch(error => console.error('Shutdown:', error)).finally(() => app.exit(0));
});
