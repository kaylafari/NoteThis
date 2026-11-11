import { useEffect, useState } from "react";
import { ArrowDownToLine, RefreshCw } from "lucide-react";
import type { UpdateAction, UpdateState } from "../shared/updates";
function useUpdates() {
  const [state, setState] = useState<UpdateState>({
    currentVersion: window.desktop?.appVersion || "",
    status: "unavailable",
  });
  useEffect(() => {
    const bridge = window.desktop?.updates;
    if (!bridge) return;
    let active = true,
      received = false;
    const stop = bridge.subscribe((s) => {
      received = true;
      if (active) setState(s);
    });
    void bridge
      .state()
      .then((s) => {
        if (active && !received) setState(s);
      })
      .catch(() => {});
    return () => {
      active = false;
      stop();
    };
  }, []);
  const act = async (action: UpdateAction) => {
    try {
      const result = await window.desktop?.updates?.action(action);
      if (result) setState(result);
    } catch {
      setState((s) => ({
        ...s,
        error:
          "Could not complete the update request. Try again or download the installer.",
      }));
    }
  };
  return { state, act };
}
function message(state: UpdateState) {
  switch (state.status) {
    case "available":
      return `NoteThis ${state.version} is available.`;
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return "Downloading and verifying the update… You can keep using NoteThis.";
    case "ready":
      return `NoteThis ${state.version} is ready. Restart when your work is finished.`;
    case "restarting":
      return "Restarting NoteThis to install the update…";
    case "up-to-date":
      return "You’re up to date.";
    case "unavailable":
      return "In-app updates are available in the installed Apple Silicon Mac app.";
    default:
      return "Check for the latest version of NoteThis.";
  }
}
function Actions({
  state,
  act,
  busy = false,
}: {
  state: UpdateState;
  act: (a: UpdateAction) => Promise<void>;
  busy?: boolean;
}) {
  const pending = ["checking", "downloading", "restarting"].includes(
    state.status,
  );
  return (
    <div className="update-actions">
      {state.status === "ready" ? (
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void act("restart")}
        >
          <RefreshCw size={15} />
          Restart to update
        </button>
      ) : state.version && ["available", "error"].includes(state.status) ? (
        <button
          type="button"
          className="button primary"
          onClick={() => void act("download")}
        >
          <ArrowDownToLine size={15} />
          {state.native ? "Download update" : "Download installer"}
        </button>
      ) : null}
      {state.status !== "unavailable" && (
        <button
          type="button"
          className="button secondary"
          disabled={pending || state.status === "ready"}
          onClick={() => void act("check")}
        >
          {state.status === "checking" ? "Checking…" : "Check for updates"}
        </button>
      )}
      {(state.native || !state.version) && state.status !== "restarting" && (
        <button
          type="button"
          className="inline-link"
          onClick={() => void act("installer")}
        >
          Download installer
        </button>
      )}
    </div>
  );
}
export function UpdatesPanel({ busy = false }: { busy?: boolean }) {
  const { state, act } = useUpdates();
  return (
    <section
      className="settings-section updates-panel"
      aria-label="App updates"
    >
      <h3>NoteThis updates</h3>
      <p>Installed version: {state.currentVersion || "Development build"}</p>
      <p role="status">{message(state)}</p>
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      <Actions state={state} act={act} busy={busy} />
      {busy && state.status === "ready" && (
        <p>
          Save your changes and finish recording or processing before
          restarting.
        </p>
      )}
      <p className="provider-description">
        NoteThis checks GitHub when it opens and every six hours. Downloads
        start only when you choose them. A downloaded update installs when you
        restart or next open the app. Your recordings, notes, settings and
        models stay in place.
      </p>
      <p className="provider-description">
        If automatic installation fails, choose Download installer, quit
        NoteThis, and replace it in Applications.
      </p>
    </section>
  );
}
export function UpdateBanner({ busy = false }: { busy?: boolean }) {
  const { state, act } = useUpdates();
  if (
    !["available", "downloading", "ready", "restarting"].includes(state.status)
  )
    return null;
  return (
    <div className="update-banner" role="status">
      <span>
        {message(state)}
        {state.error && <small>{state.error}</small>}
      </span>
      <Actions state={state} act={act} busy={busy} />
    </div>
  );
}
