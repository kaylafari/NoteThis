import { useEffect, useRef, useState } from "react";
import { Check, Download, LoaderCircle } from "lucide-react";
import { api, type LocalSetupStatus } from "./api";

/** The backend owns progress, so reopening settings reconnects to a running job. */
export function LocalPreparation({
  onReady,
}: {
  onReady?: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const requestId = useRef(0);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const previous = useRef<string | null>(null);

  function apply(value: LocalSetupStatus) {
    if (
      !value ||
      !["idle", "running", "ready", "error"].includes(value.state) ||
      typeof value.message !== "string"
    )
      throw new Error(
        "Local preparation status is unavailable. Try checking again.",
      );
    setStatus(value);
    setError("");
    if (value.state === "ready" && previous.current !== "ready")
      void Promise.resolve()
        .then(() => readyCallback.current?.())
        .catch(() => {});
    previous.current = value.state;
  }
  async function check() {
    const id = ++requestId.current;
    setBusy(true);
    try {
      const value = await api.localSetup();
      if (active.current && id === requestId.current) apply(value);
    } catch (cause) {
      if (active.current && id === requestId.current)
        setError((cause as Error).message);
    } finally {
      if (active.current && id === requestId.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void check();
    return () => {
      active.current = false;
      requestId.current++;
    };
  }, []);
  useEffect(() => {
    if (status?.state !== "running" || error) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const id = ++requestId.current;
      try {
        const value = await api.localSetup();
        if (canceled || !active.current || id !== requestId.current) return;
        apply(value);
        if (value.state === "running") timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!canceled && active.current && id === requestId.current)
          setError((cause as Error).message);
      }
    }
    timer = setTimeout(poll, 1500);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [status?.state, error]);
  async function prepare() {
    if (busy || status?.state === "running") return;
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const value = await api.prepareLocal();
      if (active.current && id === requestId.current) apply(value);
    } catch (cause) {
      if (active.current && id === requestId.current)
        setError((cause as Error).message);
    } finally {
      if (active.current && id === requestId.current) setBusy(false);
    }
  }
  const running = status?.state === "running";
  const label = error
    ? "Check status"
    : running
      ? "Preparing local AI…"
      : status?.state === "ready"
        ? "Check local AI"
        : status?.state === "error"
          ? "Retry preparation"
          : "Prepare local AI";
  return (
    <section className="local-preparation" aria-label="Prepare local AI">
      <div>
        <h4>Get your local AI ready</h4>
        <p>
          The desktop installer includes the runtime tools. Prepare local AI
          downloads the required model files; allow a few minutes, an internet
          connection, and free disk space. Your recordings are not uploaded
          during preparation.
        </p>
      </div>
      <button
        type="button"
        className="button primary"
        disabled={busy || (running && !error) || (!status && !error)}
        onClick={() =>
          void (error || status?.state === "ready" ? check() : prepare())
        }
      >
        {busy || (running && !error) ? (
          <LoaderCircle size={15} className="spin" />
        ) : status?.state === "ready" ? (
          <Check size={15} />
        ) : (
          <Download size={15} />
        )}
        {label}
      </button>
      {status && (
        <p
          className="local-preparation-status"
          role="status"
          data-state={status.state}
        >
          {status.message ||
            (running
              ? "Preparing your local models…"
              : status.state === "ready"
                ? "Local AI is ready."
                : "Ready when you are.")}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {status?.state === "error" && !error && (
        <p className="local-preparation-hint">
          Your recordings and settings are unchanged. You can retry preparation
          when the issue is resolved.
        </p>
      )}
    </section>
  );
}

export function HelpContent({
  onLocalReady,
  onOpenModels,
}: {
  onLocalReady?: () => void | Promise<void>;
  onOpenModels?: () => void | Promise<void>;
}) {
  return (
    <div className="help-content">
      <p className="help-intro">
        Keep the conversation. Find the important parts later.
      </p>
      <section className="help-account">
        <h3>Connect your own ChatGPT account</h3>
        <p>
          For meeting summaries and questions, a suggested setup is{" "}
          <strong>ChatGPT Plus/Pro (Codex Subscription)</strong> with{" "}
          <strong>gpt-6.1-sol</strong>, if that model appears in your connected
          account’s current list. Otherwise choose a model your account offers.
          You sign in to your own account; NoteThis does not provide a shared
          subscription.
        </p>
        <ol>
          <li>
            Open <strong>Settings → AI models → Meeting intelligence</strong>.
            Under <strong>Provider</strong>, choose{" "}
            <strong>ChatGPT Plus/Pro (Codex Subscription)</strong>.
          </li>
          <li>
            Click <strong>Sign in</strong>, then{" "}
            <strong>Open secure sign-in</strong>. Finish signing in in your
            browser, then return to NoteThis. If you are already connected, you
            can skip this step; <strong>Reconnect</strong> starts a new sign-in
            when needed.
          </li>
          <li>
            Click <strong>Refresh models</strong> beside the model list, choose
            an available model, then click <strong>Save preferences</strong>.
          </li>
          <li>
            For questions that need current information, consider turning on{" "}
            <strong>Allow web search</strong> only when the selected model
            supports it. Read and agree to the on-screen disclosure first: your
            question and relevant transcript excerpts go to that provider and
            may be used for web queries. Save your preference afterward.
          </li>
        </ol>
        <p>
          Connecting ChatGPT is for meeting intelligence. Speech transcription
          is configured separately; this connection does not include a cloud
          speech-to-text service.
        </p>
        {onOpenModels && (
          <button
            type="button"
            className="button secondary"
            onClick={() => void onOpenModels()}
          >
            Open AI models
          </button>
        )}
      </section>
      <div className="help-steps">
        <section>
          <span className="help-step-number">01</span>
          <h3>Record a call or upload audio</h3>
          <p>
            Choose <strong>Record meeting</strong> to capture your microphone,
            the sound playing on your computer, or both. Choose{" "}
            <strong>Import audio</strong> for a recording you already have. Make
            sure everyone knows the call is being recorded.
          </p>
        </section>
        <section>
          <span className="help-step-number">02</span>
          <h3>Save, then let the notes arrive</h3>
          <p>
            After you stop and save a recording—or finish an upload—NoteThis
            starts transcription. The transcript and meeting notes appear when
            processing finishes. Your audio stays available if processing needs
            a retry.
          </p>
        </section>
        <section>
          <span className="help-step-number">03</span>
          <h3>Listen and jump to a moment</h3>
          <p>
            Play the audio to follow the highlighted words, karaoke style. Click
            a word or timestamp in the transcript to jump to that moment. Use
            transcript search to find a name, topic, or decision.
          </p>
        </section>
        <section>
          <span className="help-step-number">04</span>
          <h3>Turn a meeting into next steps</h3>
          <p>
            Open <strong>Summary</strong> for the overview and decisions, and{" "}
            <strong>Actions</strong> to check off tasks. Rich summaries can
            include LaTeX formulas, tables, and charts; you can view their
            source or export them. Use <strong>Ask this meeting</strong> to ask
            about the call, then follow its timestamp citations back to the
            recording.
          </p>
        </section>
      </div>
      <section className="help-note">
        <h3>Choose where your meeting is processed</h3>
        <p>
          The default open-source speech and language models run locally on your
          computer. In <strong>AI models</strong>, you can choose a cloud
          provider and add its API key or use browser sign-in where available.
          Cloud speech providers receive audio; cloud language models receive
          transcript text. Availability depends on your account.
        </p>
        <p>
          Optional web search and summary diagrams have separate settings and
          explain what is sent. They are off until you enable them for a
          supported provider.
        </p>
      </section>
      <section className="help-note">
        <h3>When macOS asks for permission</h3>
        <p>
          NoteThis requests access when you start recording. Allow{" "}
          <strong>Microphone</strong> for your voice and{" "}
          <strong>Screen & System Audio Recording</strong> (called Screen
          Recording on some macOS versions) for call audio. If access was
          denied, open <strong>System Settings → Privacy & Security</strong>,
          enable NoteThis under the permission named in the error, then reopen
          the app if macOS asks you to.
        </p>
        <p>
          In a browser, choose a sharing source with audio and enable the
          audio-sharing checkbox when it is offered. The microphone and
          system-audio meters help you check that both sides of a call are being
          captured.
        </p>
      </section>
      <LocalPreparation onReady={onLocalReady} />
      <p className="help-footnote">
        You can return to this guide anytime in Settings → Help & tips. Larger
        models take longer to download and load on first use.
      </p>
    </div>
  );
}
