import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  ipcMain,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from "electron";
import path from "node:path";
import { preserveDesktopIdentity, showProductName } from "./identity";
import { createSecretCodec } from "./secret-codec";
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { launchExternal, registerExternalLinks } from "./external-links";
import { pathToFileURL } from "node:url";
import {
  answerMediaPermissionRequest,
  checkMediaPermission,
  oncePermissionReply,
  type MediaPermissionContext,
  type MediaPermissionDetails,
} from "./permissions";

preserveDesktopIdentity(app);

// Finder launches do not inherit a shell's Homebrew PATH. Keep configured PATH
// entries and add common install locations for ffmpeg, ffprobe and Python.
if (process.platform === "darwin") {
  process.env.PATH = [
    ...new Set(
      [
        ...(process.env.PATH || "").split(path.delimiter),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].filter(Boolean),
    ),
  ].join(path.delimiter);
}

let mainWindow: BrowserWindow | null = null;
let server: { port: number; close: () => Promise<void> } | null = null;
let origin = "";
let shuttingDown = false;

function isLocalApp(url: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function logBrowserEvent(event: { event: string; host?: string }) {
  try {
    const directory = app.getPath("logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "browser.log");
    try {
      if (statSync(file).size > 262144) renameSync(file, file + ".previous");
    } catch {
      /* First event. */
    }
    appendFileSync(
      file,
      JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* Logging must not prevent browser launch. */
  }
}
async function openExternal(url: string) {
  const result = await launchExternal(
    url,
    (value) => shell.openExternal(value),
    logBrowserEvent,
  );
  if (!result.ok && mainWindow && !mainWindow.isDestroyed())
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Browser could not open",
      message: result.error,
    });
}

function logPermissionEvent(event: Record<string, string | boolean | number>) {
  try {
    const directory = app.getPath("logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "recording-permissions.log");
    try {
      if (statSync(file).size > 262144) renameSync(file, file + ".previous");
    } catch {
      /* First event. */
    }
    // Only decision/status metadata: no URLs, device names, window titles,
    // captured content, credentials or transcripts enter this diagnostic log.
    appendFileSync(
      file,
      JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* Diagnostics must never affect permission handling. */
  }
}

function configurePermissions() {
  const ses = session.defaultSession;
  function context(
    contents: Electron.WebContents | null,
    details: MediaPermissionDetails,
    requestingOrigin?: string,
  ): MediaPermissionContext {
    const expectedContents =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    return {
      expectedOrigin: origin,
      rendererUrl: expectedContents?.getURL() ?? "",
      sameWebContents: !!expectedContents && contents === expectedContents,
      requestingOrigin,
      details,
    };
  }
  ses.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      const allowed = checkMediaPermission(
        permission,
        context(contents, details, requestingOrigin),
      );
      if (permission === "media" || permission === "display-capture")
        logPermissionEvent({
          event: "check",
          permission,
          allowed,
          mainFrame: details.isMainFrame === true,
          mediaType: details.mediaType ?? "unspecified",
        });
      return allowed;
    },
  );
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    void answerMediaPermissionRequest({
      permission,
      context: () => context(contents, details),
      callback,
      requestMicrophone: async () => {
        if (process.platform !== "darwin") return true;
        logPermissionEvent({
          event: "microphone-os-request",
          status: systemPreferences.getMediaAccessStatus("microphone"),
        });
        // Await the actual OS request on every trusted mic attempt. Existing
        // denials/grants resolve through macOS; no permission state is reset.
        const granted = await systemPreferences.askForMediaAccess("microphone");
        logPermissionEvent({
          event: "microphone-os-result",
          granted,
          status: systemPreferences.getMediaAccessStatus("microphone"),
        });
        return granted;
      },
      log: (decision) =>
        logPermissionEvent({
          event: "request",
          permission,
          allowed: decision.allowed,
          reason: decision.reason,
        }),
    });
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    // Electron documents null as denial, although its v44 types omit it.
    // https://www.electronjs.org/docs/latest/api/session#setdisplaymediarequesthandlerhandler-opts
    const reply = oncePermissionReply<Electron.Streams | null>(
      (streams) => callback(streams as Electron.Streams),
      () => logPermissionEvent({ event: "display-callback-unavailable" }),
    );
    const trusted = () =>
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      !!request.frame &&
      !request.frame.isDestroyed() &&
      request.frame === mainWindow.webContents.mainFrame &&
      isLocalApp(request.securityOrigin) &&
      request.userGesture &&
      request.audioRequested;
    if (!trusted()) {
      logPermissionEvent({
        event: "display-denied",
        reason: "untrusted-frame-or-missing-gesture-or-audio",
      });
      reply(null);
      return;
    }
    try {
      logPermissionEvent({
        event: "display-os-request",
        screenStatus:
          process.platform === "darwin"
            ? systemPreferences.getMediaAccessStatus("screen")
            : "not-applicable",
      });
      // Do not preemptively reject based on OS status: requesting the source
      // lets macOS show its own permission flow. Only audio is saved downstream.
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (!sources.length || !trusted()) {
        logPermissionEvent({
          event: "display-denied",
          reason: sources.length
            ? "frame-changed-during-source-request"
            : "no-screen-source",
          sourceCount: sources.length,
        });
        reply(null);
        return;
      }
      logPermissionEvent({ event: "display-source-selected" });
      reply({ video: sources[0], audio: "loopback" });
    } catch {
      logPermissionEvent({
        event: "display-denied",
        reason: "system-source-request-failed",
      });
      reply(null);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "NoteThis",
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#fafafa",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  const win = mainWindow;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocalApp(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("will-prevent-unload", (event) => {
    const response = dialog.showMessageBoxSync(win, {
      type: "question",
      title: "Unsaved recording",
      message: "Close NoteThis and discard the unsaved recording?",
      detail: "Save the recording before closing to keep the audio.",
      buttons: ["Keep recording", "Discard and close"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) event.preventDefault();
  });
  void win.loadURL(origin).catch((error) => {
    if (!win.isDestroyed()) {
      dialog.showErrorBox(
        "NoteThis could not load",
        `The local application page could not be opened. Restart NoteThis and try again.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
      win.close();
    }
  });
}

const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow && origin) createWindow();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      showProductName(app);
      // Python helpers must remain real files outside the asar archive.
      process.env.CADENCE_RESOURCE_DIR = app.isPackaged
        ? process.resourcesPath
        : app.getAppPath();
      const serverModule = await import(
        pathToFileURL(path.join(app.getAppPath(), "dist-server", "index.mjs"))
          .href
      );
      const secretCodec = createSecretCodec(safeStorage, process.platform);
      server = await serverModule.startServer({
        port: 0,
        dataDir: app.getPath("userData"),
        staticDir: path.join(app.getAppPath(), "dist"),
        desktop: true,
        secretCodec,
      });
      origin = `http://127.0.0.1:${server!.port}`;
      registerExternalLinks(
        ipcMain,
        (event) =>
          event.sender === mainWindow?.webContents &&
          event.senderFrame === mainWindow?.webContents.mainFrame &&
          isLocalApp(event.senderFrame?.url || ""),
        (url) => shell.openExternal(url),
        logBrowserEvent,
      );
      configurePermissions();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin"
            ? [{ role: "appMenu" as const }]
            : []),
          { role: "fileMenu" },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
          {
            role: "help",
            submenu: [
              {
                label: "Recording and permissions help",
                click: () => {
                  void dialog.showMessageBox({
                    type: "info",
                    title: "Record a meeting",
                    message:
                      "Choose microphone, system audio, or both. Check that each selected input meter moves before recording your call.",
                    detail:
                      (process.platform === "darwin"
                        ? "In System Settings → Privacy & Security, allow NoteThis to use Microphone and System Audio Recording (or Screen & System Audio Recording). Restart NoteThis after changing permissions. "
                        : "Allow microphone and system-audio recording in your operating system privacy settings. System capture availability depends on your platform. ") +
                      "Use headphones to reduce echo. Pause when needed, then finish and save to keep your audio and create the transcript.",
                  });
                },
              },
            ],
          },
        ]),
      );
      createWindow();
      app.on("activate", () => {
        if (!mainWindow) createWindow();
      });
    })
    .catch((error) => {
      console.error("NoteThis startup failed:", error);
      dialog.showErrorBox(
        "NoteThis could not start",
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  // Closing windows first preserves the renderer's unsaved-recording dialog.
  // will-quit below runs only once all windows have accepted closing.
  if (shuttingDown) event.preventDefault();
});
app.on("will-quit", (event) => {
  if (!server || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  const runningServer = server;
  server = null;
  void runningServer
    .close()
    .catch((error) => console.error("Shutdown:", error))
    .finally(() => app.exit(0));
});
