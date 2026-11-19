import { useEffect, useState } from "react";
import { api } from "./api";
import { missingOllamaModelMessage, sameOllamaModel } from "../shared/ollama";

/** A pre-recording advisory. Unmount before requesting capture permissions so a
 * delayed provider response cannot appear as an active recording failure. */
export function RecordingModelCheck({
  onSettings,
}: {
  onSettings?: () => void;
}) {
  const [message, setMessage] = useState("Checking the notes model…");
  const [checking, setChecking] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false;
    setChecking(true);
    setMessage("Checking the notes model…");
    void (async () => {
      const settings = await api.settings();
      if (canceled) return;
      if (settings.llm.provider !== "ollama") return "";
      const result = await api.providerModels("ollama", {
        kind: "llm",
        ollamaUrl: settings.local.ollamaUrl,
        force: true,
      });
      if (result.source !== "local")
        return "The Ollama notes model could not be verified. Check the server and selected model in Settings → AI models.";
      return result.models.some((model) =>
        sameOllamaModel(model, settings.llm.model),
      )
        ? ""
        : missingOllamaModelMessage(
            settings.llm.model,
            settings.local.ollamaUrl,
          );
    })()
      .then((value) => {
        if (!canceled) setMessage(value || "");
      })
      .catch(() => {
        if (!canceled)
          setMessage(
            "The notes model could not be checked. Review Settings → AI models before generating notes.",
          );
      })
      .finally(() => {
        if (!canceled) setChecking(false);
      });
    return () => {
      canceled = true;
    };
  }, [attempt]);
  if (!message) return null;
  return (
    <div className="recording-model-check" role="status">
      <p>{message}</p>
      {!checking && (
        <>
          <p>
            You can still record. This affects AI notes after saving, not audio
            capture.
          </p>
          <div>
            {onSettings && (
              <button
                type="button"
                className="inline-link"
                onClick={onSettings}
              >
                Open model settings
              </button>
            )}
            <button
              type="button"
              className="inline-link"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Check again
            </button>
          </div>
        </>
      )}
    </div>
  );
}
