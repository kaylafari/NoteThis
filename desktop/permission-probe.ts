/** Isolated test entrypoint: fake devices only; never asks macOS for capture. */
import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import {
  answerMediaPermissionRequest,
  checkMediaPermission,
  oncePermissionReply,
  type MediaPermissionContext,
  type MediaPermissionDetails,
} from "./permissions";

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
const output = app.commandLine.getSwitchValue("cadence-probe-result");
const server = createServer((_req, response) =>
  response.end("<!doctype html><title>Cadence permission regression</title>"),
);
const report = {
  microphoneRequests: 0,
  emptyPreflightObserved: false,
  displayReached: false,
  displayTrusted: false,
  cameraDenied: false,
  results: [] as Array<{ kind: string; result: string }>,
};
const timeout = setTimeout(() => {
  if (output)
    writeFileSync(
      output,
      JSON.stringify({ error: "probe-timeout", ...report }),
    );
  app.exit(2);
}, 35_000);

void app
  .whenReady()
  .then(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const context = (
      contents: Electron.WebContents | null,
      details: MediaPermissionDetails,
      requestingOrigin?: string,
    ): MediaPermissionContext => ({
      expectedOrigin: origin,
      rendererUrl: win.webContents.getURL(),
      sameWebContents: contents === win.webContents,
      requestingOrigin,
      details,
    });
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details) =>
        checkMediaPermission(
          permission,
          context(contents, details, requestingOrigin),
        ),
    );
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        void answerMediaPermissionRequest({
          permission,
          context: () => context(contents, details),
          callback,
          // Stub only the OS call: Chromium's actual permission/request path and
          // production authorization helper remain in use with fake audio devices.
          requestMicrophone: async () => {
            report.microphoneRequests++;
            return true;
          },
          log: (decision) => {
            if (decision.kind === "display-preflight" && decision.allowed)
              report.emptyPreflightObserved = true;
            if (
              decision.reason === "camera-or-unsupported-media" &&
              !decision.allowed
            )
              report.cameraDenied = true;
          },
        });
      },
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        report.displayReached = true;
        report.displayTrusted =
          request.frame === win.webContents.mainFrame &&
          request.securityOrigin.replace(/\/$/, "") === origin &&
          request.userGesture &&
          request.audioRequested;
        // Documented null denial settles the renderer promise without ever calling
        // desktopCapturer/getSources or accessing the real screen/system audio.
        const deny = oncePermissionReply<Electron.Streams | null>((value) =>
          callback(value as Electron.Streams),
        );
        deny(null);
      },
    );
    await win.loadURL(origin);
    // The first fake audio device can initialize slowly when the full suite
    // launches other Electron processes. Keep a finite per-request deadline.
    for (const kind of ["microphone", "microphone", "camera", "display"]) {
      const request =
        kind === "display"
          ? "getDisplayMedia({audio:true,video:true})"
          : kind === "camera"
            ? "getUserMedia({audio:false,video:true})"
            : "getUserMedia({audio:true,video:false})";
      const result = (await win.webContents.executeJavaScript(
        `Promise.race([(async()=>{try{const stream=await navigator.mediaDevices.${request};stream.getTracks().forEach(track=>track.stop());return 'success';}catch(error){return error.name;}})(),new Promise(resolve=>setTimeout(()=>resolve('request-timeout'),10000))])`,
        true,
      )) as string;
      report.results.push({ kind, result });
      if (result === "request-timeout")
        throw new Error(
          `Native ${kind} request did not settle within 10 seconds`,
        );
    }
    clearTimeout(timeout);
    writeFileSync(output, JSON.stringify(report));
    server.close();
    app.exit(0);
  })
  .catch(() => {
    clearTimeout(timeout);
    if (output)
      writeFileSync(
        output,
        JSON.stringify({ error: "probe-failed", ...report }),
      );
    app.exit(1);
  });
