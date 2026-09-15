import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  ExternalLink,
  FileAudio,
  FileText,
  Headphones,
  HelpCircle,
  LayoutList,
  LoaderCircle,
  MessageCircle,
  Mic,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import type {
  Meeting,
  Insight,
  Settings,
  ProviderCatalog,
  ProviderModels,
  Health,
  OAuthState,
  ChatMessage,
  Segment,
} from "../shared/types";
import { api } from "./api";
import { openExternalLink } from "./external-links";
import { createCallRecorder, type RecorderState } from "./recorder";

function time(value: number) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
const isBusy = (meeting?: Meeting | null) =>
  meeting?.status === "transcribing" || meeting?.status === "summarizing";
function Spinner() {
  return <LoaderCircle size={16} className="spin" />;
}
function IconButton({
  children,
  label,
  onClick,
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),select,textarea,a[href]",
        ) || [],
      );
    focusable()[0]?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const nodes = focusable();
        if (!nodes.length) return;
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem("cadence-meeting"),
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"transcript" | "summary" | "actions">(
    "transcript",
  );
  const [showSettings, setShowSettings] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [showChat, setShowChat] = useState(() => window.innerWidth > 820);
  const [showDelete, setShowDelete] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [working, setWorking] = useState("");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (showRecord) audio.current?.pause();
  }, [showRecord]);
  const upload = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function updateMeeting(value: Meeting) {
    if (selectedRef.current === value.id) setMeeting(value);
    setMeetings((old) =>
      [value, ...old.filter((item) => item.id !== value.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
  }
  async function refreshSetup() {
    const results = await Promise.allSettled([
      api.settings(),
      api.providers(),
      api.health(),
    ]);
    if (results[0].status === "fulfilled") setSettings(results[0].value);
    if (results[1].status === "fulfilled") setCatalog(results[1].value);
    if (results[2].status === "fulfilled") setHealth(results[2].value);
  }
  useEffect(() => {
    let canceled = false;
    api
      .meetings()
      .then((items) => {
        if (canceled) return;
        setMeetings(items);
        setSelected((old) =>
          items.some((m) => m.id === old) ? old : items[0]?.id || null,
        );
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    void refreshSetup();
    return () => {
      canceled = true;
    };
  }, []);
  useEffect(() => {
    setPosition(0);
    setPlaying(false);
    setDuration(0);
    setTranscriptSearch("");
    setEditingTitle(false);
    if (!selected) {
      setMeeting(null);
      localStorage.removeItem("cadence-meeting");
      return;
    }
    localStorage.setItem("cadence-meeting", selected);
    let canceled = false;
    setMeeting(null);
    api
      .meeting(selected)
      .then((item) => {
        if (!canceled) setMeeting(item);
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      });
    return () => {
      canceled = true;
    };
  }, [selected]);
  useEffect(() => {
    if (!meeting || !isBusy(meeting)) return;
    const id = meeting.id;
    const timer = setInterval(() => {
      api
        .meeting(id)
        .then(updateMeeting)
        .catch((e) => setError(e.message));
    }, 1600);
    return () => clearInterval(timer);
  }, [meeting?.id, meeting?.status]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const activeSegment = meeting?.segments.find(
    (segment) => position >= segment.start && position < segment.end,
  );
  useEffect(() => {
    if (follow && playing && activeSegment && tab === "transcript")
      document
        .getElementById(`segment-${activeSegment.id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSegment?.id, follow, playing, tab]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 50 && audio.current) {
        setPosition(audio.current.currentTime);
        last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, meeting?.id]);

  async function run(label: string, task: () => Promise<void>) {
    setWorking(label);
    setError("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking("");
    }
  }
  async function importAudio(file?: File) {
    if (!file) return;
    await run("Importing audio", async () => {
      const item = await api.upload(
        file,
        file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[-_]/g, " ")
          .slice(0, 160),
      );
      setMeetings((old) => [item, ...old]);
      setSelected(item.id);
      setTab("transcript");
      setNotice("Audio imported. Preparing your transcript…");
      const queued = await api.transcribe(item.id);
      updateMeeting(queued);
    });
  }
  async function storeRecording(file: File, title: string) {
    await run("Saving recording", async () => {
      const item = await api.upload(file, title);
      setMeetings((old) => [item, ...old]);
      setSelected(item.id);
      setShowRecord(false);
      setTab("transcript");
      const queued = await api.transcribe(item.id);
      updateMeeting(queued);
    });
  }
  const seek = useCallback(
    (seconds: number) => {
      if (!audio.current) return;
      audio.current.currentTime = Math.max(
        0,
        Math.min(seconds, duration || meeting?.duration || seconds),
      );
      setPosition(audio.current.currentTime);
    },
    [duration, meeting?.duration],
  );
  async function togglePlayback() {
    if (!audio.current) return;
    try {
      if (audio.current.paused) await audio.current.play();
      else audio.current.pause();
    } catch (e) {
      setError(`Cannot play this audio: ${(e as Error).message}`);
    }
  }
  function exportNotes() {
    if (!meeting) return;
    const body = `# ${meeting.title}\n\n${new Date(meeting.createdAt).toLocaleString()}\n\n${meeting.insight ? `## Summary\n\n${meeting.insight.summary}\n\n## Decisions\n\n${meeting.insight.decisions.map((d) => `- ${d}`).join("\n")}\n\n## Action items\n\n${meeting.insight.actions.map((a) => `- [${a.done ? "x" : " "}] ${a.text}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (${a.due})` : ""}`).join("\n")}\n\n` : ""}## Transcript\n\n${meeting.segments.map((s) => `[${time(s.start)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n\n")}`;
    const url = URL.createObjectURL(
      new Blob([body], { type: "text/markdown" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${meeting.title.replace(/[^a-z0-9 -]/gi, "") || "meeting"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const filtered = meetings.filter((item) =>
    item.title.toLowerCase().includes(search.toLowerCase()),
  );
  const actions = meeting?.insight?.actions || [];
  const visibleSegments =
    meeting?.segments.filter((segment) =>
      segment.text.toLowerCase().includes(transcriptSearch.toLowerCase()),
    ) || [];

  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void importAudio(e.dataTransfer.files[0]);
      }}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setSelected(null);
          }}
          aria-label="NoteThis home"
        >
          <span className="brand-icon">
            <img src="/notethis-mark.svg" alt="" width={32} height={32} />
          </span>
          <span>NoteThis</span>
        </a>
        <div className="workspace-label">
          YOUR WORKSPACE{" "}
          <span className="local-badge">
            <span /> Local
          </span>
        </div>
        <button
          className="sidebar-nav active"
          onClick={() => {
            setSearch("");
            setSelected(null);
          }}
        >
          <LayoutList size={18} /> All meetings{" "}
          <span className="count">{meetings.length}</span>
        </button>
        <div className="sidebar-search">
          <Search size={15} />
          <input
            aria-label="Search meetings"
            placeholder="Find a meeting…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="list-label">RECENT MEETINGS</div>
        <nav className="meeting-list" aria-label="Meetings">
          {loading ? (
            <div className="sidebar-empty">
              <Spinner /> Loading your workspace
            </div>
          ) : filtered.length ? (
            filtered.map((item) => (
              <button
                key={item.id}
                className={`meeting-card ${selected === item.id ? "selected" : ""}`}
                onClick={() => setSelected(item.id)}
              >
                <span className="meeting-card-icon">
                  {isBusy(item) ? <Spinner /> : <FileAudio size={17} />}
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {date(item.createdAt)}
                    <span>·</span>
                    {item.duration
                      ? time(item.duration)
                      : item.status === "transcribing"
                        ? "Transcribing"
                        : "Audio recording"}
                  </small>
                </span>
                {selected === item.id && <span className="selected-dot" />}
              </button>
            ))
          ) : (
            <div className="sidebar-empty">
              {search
                ? "No meetings match your search."
                : "Your conversations will live here."}
            </div>
          )}
        </nav>
        <button
          className="sidebar-add"
          onClick={() => upload.current?.click()}
          disabled={!!working}
        >
          <Plus size={17} /> Import a conversation
        </button>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={19} />
            <div>
              <strong>Your space. Your words.</strong>
              <p>
                Stored on this device.
                <br />
                You choose your AI providers.
              </p>
            </div>
          </div>
          <button
            className="settings-nav"
            onClick={() => setShowSettings(true)}
          >
            <span className="avatar" aria-hidden="true">
              <UserRound size={18} strokeWidth={1.7} />
            </span>
            <span>
              <strong>Personal workspace</strong>
              <small>Settings & AI models</small>
            </span>
            <Settings2 size={17} />
          </button>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>{meeting ? "Meeting details" : "All meetings"}</span>
          </div>
          <div className="topbar-actions">
            <span className="private-pill">
              <ShieldCheck size={13} /> Local storage
            </span>
            <button
              className="button secondary"
              onClick={() => upload.current?.click()}
              disabled={!!working}
            >
              <Upload size={15} />
              <span>Import audio</span>
            </button>
            <button
              className="button primary"
              onClick={() => setShowRecord(true)}
              disabled={!!working}
            >
              <span className="record-dot" />
              <span>Record meeting</span>
            </button>
          </div>
        </header>
        <input
          type="file"
          ref={upload}
          accept="audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.ogg,.flac,.webm,.mp4"
          hidden
          onChange={(e) => {
            void importAudio(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {error && (
          <div className="alert error" role="alert">
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={16} />
            {notice}
          </div>
        )}
        {working && (
          <div className="working-bar" role="status">
            <Spinner />
            {working}…
          </div>
        )}
        {meeting ? (
          <>
            <section className="meeting-heading">
              <div className="eyebrow">
                <span
                  className={`status-dot ${isBusy(meeting) ? "pulsing" : ""}`}
                />
                {isBusy(meeting)
                  ? meeting.status === "transcribing"
                    ? "TRANSCRIBING"
                    : "CREATING NOTES"
                  : meeting.segments.length
                    ? "MEETING CAPTURED"
                    : "AUDIO IMPORTED"}
              </div>
              <div className="title-row">
                {editingTitle ? (
                  <form
                    className="title-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const title = String(
                        new FormData(e.currentTarget).get("title") || "",
                      ).trim();
                      if (title)
                        void run("Renaming meeting", async () => {
                          updateMeeting(await api.rename(meeting.id, title));
                          setEditingTitle(false);
                        });
                    }}
                  >
                    <input
                      name="title"
                      aria-label="Meeting title"
                      defaultValue={meeting.title}
                      maxLength={160}
                      autoFocus
                    />
                    <button className="button secondary" type="submit">
                      Save
                    </button>
                    <IconButton
                      label="Cancel rename"
                      onClick={() => setEditingTitle(false)}
                    >
                      <X size={18} />
                    </IconButton>
                  </form>
                ) : (
                  <h1>
                    <button
                      onClick={() => setEditingTitle(true)}
                      title="Rename meeting"
                    >
                      {meeting.title}
                    </button>
                  </h1>
                )}
                <div className="heading-actions">
                  <button
                    className="button text-button"
                    onClick={exportNotes}
                    disabled={!meeting.segments.length}
                  >
                    <ArrowDownToLine size={16} />
                    <span>Export notes</span>
                  </button>
                  <IconButton
                    label="Delete meeting"
                    disabled={isBusy(meeting) || !!working}
                    onClick={() => setShowDelete(true)}
                  >
                    <Trash2 size={17} />
                  </IconButton>
                </div>
              </div>
              <div className="meeting-meta">
                <span>
                  <Clock3 size={14} />
                  {new Date(meeting.createdAt).toLocaleDateString(undefined, {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <span className="meta-dot">·</span>
                <span>{time(duration || meeting.duration)} duration</span>
                {meeting.sttProvider && (
                  <>
                    <span className="meta-dot">·</span>
                    <span>
                      <Sparkles size={13} />
                      {meeting.sttProvider}
                    </span>
                  </>
                )}
              </div>
            </section>
            <div
              className={`meeting-workspace ${showChat ? "" : "chat-hidden"}`}
            >
              <section className="meeting-content">
                <div className="tabs-row">
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Meeting content"
                  >
                    <button
                      role="tab"
                      aria-selected={tab === "transcript"}
                      className={tab === "transcript" ? "active" : ""}
                      onClick={() => setTab("transcript")}
                    >
                      <FileText size={16} />
                      Transcript
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "summary"}
                      className={tab === "summary" ? "active" : ""}
                      onClick={() => setTab("summary")}
                    >
                      <Sparkles size={16} />
                      Summary
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "actions"}
                      className={tab === "actions" ? "active" : ""}
                      onClick={() => setTab("actions")}
                    >
                      <CheckCheck size={17} />
                      Action items
                      {actions.length > 0 && (
                        <span className="tab-count">{actions.length}</span>
                      )}
                    </button>
                  </div>
                  <IconButton
                    label={
                      showChat
                        ? "Hide meeting assistant"
                        : "Show meeting assistant"
                    }
                    className={showChat ? "selected-icon" : ""}
                    onClick={() => setShowChat(!showChat)}
                  >
                    <MessageCircle size={18} />
                  </IconButton>
                </div>
                {meeting.error && (
                  <div className="meeting-error">
                    <HelpCircle size={18} />
                    <div>
                      <strong>Something needs attention</strong>
                      <p>{meeting.error}</p>
                      <button
                        className="inline-link"
                        onClick={() => setShowSettings(true)}
                      >
                        Check model settings <ArrowRight size={13} />
                      </button>
                    </div>
                  </div>
                )}
                {isBusy(meeting) && (
                  <div className="processing-card" role="status">
                    <span className="processing-icon">
                      <AudioLines size={20} />
                    </span>
                    <div>
                      <strong>
                        {meeting.status === "transcribing"
                          ? "Turning your conversation into words"
                          : "Finding the important details"}
                      </strong>
                      <p>
                        {meeting.progress ||
                          "This may take a few minutes. You can keep listening while we work."}
                      </p>
                    </div>
                    <Spinner />
                  </div>
                )}
                {tab === "transcript" && (
                  <>
                    <div className="transcript-tools">
                      <label className="transcript-search">
                        <Search size={15} />
                        <input
                          aria-label="Search transcript"
                          placeholder="Search transcript"
                          value={transcriptSearch}
                          onChange={(e) => setTranscriptSearch(e.target.value)}
                        />
                        {transcriptSearch && (
                          <button
                            aria-label="Clear transcript search"
                            onClick={() => setTranscriptSearch("")}
                          >
                            <X size={14} />
                          </button>
                        )}
                      </label>
                      <button
                        className={`follow-button ${follow ? "on" : ""}`}
                        onClick={() => setFollow(!follow)}
                        aria-pressed={follow}
                      >
                        <span className="toggle-track">
                          <span />
                        </span>
                        Follow audio
                      </button>
                    </div>
                    <div
                      className="transcript-scroll"
                      role="tabpanel"
                      aria-label="Transcript"
                    >
                      {visibleSegments.length ? (
                        <>
                          {meeting.timing === "estimated" && (
                            <p className="timing-note">
                              Word highlighting uses estimated timing for this
                              provider.
                            </p>
                          )}
                          {visibleSegments.map((segment) => (
                            <TranscriptSegment
                              key={segment.id}
                              segment={segment}
                              active={activeSegment?.id === segment.id}
                              position={
                                activeSegment?.id === segment.id ? position : -1
                              }
                              seek={seek}
                              search={transcriptSearch}
                            />
                          ))}
                          <div className="transcript-end">
                            <span /> End of transcript <span />
                          </div>
                        </>
                      ) : meeting.segments.length ? (
                        <div className="content-empty">
                          <Search size={26} />
                          <h3>No matching passages</h3>
                          <p>Try another word or phrase.</p>
                        </div>
                      ) : !isBusy(meeting) ? (
                        <div className="content-empty">
                          <span className="empty-icon">
                            <FileText size={28} />
                          </span>
                          <h3>Your transcript starts here</h3>
                          <p>
                            Transcribe the audio to read along, find moments,
                            <br />
                            and turn the conversation into clear next steps.
                          </p>
                          <button
                            className="button primary"
                            disabled={!!working}
                            onClick={() =>
                              void run("Starting transcription", async () =>
                                updateMeeting(await api.transcribe(meeting.id)),
                              )
                            }
                          >
                            <Sparkles size={16} />
                            Transcribe audio
                          </button>
                          <button
                            className="inline-link"
                            onClick={() => setShowSettings(true)}
                          >
                            Using{" "}
                            {settings?.stt.model ||
                              "your selected speech model"}{" "}
                            <Settings2 size={13} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
                {tab === "summary" && (
                  <div
                    className="notes-scroll"
                    role="tabpanel"
                    aria-label="Summary"
                  >
                    {meeting.insight ? (
                      <>
                        <div className="notes-heading">
                          <span className="section-eyebrow">
                            THE BIG PICTURE
                          </span>
                          <button
                            className="inline-link"
                            disabled={isBusy(meeting)}
                            onClick={() =>
                              void run("Refreshing notes", async () =>
                                updateMeeting(await api.summarize(meeting.id)),
                              )
                            }
                          >
                            Regenerate <Sparkles size={12} />
                          </button>
                        </div>
                        <h2>A conversation, distilled.</h2>
                        <p className="summary-copy">
                          {meeting.insight.summary}
                        </p>
                        <div className="section-divider" />
                        <div className="section-label">
                          <span className="small-icon">
                            <CheckCheck size={18} />
                          </span>
                          <h3>Key decisions</h3>
                          <span>{meeting.insight.decisions.length}</span>
                        </div>
                        {meeting.insight.decisions.length ? (
                          <ul className="decision-list">
                            {meeting.insight.decisions.map((decision, i) => (
                              <li key={i}>
                                <span>{String(i + 1).padStart(2, "0")}</span>
                                <p>{decision}</p>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">
                            No explicit decisions were identified.
                          </p>
                        )}
                        <MeetingVisuals insight={meeting.insight} />
                        <div className="summary-footer">
                          <Sparkles size={14} />
                          AI-generated notes. Check important details against
                          the transcript.
                        </div>
                      </>
                    ) : (
                      <NotesEmpty
                        hasTranscript={!!meeting.segments.length}
                        busy={isBusy(meeting) || !!working}
                        onGenerate={() =>
                          void run("Creating notes", async () =>
                            updateMeeting(await api.summarize(meeting.id)),
                          )
                        }
                      />
                    )}
                  </div>
                )}
                {tab === "actions" && (
                  <div
                    className="notes-scroll"
                    role="tabpanel"
                    aria-label="Action items"
                  >
                    {meeting.insight ? (
                      <>
                        <span className="section-eyebrow">
                          FROM TALK TO TO-DO
                        </span>
                        <div className="actions-title">
                          <h2>Make the next move.</h2>
                          <span>
                            {actions.filter((item) => item.done).length} of{" "}
                            {actions.length} complete
                          </span>
                        </div>
                        <div className="action-progress">
                          <span
                            style={{
                              width: `${actions.length ? (actions.filter((item) => item.done).length / actions.length) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <div className="action-list">
                          {actions.length ? (
                            actions.map((action) => (
                              <div
                                key={action.id}
                                className={`action-card ${action.done ? "done" : ""}`}
                              >
                                <button
                                  className="action-checkbox"
                                  aria-label={`${action.done ? "Mark incomplete" : "Complete"}: ${action.text}`}
                                  aria-pressed={action.done}
                                  onClick={() =>
                                    void run("Updating action", async () =>
                                      updateMeeting(
                                        await api.action(
                                          meeting.id,
                                          action.id,
                                          !action.done,
                                        ),
                                      ),
                                    )
                                  }
                                  disabled={!!working}
                                >
                                  {action.done && <Check size={14} />}
                                </button>
                                <div>
                                  <p>{action.text}</p>
                                  <div className="action-meta">
                                    {action.owner && (
                                      <span className="owner-chip">
                                        {action.owner}
                                      </span>
                                    )}
                                    {action.due && (
                                      <span>
                                        <Clock3 size={12} />
                                        {action.due}
                                      </span>
                                    )}
                                    {action.segmentId &&
                                      meeting.segments.some(
                                        (s) => s.id === action.segmentId,
                                      ) && (
                                        <button
                                          className="inline-link"
                                          onClick={() => {
                                            const s = meeting.segments.find(
                                              (s) => s.id === action.segmentId,
                                            );
                                            if (s) {
                                              setTab("transcript");
                                              seek(s.start);
                                            }
                                          }}
                                        >
                                          View in transcript{" "}
                                          <ArrowRight size={12} />
                                        </button>
                                      )}
                                  </div>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="content-empty">
                              <CheckCheck size={28} />
                              <h3>No action items identified</h3>
                              <p>
                                This conversation didn’t include explicit next
                                steps.
                              </p>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <NotesEmpty
                        hasTranscript={!!meeting.segments.length}
                        busy={isBusy(meeting) || !!working}
                        onGenerate={() =>
                          void run("Creating notes", async () =>
                            updateMeeting(await api.summarize(meeting.id)),
                          )
                        }
                      />
                    )}
                  </div>
                )}
              </section>
              {showChat && (
                <ChatPanel
                  key={meeting.id}
                  meeting={meeting}
                  onMessage={(message) => {
                    setMeeting((old) =>
                      old?.id === meeting.id
                        ? {
                            ...old,
                            messages: [
                              ...old.messages.filter(
                                (m) => m.id !== message.id,
                              ),
                              message,
                            ],
                          }
                        : old,
                    );
                  }}
                  onRefresh={async () => {
                    updateMeeting(await api.meeting(meeting.id));
                  }}
                  onSeek={(segmentId) => {
                    const s = meeting.segments.find((s) => s.id === segmentId);
                    if (s) {
                      setTab("transcript");
                      seek(s.start);
                      setTimeout(
                        () =>
                          document
                            .getElementById(`segment-${s.id}`)
                            ?.scrollIntoView({
                              block: "center",
                              behavior: "smooth",
                            }),
                        100,
                      );
                    }
                  }}
                  llm={settings?.llm.model}
                  webSearchEnabled={settings?.llm.webSearch === true}
                  onSettings={() => setShowSettings(true)}
                />
              )}
            </div>
            <footer className="audio-player">
              <audio
                key={meeting.id}
                ref={audio}
                src={`/api/meetings/${meeting.id}/audio`}
                preload="metadata"
                onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => {
                  const value = e.currentTarget.duration;
                  if (Number.isFinite(value)) setDuration(value);
                  e.currentTarget.playbackRate = speed;
                }}
                onDurationChange={(e) => {
                  if (Number.isFinite(e.currentTarget.duration))
                    setDuration(e.currentTarget.duration);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onError={() =>
                  setError(
                    "The audio could not be loaded. Check that the original recording is still available.",
                  )
                }
              />
              <div className="audio-file-icon">
                <AudioLines size={23} />
              </div>
              <div className="audio-label">
                <strong>Meeting recording</strong>
                <span>
                  {meeting.segments.length
                    ? "Click any word to jump there"
                    : "Your original audio"}
                </span>
              </div>
              <div className="playback-buttons">
                <IconButton
                  label="Back 10 seconds"
                  onClick={() => seek(position - 10)}
                >
                  <SkipBack size={17} />
                  <span className="skip-label">10</span>
                </IconButton>
                <button
                  className="play-button"
                  aria-label={playing ? "Pause audio" : "Play audio"}
                  onClick={() => void togglePlayback()}
                >
                  {playing ? (
                    <Pause size={20} fill="currentColor" />
                  ) : (
                    <Play size={20} fill="currentColor" />
                  )}
                </button>
                <IconButton
                  label="Forward 10 seconds"
                  onClick={() => seek(position + 10)}
                >
                  <SkipForward size={17} />
                  <span className="skip-label">10</span>
                </IconButton>
              </div>
              <span className="player-time">{time(position)}</span>
              <div className="timeline">
                <input
                  aria-label="Audio position"
                  type="range"
                  min="0"
                  max={duration || meeting.duration || 0}
                  step="0.05"
                  value={position}
                  style={
                    {
                      "--progress": `${(position / (duration || meeting.duration || 1)) * 100}%`,
                    } as React.CSSProperties
                  }
                  onChange={(e) => seek(Number(e.target.value))}
                />
              </div>
              <span className="player-time total-time">
                {time(duration || meeting.duration)}
              </span>
              <label className="speed-control">
                <span className="sr-only">Playback speed</span>
                <select
                  value={speed}
                  onChange={(e) => {
                    setSpeed(Number(e.target.value));
                    if (audio.current)
                      audio.current.playbackRate = Number(e.target.value);
                  }}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </label>
              <Volume2 size={18} className="volume-icon" />
            </footer>
          </>
        ) : loading || selected ? (
          <div className="loading-main">
            <Spinner />
            <span>Opening your workspace…</span>
          </div>
        ) : (
          <div className="welcome">
            <div className="welcome-heading">
              <span className="eyebrow">
                A LITTLE MORE PRESENT. A LOT LESS NOTE-TAKING.
              </span>
              <h1>
                Be in the conversation.
                <br />
                <em>We’ll keep the details.</em>
              </h1>
              <p>
                Record, revisit, and make sense of your meetings.
                <br />
                Every word, next step, and good idea—in one quiet place.
              </p>
            </div>
            <div className="welcome-cards">
              <button
                className="welcome-record"
                onClick={() => setShowRecord(true)}
              >
                <span className="welcome-card-icon">
                  <Mic size={27} />
                </span>
                <div className="wave-illustration" aria-hidden="true">
                  {[
                    14, 25, 40, 20, 55, 32, 66, 42, 27, 51, 68, 34, 48, 23, 43,
                    57, 31, 20, 40, 24, 13,
                  ].map((height, i) => (
                    <i key={i} style={{ height }} />
                  ))}
                </div>
                <h2>Capture the conversation</h2>
                <p>
                  Record your microphone and system audio.
                  <br />
                  Stay focused on the people in the room.
                </p>
                <span className="card-link">
                  Start a recording <ArrowRight size={17} />
                </span>
              </button>
              <button
                className="welcome-upload"
                onClick={() => upload.current?.click()}
                disabled={!!working}
              >
                <span className="welcome-card-icon">
                  <Upload size={26} />
                </span>
                <div className="file-illustration" aria-hidden="true">
                  <FileAudio size={42} strokeWidth={1.2} />
                  <span>DROP YOUR AUDIO HERE</span>
                </div>
                <h2>Bring a meeting with you</h2>
                <p>
                  Upload an existing recording and turn it
                  <br />
                  into a transcript, notes, and next steps.
                </p>
                <span className="card-link">
                  Choose an audio file <ArrowRight size={17} />
                </span>
              </button>
            </div>
            <div className="welcome-bottom">
              <span>
                <ShieldCheck size={16} />
                Local storage. Open-source models by default.
              </span>
              <button
                className="inline-link"
                onClick={() =>
                  void run("Opening sample meeting", async () => {
                    const item = await api.demo();
                    setMeetings((old) => [
                      item,
                      ...old.filter((m) => m.id !== item.id),
                    ]);
                    setSelected(item.id);
                  })
                }
              >
                Explore a sample meeting <ArrowRight size={14} />
              </button>
            </div>
            <button
              className="setup-banner"
              onClick={() => setShowSettings(true)}
            >
              <span className="small-icon">
                <Settings2 size={18} />
              </span>
              <div>
                <strong>Make yourself at home</strong>
                <span>
                  Choose your AI models and check local services before your
                  first recording.
                </span>
              </div>
              <ArrowRight size={18} />
            </button>
          </div>
        )}
      </main>
      {dragging && (
        <div className="drop-overlay">
          <Upload size={46} />
          <h2>Drop your audio to get started</h2>
          <p>MP3, WAV, M4A, FLAC, OGG, or WebM</p>
        </div>
      )}
      {showSettings && settings && catalog && (
        <SettingsModal
          settings={settings}
          catalog={catalog}
          health={health}
          onClose={() => setShowSettings(false)}
          onSave={(value) => {
            setSettings(value);
            setNotice("Your model preferences have been saved.");
          }}
          onRefresh={refreshSetup}
        />
      )}
      {showSettings && (!settings || !catalog) && (
        <Modal
          title="Settings unavailable"
          onClose={() => setShowSettings(false)}
        >
          <div className="modal-body">
            <p>
              Couldn’t connect to the local app server. Check that it is running
              and try again.
            </p>
            <button
              className="button primary"
              onClick={() => void refreshSetup()}
            >
              Try again
            </button>
          </div>
        </Modal>
      )}
      {showRecord && (
        <RecordingModal
          onClose={() => setShowRecord(false)}
          onSave={storeRecording}
          saving={working === "Saving recording"}
        />
      )}
      {showDelete && meeting && (
        <Modal
          title="Delete this meeting?"
          subtitle="This removes the recording, transcript, notes, and chat from this device."
          onClose={() => setShowDelete(false)}
        >
          <div className="modal-body">
            <p className="delete-title">{meeting.title}</p>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setShowDelete(false)}
              >
                Keep meeting
              </button>
              <button
                className="button danger"
                disabled={!!working || isBusy(meeting)}
                onClick={() =>
                  void run("Deleting meeting", async () => {
                    await api.remove(meeting.id);
                    setMeetings((old) =>
                      old.filter((m) => m.id !== meeting.id),
                    );
                    setSelected(null);
                    setShowDelete(false);
                  })
                }
              >
                <Trash2 size={16} />
                Delete meeting
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const TranscriptSegment = memo(function TranscriptSegment({
  segment,
  active,
  position,
  seek,
  search,
}: {
  segment: Segment;
  active: boolean;
  position: number;
  seek: (seconds: number) => void;
  search: string;
}) {
  return (
    <article
      id={`segment-${segment.id}`}
      className={`transcript-segment ${active ? "current" : ""}`}
    >
      <button
        className="segment-time"
        onClick={() => seek(segment.start)}
        aria-label={`Jump to ${time(segment.start)}`}
      >
        {time(segment.start)}
        {active && <span className="current-marker" />}
      </button>
      <div className="segment-body">
        {segment.speaker && (
          <div className="speaker-name">
            <span className="speaker-avatar">
              {segment.speaker.slice(0, 1)}
            </span>
            {segment.speaker}
          </div>
        )}
        <p>
          {segment.words.length ? (
            segment.words.map((word, i) => (
              <span key={i}>
                <button
                  className={`word ${active && position >= word.start && position < word.end ? "active-word" : ""} ${search && word.text.toLowerCase().includes(search.toLowerCase()) ? "search-word" : ""}`}
                  onClick={() => seek(word.start)}
                  aria-label={`Jump to ${word.text} at ${time(word.start)}`}
                >
                  {word.text}
                </button>{" "}
              </span>
            ))
          ) : (
            <button
              className="segment-text"
              onClick={() => seek(segment.start)}
            >
              {segment.text}
            </button>
          )}
        </p>
      </div>
    </article>
  );
});

function NotesEmpty({
  hasTranscript,
  busy,
  onGenerate,
}: {
  hasTranscript: boolean;
  busy: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="content-empty notes-empty">
      <span className="empty-icon">
        <Sparkles size={28} />
      </span>
      <h3>The useful part, all together.</h3>
      <p>
        {hasTranscript
          ? "Create a concise summary, capture decisions,\nand find the next steps in your conversation."
          : "Transcribe your recording first to create\na summary, decisions, and action items."}
      </p>
      <button
        className="button primary"
        onClick={onGenerate}
        disabled={!hasTranscript || busy}
      >
        <Sparkles size={16} />
        Generate meeting notes
      </button>
      <span className="fine-print">Uses your selected language model.</span>
    </div>
  );
}

function isExternalSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function visualSource(
  visual: NonNullable<Insight["visuals"]>[number],
): string | null {
  if (!["image/png", "image/jpeg", "image/webp"].includes(visual.mimeType))
    return null;
  if (
    visual.imageUrl &&
    /^\/api\/meetings\/[a-zA-Z0-9-]+\/visuals\/[a-zA-Z0-9-]+$/.test(
      visual.imageUrl,
    )
  )
    return visual.imageUrl;
  const dataUrl = visual.dataUrl;
  if (!dataUrl || dataUrl.length > 30_000_000) return null;
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    );
  if (!match || match[1] !== visual.mimeType || match[2].length % 4 !== 0)
    return null;
  try {
    const bytes = atob(match[2].slice(0, 64));
    const png = bytes.startsWith("\x89PNG\r\n\x1a\n");
    const jpeg = bytes.startsWith("\xff\xd8\xff");
    const webp = bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    return (visual.mimeType === "image/png" && png) ||
      (visual.mimeType === "image/jpeg" && jpeg) ||
      (visual.mimeType === "image/webp" && webp)
      ? dataUrl
      : null;
  } catch {
    return null;
  }
}
export function MeetingVisuals({ insight }: { insight: Insight }) {
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => setFailed([]), [insight.visuals]);
  const entries = (insight.visuals || []).map((visual) => ({
    visual,
    source: visualSource(visual),
  }));
  const display = entries.filter(
    (entry) => entry.source && !failed.includes(entry.visual.id),
  );
  const rejected = entries.some(
    (entry) => !entry.source || failed.includes(entry.visual.id),
  );
  if (!entries.length && !insight.visualError) return null;
  return (
    <section className="summary-visuals" aria-label="Meeting visuals">
      <div className="section-label">
        <span className="small-icon">
          <Sparkles size={17} />
        </span>
        <h3>Visual notes</h3>
      </div>
      {display.map(({ visual, source }) => (
        <figure className="meeting-visual" key={visual.id}>
          <div className="visual-heading">
            <strong>{visual.title}</strong>
            <span>AI-generated</span>
          </div>
          <img
            src={source!}
            alt={visual.description || visual.title}
            loading="lazy"
            onError={() =>
              setFailed((old) => [...new Set([...old, visual.id])])
            }
          />
          <figcaption>{visual.description}</figcaption>
          <a
            className="inline-link"
            href={source!}
            download={`${visual.title.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 80) || "meeting-visual"}.${visual.mimeType === "image/jpeg" ? "jpg" : visual.mimeType === "image/webp" ? "webp" : "png"}`}
          >
            <ArrowDownToLine size={13} />
            Download image
          </a>
        </figure>
      ))}
      {insight.visualError && (
        <p className="visual-notice" role="status">
          {insight.visualError} Your summary and action items are still
          available.
        </p>
      )}
      {rejected && (
        <p className="visual-notice" role="status">
          A generated visual couldn’t be displayed. Your meeting notes are still
          available.
        </p>
      )}
    </section>
  );
}

export function ChatPanel({
  meeting,
  onRefresh,
  onMessage,
  onSeek,
  llm,
  webSearchEnabled = false,
  onSettings,
}: {
  meeting: Meeting;
  onRefresh: () => Promise<void>;
  onMessage: (message: ChatMessage) => void;
  onSeek: (id: string) => void;
  llm?: string;
  webSearchEnabled?: boolean;
  onSettings: () => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [meeting.messages.length, busy]);
  async function send(value: string) {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError("");
    setInput("");
    onMessage({
      id: `pending-${Date.now()}`,
      role: "user",
      text: value.trim(),
      createdAt: new Date().toISOString(),
    });
    try {
      await api.chat(meeting.id, value.trim());
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
      await onRefresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="chat-panel" aria-label="Meeting assistant">
      <header className="chat-header">
        <span className="assistant-icon">
          <Sparkles size={18} />
        </span>
        <div>
          <h2>Ask this meeting</h2>
          <p>A little clarity, on demand.</p>
        </div>
      </header>
      <div className="chat-scroll">
        {meeting.messages.length ? (
          meeting.messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              <div className="chat-message-label">
                {message.role === "user" ? (
                  "You"
                ) : (
                  <>
                    <Sparkles size={12} />
                    NoteThis
                  </>
                )}
              </div>
              <p>{message.text}</p>
              {message.citations?.length ? (
                <div
                  className="chat-citations"
                  aria-label="Transcript citations"
                >
                  {message.citations.map((id) => {
                    const s = meeting.segments.find(
                      (segment) => segment.id === id,
                    );
                    return s ? (
                      <button key={id} onClick={() => onSeek(id)}>
                        <Play size={10} />
                        {time(s.start)}
                      </button>
                    ) : null;
                  })}
                </div>
              ) : null}
              {message.webSearchUsed && (
                <div className="web-search-used">
                  <Search size={11} />
                  Web search used
                </div>
              )}
              {!!message.webSources?.filter((source) =>
                isExternalSourceUrl(source.url),
              ).length && (
                <div className="chat-web-sources" aria-label="Web sources">
                  <strong>Web sources</strong>
                  {message.webSources
                    .filter((source) => isExternalSourceUrl(source.url))
                    .map((source, index) => (
                      <a
                        key={`${source.url}-${index}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                          event.preventDefault();
                          void openExternalLink(source.url).catch((error) =>
                            setError(
                              `Couldn’t open this web source: ${(error as Error).message}`,
                            ),
                          );
                        }}
                      >
                        <ExternalLink size={12} />
                        <span>
                          {source.title || new URL(source.url).hostname}
                        </span>
                      </a>
                    ))}
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="chat-intro">
            <span className="chat-orbit">
              <Sparkles size={25} />
            </span>
            <h3>
              There’s more in
              <br />
              the conversation.
            </h3>
            <p>Find a detail, untangle an idea, or ask what happens next.</p>
            <div className="suggestion-list">
              {[
                "What are the key takeaways?",
                "What did we agree to do next?",
                "What questions are still open?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  disabled={!meeting.segments.length || busy}
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                  <ArrowUpRight />
                </button>
              ))}
            </div>
            <p className="chat-context">
              <FileText size={13} />
              {webSearchEnabled
                ? "Uses this transcript; web search may add external sources."
                : "Answers grounded in this transcript."}
            </p>
          </div>
        )}
        {busy && (
          <div className="thinking" role="status">
            <span />
            <span />
            <span />
            {webSearchEnabled
              ? "Preparing your answer"
              : "Reading the conversation"}
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            {error}
            <button className="inline-link" onClick={onSettings}>
              Check model settings
            </button>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="chat-compose">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            aria-label="Ask a question about this meeting"
            placeholder={
              meeting.segments.length
                ? "Ask anything about this meeting…"
                : "Transcribe your meeting to ask a question…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            disabled={!meeting.segments.length || busy}
          />
          <div className="compose-bottom">
            <span>
              <FileText size={12} />
              {webSearchEnabled
                ? "Meeting + web when supported"
                : "This meeting only"}
            </span>
            <button
              type="submit"
              aria-label="Send question"
              disabled={!input.trim() || !meeting.segments.length || busy}
            >
              {busy ? <Spinner /> : <ArrowRight size={17} />}
            </button>
          </div>
        </form>
        <button className="model-label" onClick={onSettings}>
          <span className="status-dot" />
          {llm || "Choose a language model"}
          <ChevronDown size={11} />
        </button>
      </div>
    </aside>
  );
}
function ArrowUpRight() {
  return <ArrowRight size={14} className="suggestion-arrow" />;
}

export function RecordingModal({
  onClose,
  onSave,
  saving,
}: {
  onClose: () => void;
  onSave: (file: File, title: string) => Promise<void>;
  saving: boolean;
}) {
  const [title, setTitle] = useState(
    `Meeting · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
  );
  const [mic, setMic] = useState(true);
  const [system, setSystem] = useState(true);
  const [state, setState] = useState<RecorderState>("idle");
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [systemQuiet, setSystemQuiet] = useState(false);
  const lastSystemSound = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<
    "microphone" | "system" | null
  >(null);
  const [captured, setCaptured] = useState<{
    blob: Blob;
    mimeType: string;
    durationMs: number;
  } | null>(null);
  const [discard, setDiscard] = useState(false);
  const recorder = useRef<ReturnType<typeof createCallRecorder> | null>(null);
  useEffect(() => {
    recorder.current = createCallRecorder({
      onLevels: (value) => {
        setLevels(value);
        if (value.system > 0.008) {
          lastSystemSound.current = performance.now();
          setSystemQuiet(false);
        }
      },
      onStateChange: setState,
      onPermissionRequest: setPermissionRequest,
      onError: (e) => setError(e.message),
    });
    return () => {
      recorder.current?.dispose();
    };
  }, []);
  useEffect(() => {
    setSystemQuiet(false);
    if (state !== "recording") return;
    lastSystemSound.current = performance.now();
    const timer = setInterval(() => {
      setElapsed((old) => old + 1);
      if (system && performance.now() - lastSystemSound.current >= 10_000)
        setSystemQuiet(true);
    }, 1000);
    return () => clearInterval(timer);
  }, [state, system]);
  useEffect(() => {
    if (state === "idle" && !captured && !starting) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [state, captured, starting]);
  function close() {
    if (saving) return;
    if (state !== "idle" || captured || starting) setDiscard(true);
    else onClose();
  }
  async function start() {
    setStarting(true);
    setError("");
    try {
      await recorder.current?.start({ includeMic: mic, includeSystem: system });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPermissionRequest(null);
      setStarting(false);
    }
  }
  async function stop() {
    setStarting(true);
    setError("");
    try {
      const result = await recorder.current!.stop();
      setCaptured(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }
  return (
    <Modal
      title={
        captured
          ? "Your recording is ready"
          : state === "idle"
            ? "Make room for the conversation."
            : "You’re recording."
      }
      subtitle={
        captured
          ? "Save your audio and create a transcript."
          : "Capture the words. Stay in the moment."
      }
      onClose={close}
    >
      <div className="modal-body recording-body">
        {discard ? (
          <div className="discard-panel">
            <h3>Discard this recording?</h3>
            <p>This audio hasn’t been saved. Closing will discard it.</p>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setDiscard(false)}
              >
                Keep recording
              </button>
              <button className="button danger" onClick={onClose}>
                Discard & close
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="field">
              Meeting name
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Give this conversation a name"
                maxLength={160}
              />
            </label>
            {state === "idle" && !captured ? (
              <>
                <div className="source-options">
                  <button
                    className={mic ? "selected" : ""}
                    aria-pressed={mic}
                    disabled={starting}
                    onClick={() => setMic(!mic)}
                  >
                    <Mic size={23} />
                    <strong>Microphone</strong>
                    <span>Your voice & the room</span>
                    <span className="source-check">
                      {mic && <Check size={12} />}
                    </span>
                  </button>
                  <button
                    className={system ? "selected" : ""}
                    aria-pressed={system}
                    disabled={starting}
                    onClick={() => setSystem(!system)}
                  >
                    <Monitor size={23} />
                    <strong>System audio</strong>
                    <span>The people on your call</span>
                    <span className="source-check">
                      {system && <Check size={12} />}
                    </span>
                  </button>
                </div>
                {(mic || system) && !starting && (
                  <div className="info-note" style={{ marginTop: 14 }}>
                    <ShieldCheck size={16} />
                    <span>
                      Starting will request{" "}
                      {mic && system
                        ? "microphone and system audio / screen-sharing access"
                        : mic
                          ? "microphone access"
                          : "system audio / screen-sharing access"}{" "}
                      if needed. Approve the selected permissions in the macOS
                      or browser prompt.
                    </span>
                  </div>
                )}
                <div className="record-info">
                  <Headphones size={18} />
                  <p>
                    Use headphones when capturing both sources to reduce echo.
                    System audio works best in the desktop app; browsers require
                    sharing a tab or screen with audio enabled.
                  </p>
                </div>
                <p className="consent-note">
                  Make sure everyone knows you’re recording.
                </p>
              </>
            ) : (
              <div className="live-recording">
                <span
                  className={`recording-status ${state === "paused" ? "is-paused" : ""}`}
                >
                  {captured ? (
                    <Check size={13} />
                  ) : (
                    <span className="record-dot" />
                  )}
                  {captured
                    ? "CAPTURE COMPLETE"
                    : state === "paused"
                      ? "PAUSED"
                      : "RECORDING LIVE"}
                </span>
                <div className="recording-timer">
                  {time(captured ? captured.durationMs / 1000 : elapsed)}
                </div>
                <div className="live-meters">
                  {[
                    {
                      name: "Microphone",
                      value: levels.mic,
                      enabled: mic,
                      Icon: Mic,
                    },
                    {
                      name: "System audio",
                      value: levels.system,
                      enabled: system,
                      Icon: Monitor,
                    },
                  ]
                    .filter((source) => source.enabled)
                    .map(({ name, value, Icon }) => (
                      <div key={name} className="meter-source">
                        <Icon size={15} />
                        <span>{name}</span>
                        <div className="meter-bars">
                          {Array.from({ length: 20 }, (_, i) => (
                            <i
                              key={i}
                              className={
                                state === "recording" && value * 20 > i
                                  ? "lit"
                                  : ""
                              }
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
                {!captured && (
                  <p>
                    Your audio stays in memory until you save.
                    <br />
                    Keep this window open while recording.
                  </p>
                )}
              </div>
            )}
            {systemQuiet && system && state === "recording" && !captured && (
              <div className="info-note system-silence" role="status">
                <Monitor size={16} />
                <span>
                  No system sound detected recently. If your call is playing,
                  check audio sharing and macOS permissions. Recording continues
                  normally.
                </span>
              </div>
            )}
            {permissionRequest && (
              <div
                className="info-note"
                role="status"
                aria-live="polite"
                style={{ marginTop: 16 }}
              >
                <Spinner />
                <span>
                  <strong>
                    {permissionRequest === "microphone"
                      ? "Requesting microphone access…"
                      : "Requesting system audio / screen sharing access…"}
                  </strong>
                  <br />
                  {permissionRequest === "microphone"
                    ? "Approve the microphone permission prompt from macOS or your browser."
                    : "Approve the system audio or screen-sharing prompt. In a browser, enable audio in the sharing picker."}
                </span>
              </div>
            )}
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="record-buttons">
              {captured ? (
                <button
                  className="button primary"
                  disabled={saving || !title.trim()}
                  onClick={() => {
                    const extension = captured.mimeType.includes("mp4")
                      ? "m4a"
                      : captured.mimeType.includes("ogg")
                        ? "ogg"
                        : "webm";
                    void onSave(
                      new File(
                        [captured.blob],
                        `recording-${Date.now()}.${extension}`,
                        { type: captured.mimeType },
                      ),
                      title.trim(),
                    );
                  }}
                >
                  {saving ? <Spinner /> : <Check size={17} />}Save & transcribe
                </button>
              ) : state === "idle" ? (
                <button
                  className="button primary"
                  disabled={starting || (!mic && !system) || !title.trim()}
                  onClick={() => void start()}
                >
                  {starting ? <Spinner /> : <span className="record-dot" />}
                  Start recording
                </button>
              ) : (
                <>
                  <button
                    className="button secondary"
                    disabled={starting}
                    onClick={() => {
                      try {
                        if (state === "paused") recorder.current?.resume();
                        else recorder.current?.pause();
                      } catch (error) {
                        setError((error as Error).message);
                      }
                    }}
                  >
                    {state === "paused" ? (
                      <Play size={16} />
                    ) : (
                      <Pause size={16} />
                    )}
                    {state === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button
                    className="button primary"
                    disabled={starting}
                    onClick={() => void stop()}
                  >
                    {starting ? (
                      <Spinner />
                    ) : (
                      <Square size={13} fill="currentColor" />
                    )}
                    Finish recording
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

type ModelDiscovery = {
  info: ProviderModels | null;
  loading: boolean;
  refresh: () => void;
};
function useProviderModels(
  provider: string,
  kind: "llm" | "stt",
  credentials: string,
  baseUrl = "",
  ollamaUrl = "",
  autoEnabled = true,
): ModelDiscovery {
  const key = JSON.stringify([
    provider,
    kind,
    credentials,
    baseUrl,
    ollamaUrl,
    autoEnabled,
  ]);
  const serial = useRef(0);
  const lastCredentials = useRef(credentials);
  const [state, setState] = useState<{
    key: string;
    info: ProviderModels | null;
    loading: boolean;
  }>({ key, info: null, loading: true });
  const load = useCallback(
    async (force: boolean) => {
      const requestId = ++serial.current;
      setState({ key, info: null, loading: true });
      try {
        const info = await api.providerModels(provider, {
          kind,
          ...(provider === "custom" ? { baseUrl } : {}),
          ...(provider === "ollama" ? { ollamaUrl } : {}),
          force,
        });
        if (requestId === serial.current) {
          if (info.provider !== provider || info.kind !== kind)
            throw new Error(
              "The model response did not match the selected provider. Refresh and try again.",
            );
          setState({ key, info, loading: false });
        }
      } catch (error) {
        if (requestId === serial.current)
          setState({
            key,
            info: {
              provider,
              kind,
              models: [],
              source: "unavailable",
              message: (error as Error).message,
            },
            loading: false,
          });
      }
    },
    [key, provider, kind, baseUrl, ollamaUrl],
  );
  useEffect(() => {
    if (!autoEnabled) {
      ++serial.current;
      setState({
        key,
        info: {
          provider,
          kind,
          source: "unavailable",
          models: [],
          message:
            "Server URL changed. Refresh models to check this address, or save preferences first. Saved credentials are not sent to an edited address automatically.",
        },
        loading: false,
      });
      return;
    }
    const force = lastCredentials.current !== credentials;
    lastCredentials.current = credentials;
    // Debounce edits to local/custom server URLs; stale responses cannot cross selections.
    const timer = setTimeout(() => void load(force), 180);
    return () => {
      clearTimeout(timer);
      ++serial.current;
    };
  }, [load, credentials, autoEnabled, key, provider, kind]);
  const current = state.key === key ? state : { info: null, loading: true };
  return {
    info: current.info,
    loading: current.loading,
    refresh: () => void load(true),
  };
}
function ModelDiscoveryStatus({
  discovery,
  selected,
  kind,
  webSearchEnabled = false,
  onWebSearchChange,
  summaryDiagramsEnabled = false,
  onSummaryDiagramsChange,
  providerName = "the selected provider",
}: {
  discovery: ModelDiscovery;
  selected: string;
  kind: "llm" | "stt";
  webSearchEnabled?: boolean;
  onWebSearchChange?: (enabled: boolean) => void;
  summaryDiagramsEnabled?: boolean;
  onSummaryDiagramsChange?: (enabled: boolean) => void;
  providerName?: string;
}) {
  const info = discovery.info;
  const label = kind === "llm" ? "language" : "speech";
  const missing =
    info &&
    (info.source === "account" || info.source === "local") &&
    !info.models.includes(selected.trim());
  const checked = info?.checkedAt ? new Date(info.checkedAt) : null;
  const capabilities =
    (info?.source === "account" || info?.source === "local") &&
    info.models.includes(selected.trim())
      ? info.capabilities?.[selected.trim()]
      : undefined;
  const outputFormats = capabilities?.outputModalities?.length
    ? `${capabilities.outputModalities.join(", ")} (provider-reported)`
    : "Unknown (not reported)";
  const webSearch =
    capabilities?.webSearch === "supported"
      ? "Provider-supported"
      : capabilities?.webSearch === "unsupported"
        ? "Not supported (provider-reported)"
        : "Unknown (not reported)";
  return (
    <div
      className={`model-discovery ${info?.source === "unavailable" ? "model-discovery-error" : ""}`}
      aria-label={`${label} model availability`}
    >
      <div className="model-discovery-heading">
        <strong>
          {discovery.loading
            ? "Checking available models…"
            : info?.source === "account"
              ? "Account model list"
              : info?.source === "local"
                ? "Local model list"
                : info?.source === "bundled"
                  ? "Bundled suggestions · access not verified"
                  : "Model list unavailable"}
        </strong>
        <button
          type="button"
          className="inline-link"
          disabled={discovery.loading}
          onClick={discovery.refresh}
          aria-label={`Refresh ${label} models`}
        >
          {discovery.loading ? <Spinner /> : <Sparkles size={12} />}Refresh
          models
        </button>
      </div>
      {info?.message && (
        <p role={info.source === "unavailable" ? "alert" : undefined}>
          {info.message}
        </p>
      )}
      {info?.source === "bundled" && (
        <p>
          These are bundled suggestions, not a list of models verified for your
          account. You can enter a model ID supported by your provider.
        </p>
      )}
      {info?.source === "unavailable" && (
        <p>
          Refresh after checking your connection or credentials. No older model
          list is being shown; you can still enter a model ID manually.
        </p>
      )}
      {missing && (
        <p className="model-selection-warning" role="status">
          {info.source === "account"
            ? "The selected model is not in the current account list. Choose a listed model before saving."
            : "The selected model is not in this local list. Install it on your server or choose an available model."}
        </p>
      )}
      <p aria-label={`${label} model output formats`}>
        <strong>Output formats: </strong>
        {outputFormats}
      </p>
      {kind === "llm" && (
        <>
          <p aria-label="Selected model web search">
            <strong>Web search: </strong>
            {webSearch}
            {capabilities?.webSearchNote && (
              <> — {capabilities.webSearchNote}</>
            )}
          </p>
          <div className="web-search-setting">
            <div>
              <strong>Allow web search</strong>
              <p>
                Send your question, recent conversation, and relevant transcript
                excerpts to {providerName} for {selected}. These may be used to
                form web queries.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Allow web search"
              aria-checked={webSearchEnabled}
              disabled={
                !onWebSearchChange ||
                (!webSearchEnabled && capabilities?.appWebSearch !== true)
              }
              className={`follow-button ${webSearchEnabled ? "on" : ""}`}
              onClick={() => onWebSearchChange?.(!webSearchEnabled)}
            >
              <span className="toggle-track">
                <span />
              </span>
              <span>{webSearchEnabled ? "On" : "Off"}</span>
            </button>
          </div>
          <p aria-label="NoteThis web access">
            <strong>Web access in NoteThis: </strong>
            {capabilities?.appWebSearch === true
              ? webSearchEnabled
                ? "enabled for this model."
                : "available; currently off."
              : webSearchEnabled
                ? "saved as on; unavailable for this model."
                : "not available for this model."}
          </p>
          {webSearchEnabled && capabilities?.appWebSearch !== true && (
            <p className="model-selection-warning" role="status">
              Web search is saved as on, but this model does not currently have
              verified web-search support in NoteThis. Turn it off or choose a
              supported model before using web search.
            </p>
          )}
          <div className="web-search-setting">
            <div>
              <strong>Generate summary diagrams with {providerName}</strong>
              <p>
                Send transcript-derived diagram descriptions and supporting
                excerpts to {providerName} for {selected}. Images are generated
                when helpful.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Generate summary diagrams"
              aria-checked={summaryDiagramsEnabled}
              disabled={
                !onSummaryDiagramsChange ||
                (!summaryDiagramsEnabled &&
                  capabilities?.appImageOutput !== true)
              }
              className={`follow-button ${summaryDiagramsEnabled ? "on" : ""}`}
              onClick={() => onSummaryDiagramsChange?.(!summaryDiagramsEnabled)}
            >
              <span className="toggle-track">
                <span />
              </span>
              <span>{summaryDiagramsEnabled ? "On" : "Off"}</span>
            </button>
          </div>
          <p aria-label="NoteThis summary visuals">
            <strong>Summary visuals in NoteThis: </strong>
            {capabilities?.appImageOutput === true
              ? summaryDiagramsEnabled
                ? "enabled for this model; generated diagrams appear with your meeting notes."
                : "available; currently off."
              : summaryDiagramsEnabled
                ? "saved as on; unavailable for this model."
                : "not available for this model."}{" "}
            Chat answers remain text.
          </p>
          {summaryDiagramsEnabled && capabilities?.appImageOutput !== true && (
            <p className="model-selection-warning" role="status">
              Summary diagrams are saved as on, but this model does not
              currently have verified image support in NoteThis. Turn them off
              or choose a supported model.
            </p>
          )}
        </>
      )}
      {checked && !Number.isNaN(checked.getTime()) && (
        <small>
          Checked{" "}
          {checked.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}{" "}
          · {info!.models.length} models
        </small>
      )}
    </div>
  );
}

export function SettingsModal({
  settings,
  catalog,
  health,
  onClose,
  onSave,
  onRefresh,
}: {
  settings: Settings;
  catalog: ProviderCatalog;
  health: Health | null;
  onClose: () => void;
  onSave: (settings: Settings) => void;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [section, setSection] = useState<"models" | "setup">("models");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [oauth, setOauth] = useState<OAuthState | null>(null);
  const [oauthInput, setOauthInput] = useState("");
  const [authBusy, setAuthBusy] = useState("");
  const [authError, setAuthError] = useState("");
  const [linkStatus, setLinkStatus] = useState("");
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [savedServerUrls, setSavedServerUrls] = useState({
    baseUrl: settings.llm.baseUrl.trim(),
    ollamaUrl: settings.local.ollamaUrl.trim(),
  });
  const authOperation = useRef(false);
  const sessionId = useRef<string | null>(null);
  const authPanel = useRef<HTMLDivElement>(null);
  const stt = catalog.stt.find(
    (provider) => provider.id === draft.stt.provider,
  );
  const llm = catalog.llm.find(
    (provider) => provider.id === draft.llm.provider,
  );
  const credentialSignal = JSON.stringify([
    draft.configuredKeys,
    draft.oauthConnections,
    credentialRevision,
  ]);
  const speechModels = useProviderModels(
    draft.stt.provider,
    "stt",
    credentialSignal,
  );
  const languageModels = useProviderModels(
    draft.llm.provider,
    "llm",
    credentialSignal,
    draft.llm.provider === "custom" ? draft.llm.baseUrl.trim() : "",
    draft.llm.provider === "ollama" ? draft.local.ollamaUrl.trim() : "",
    draft.llm.provider === "custom"
      ? draft.llm.baseUrl.trim() === savedServerUrls.baseUrl
      : draft.llm.provider === "ollama"
        ? draft.local.ollamaUrl.trim() === savedServerUrls.ollamaUrl
        : true,
  );
  const pendingLogin =
    !!oauth && (oauth.status === "pending" || oauth.status === "prompt");

  function acceptOAuth(value: OAuthState) {
    sessionId.current =
      value.status === "complete" || value.status === "error" ? null : value.id;
    setOauth(value);
    if (value.status === "complete") {
      setCredentialRevision((old) => old + 1);
      setAuthError("");
      setDraft((old) => ({
        ...old,
        oauthConnections: [
          ...new Set([...old.oauthConnections, value.provider]),
        ],
      }));
      void onRefresh().catch((e) => setAuthError((e as Error).message));
    }
  }
  useEffect(() => {
    if (!oauth || !pendingLogin) return;
    let canceled = false;
    let polling = false;
    const id = oauth.id;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const value = await api.oauthSession(id);
        if (!canceled && sessionId.current === id) acceptOAuth(value);
      } catch (e) {
        if (!canceled && sessionId.current === id)
          setAuthError((e as Error).message);
      } finally {
        polling = false;
      }
    }, 1600);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [oauth?.id, pendingLogin]);
  useEffect(() => {
    if (oauth?.url || authError)
      authPanel.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
  }, [oauth?.url, authError]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (
      busy ||
      authOperation.current ||
      speechModels.loading ||
      languageModels.loading
    )
      return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const stt = {
        ...draft.stt,
        model: draft.stt.model.trim(),
        language: draft.stt.language.trim(),
      };
      const llm = {
        ...draft.llm,
        model: draft.llm.model.trim(),
        baseUrl: draft.llm.baseUrl.trim(),
        webSearch: draft.llm.webSearch === true,
        summaryDiagrams: draft.llm.summaryDiagrams === true,
      };
      const local = {
        ...draft.local,
        pythonPath: draft.local.pythonPath.trim(),
        ollamaUrl: draft.local.ollamaUrl.trim(),
      };
      if (!stt.model || !llm.model)
        throw new Error(
          "Choose both a speech model and a language model before saving.",
        );
      for (const [discovery, model, label] of [
        [speechModels, stt.model, "speech"],
        [languageModels, llm.model, "language"],
      ] as const) {
        if (
          discovery.info?.source === "account" &&
          !discovery.info.models.includes(model)
        )
          throw new Error(
            `Choose a ${label} model from the current account list before saving.`,
          );
      }
      if (!local.pythonPath)
        throw new Error("Enter the local Python executable path.");
      const validateServer = (value: string, label: string) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error(`Enter a valid ${label}.`);
        }
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
          url.hostname,
        );
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
        )
          throw new Error(
            `${label} must use HTTPS, or HTTP on localhost, without embedded credentials, query parameters, or fragments.`,
          );
      };
      validateServer(local.ollamaUrl, "Ollama server URL");
      if (llm.provider === "custom")
        validateServer(llm.baseUrl, "API base URL");
      const result = await api.saveSettings({
        stt,
        llm,
        local,
        apiKeys: Object.fromEntries(
          Object.entries(keys)
            .filter(([, key]) => key.trim())
            .map(([provider, key]) => [provider, key.trim()]),
        ),
      });
      setDraft(result);
      setSavedServerUrls({
        baseUrl: result.llm.baseUrl.trim(),
        ollamaUrl: result.local.ollamaUrl.trim(),
      });
      if (Object.values(keys).some((key) => key.trim()))
        setCredentialRevision((old) => old + 1);
      setKeys({});
      onSave(result);
      await onRefresh();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function authAction(label: string, action: () => Promise<void>) {
    if (authOperation.current || busy) return;
    authOperation.current = true;
    setAuthBusy(label);
    setAuthError("");
    try {
      await action();
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      authOperation.current = false;
      setAuthBusy("");
    }
  }
  async function connect(provider: string) {
    await authAction("Starting sign-in", async () => {
      setLinkStatus("");
      setOauthInput("");
      acceptOAuth(await api.oauth(provider));
    });
  }
  async function saveKey(provider: string) {
    const key = keys[provider]?.trim();
    if (!key || busy || authOperation.current) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api.saveSettings({ apiKeys: { [provider]: key } });
      setDraft((old) => ({ ...old, configuredKeys: updated.configuredKeys }));
      setKeys((old) => {
        const next = { ...old };
        delete next[provider];
        return next;
      });
      setCredentialRevision((old) => old + 1);
      onSave(updated);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeKey(provider: string) {
    if (busy || authOperation.current) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api.saveSettings({ apiKeys: { [provider]: "" } });
      setCredentialRevision((old) => old + 1);
      setDraft((old) => ({ ...old, configuredKeys: updated.configuredKeys }));
      setKeys((old) => {
        const next = { ...old };
        delete next[provider];
        return next;
      });
      onSave(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(provider: string) {
    await authAction("Disconnecting", async () => {
      await api.disconnectOAuth(provider);
      setCredentialRevision((old) => old + 1);
      setDraft((old) => ({
        ...old,
        oauthConnections: old.oauthConnections.filter((id) => id !== provider),
      }));
      if (oauth?.provider === provider) {
        sessionId.current = null;
        setOauth(null);
      }
      await onRefresh();
    });
  }
  async function cancelLogin() {
    if (!oauth) return;
    await authAction("Canceling sign-in", async () => {
      await api.cancelOAuth(oauth.id);
      sessionId.current = null;
      setOauth(null);
      setOauthInput("");
      setLinkStatus("");
    });
  }
  async function closeSettings() {
    if (busy || authOperation.current) return;
    if (pendingLogin && oauth) {
      await authAction("Canceling sign-in", async () => {
        await api.cancelOAuth(oauth.id);
        sessionId.current = null;
        onClose();
      });
    } else onClose();
  }
  async function launchSignIn() {
    if (!oauth?.url) return;
    await authAction("Opening browser", async () => {
      setLinkStatus("");
      await openExternalLink(oauth.url!);
      setLinkStatus(
        "Opened your browser. Complete sign-in there, then return here.",
      );
    });
  }
  async function copySignInLink() {
    if (!oauth?.url) return;
    try {
      await navigator.clipboard.writeText(oauth.url);
      setLinkStatus("Sign-in link copied.");
    } catch {
      setAuthError(
        "Couldn’t copy automatically. Select the sign-in URL below and copy it manually.",
      );
    }
  }
  async function submitSignInInput() {
    if (!oauth) return;
    await authAction("Completing sign-in", async () => {
      acceptOAuth(await api.oauthInput(oauth.id, oauthInput.trim()));
      setOauthInput("");
    });
  }
  const authControls = (oauth || authError || authBusy) && (
    <div
      className="oauth-state"
      ref={authPanel}
      aria-label="Browser sign-in status"
    >
      {pendingLogin && (
        <button
          type="button"
          className="inline-link cancel-login"
          disabled={!!authBusy || busy}
          onClick={() => void cancelLogin()}
        >
          Cancel sign-in <X size={12} />
        </button>
      )}
      <strong>
        {oauth?.status === "complete"
          ? "You’re connected."
          : oauth?.status === "error"
            ? "Sign-in needs attention"
            : "Continue in your browser"}
      </strong>
      {oauth?.instructions && <p>{oauth.instructions}</p>}
      {oauth?.url && pendingLogin && (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={!!authBusy || busy}
            onClick={() => void launchSignIn()}
          >
            {authBusy === "Opening browser" ? (
              <Spinner />
            ) : (
              <ExternalLink size={13} />
            )}
            Open secure sign-in
          </button>
          <label className="field" style={{ marginTop: 14 }}>
            Sign-in URL
            <input
              aria-label="Sign-in URL"
              readOnly
              value={oauth.url}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            type="button"
            className="inline-link"
            onClick={() => void copySignInLink()}
          >
            Copy sign-in link
          </button>
        </>
      )}
      {linkStatus && <p role="status">{linkStatus}</p>}
      {authBusy && <p role="status">{authBusy}…</p>}
      {oauth?.status === "prompt" && (
        <div className="oauth-input">
          <label className="field">
            {oauth.prompt || "Paste the authorization result"}
            <input
              value={oauthInput}
              onChange={(event) => setOauthInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitSignInInput();
                }
              }}
              disabled={!!authBusy}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={!!authBusy}
            onClick={() => void submitSignInInput()}
          >
            Continue
          </button>
        </div>
      )}
      {oauth?.error && (
        <p className="field-error" role="alert">
          {oauth.error}
        </p>
      )}
      {authError && (
        <p className="field-error" role="alert">
          {authError}
        </p>
      )}
    </div>
  );
  const keyProviders = [
    ...new Map(
      [stt, llm]
        .filter(
          (p) => p && (p.auth === "api-key" || p.auth === "api-key-or-oauth"),
        )
        .map((p) => [p!.id, p!]),
    ).values(),
  ];
  return (
    <Modal
      title="A workspace that sounds like you."
      subtitle="Choose where your audio and words are processed."
      onClose={() => void closeSettings()}
      wide
    >
      <div className="settings-tabs">
        <button
          className={section === "models" ? "active" : ""}
          onClick={() => setSection("models")}
        >
          <Sparkles size={16} />
          AI models
        </button>
        <button
          className={section === "setup" ? "active" : ""}
          onClick={() => setSection("setup")}
        >
          <Settings2 size={16} />
          Local setup
        </button>
      </div>
      <form onSubmit={save} onChange={() => setSaved(false)}>
        <fieldset
          className="settings-body"
          disabled={busy}
          style={{ border: 0, margin: 0, minWidth: 0 }}
        >
          {section === "models" ? (
            <>
              <div className="settings-section">
                <div className="settings-section-title">
                  <span className="small-icon">
                    <AudioLines size={19} />
                  </span>
                  <div>
                    <h3>Speech to text</h3>
                    <p>
                      The model that turns your recording into a transcript.
                    </p>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="field">
                    Provider
                    <select
                      aria-label="Speech provider"
                      value={draft.stt.provider}
                      onChange={(e) => {
                        const provider = catalog.stt.find(
                          (p) => p.id === e.target.value,
                        )!;
                        setDraft({
                          ...draft,
                          stt: {
                            ...draft.stt,
                            provider: provider.id,
                            model: provider.models[0] || "",
                          },
                        });
                        setSaved(false);
                      }}
                    >
                      {catalog.stt.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Model
                    {speechModels.info?.source === "account" ? (
                      <select
                        aria-label="Speech model"
                        value={draft.stt.model}
                        required
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            stt: { ...draft.stt, model: event.target.value },
                          });
                          setSaved(false);
                        }}
                      >
                        <option value="" disabled>
                          Choose a model from your account
                        </option>
                        {draft.stt.model &&
                          !speechModels.info.models.includes(
                            draft.stt.model,
                          ) && (
                            <option value={draft.stt.model} disabled>
                              {draft.stt.model} (not in current list)
                            </option>
                          )}
                        {speechModels.info.models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        list="stt-models"
                        aria-label="Speech model"
                        required
                        maxLength={200}
                        value={draft.stt.model}
                        onChange={(e) => {
                          setDraft({
                            ...draft,
                            stt: { ...draft.stt, model: e.target.value },
                          });
                          setSaved(false);
                        }}
                      />
                    )}
                    <datalist id="stt-models">
                      {speechModels.info?.models.map((model) => (
                        <option value={model} key={model} />
                      ))}
                    </datalist>
                  </label>
                </div>
                <p className="provider-description">{stt?.description}</p>
                <ModelDiscoveryStatus
                  discovery={speechModels}
                  selected={draft.stt.model}
                  kind="stt"
                />
                <label className="field language-field">
                  Language
                  <input
                    maxLength={20}
                    placeholder="Auto-detect (or en, es, fr…)"
                    value={draft.stt.language}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        stt: { ...draft.stt, language: e.target.value },
                      })
                    }
                  />
                </label>
                {stt?.supportsWords === false && (
                  <div className="info-note">
                    This provider may return segment-level timestamps. Word
                    highlighting will be estimated when precise word timings
                    aren’t available.
                  </div>
                )}
              </div>
              <div className="settings-section">
                <div className="settings-section-title">
                  <span className="small-icon">
                    <Sparkles size={18} />
                  </span>
                  <div>
                    <h3>Meeting intelligence</h3>
                    <p>
                      For summaries, action items, and your meeting assistant.
                    </p>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="field">
                    Provider
                    <select
                      aria-label="Language model provider"
                      disabled={!!authBusy || pendingLogin}
                      value={draft.llm.provider}
                      onChange={(e) => {
                        const provider = catalog.llm.find(
                          (p) => p.id === e.target.value,
                        )!;
                        setDraft({
                          ...draft,
                          llm: {
                            ...draft.llm,
                            provider: provider.id,
                            model: provider.models[0] || "",
                            webSearch: false,
                            webSearchConsentProvider: "",
                            summaryDiagrams: false,
                            summaryDiagramsConsentProvider: "",
                          },
                        });
                        setSaved(false);
                      }}
                    >
                      {catalog.llm.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Model
                    {languageModels.info?.source === "account" ? (
                      <select
                        aria-label="Language model"
                        value={draft.llm.model}
                        required
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            llm: { ...draft.llm, model: event.target.value },
                          });
                          setSaved(false);
                        }}
                      >
                        <option value="" disabled>
                          Choose a model from your account
                        </option>
                        {draft.llm.model &&
                          !languageModels.info.models.includes(
                            draft.llm.model,
                          ) && (
                            <option value={draft.llm.model} disabled>
                              {draft.llm.model} (not in current list)
                            </option>
                          )}
                        {languageModels.info.models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        list="llm-models"
                        aria-label="Language model"
                        required
                        maxLength={200}
                        value={draft.llm.model}
                        onChange={(e) => {
                          setDraft({
                            ...draft,
                            llm: { ...draft.llm, model: e.target.value },
                          });
                          setSaved(false);
                        }}
                      />
                    )}
                    <datalist id="llm-models">
                      {languageModels.info?.models.map((model) => (
                        <option value={model} key={model} />
                      ))}
                    </datalist>
                  </label>
                </div>
                <p className="provider-description">{llm?.description}</p>
                <ModelDiscoveryStatus
                  discovery={languageModels}
                  selected={draft.llm.model}
                  kind="llm"
                  webSearchEnabled={draft.llm.webSearch === true}
                  providerName={llm?.name || draft.llm.provider}
                  onWebSearchChange={(enabled) => {
                    setDraft((old) => ({
                      ...old,
                      llm: {
                        ...old.llm,
                        webSearch: enabled,
                        webSearchConsentProvider: enabled
                          ? old.llm.provider
                          : "",
                      },
                    }));
                    setSaved(false);
                  }}
                  summaryDiagramsEnabled={draft.llm.summaryDiagrams === true}
                  onSummaryDiagramsChange={(enabled) => {
                    setDraft((old) => ({
                      ...old,
                      llm: {
                        ...old.llm,
                        summaryDiagrams: enabled,
                        summaryDiagramsConsentProvider: enabled
                          ? old.llm.provider
                          : "",
                      },
                    }));
                    setSaved(false);
                  }}
                />
                {(llm?.id === "openai-compatible" || llm?.id === "custom") && (
                  <label className="field">
                    API base URL
                    <input
                      type="url"
                      required
                      value={draft.llm.baseUrl}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          llm: { ...draft.llm, baseUrl: e.target.value },
                        })
                      }
                      placeholder="http://localhost:1234/v1"
                    />
                  </label>
                )}
                {llm &&
                  (llm.auth === "oauth" || llm.auth === "api-key-or-oauth") && (
                    <div className="oauth-connect">
                      <div>
                        <strong>
                          {draft.oauthConnections.includes(llm.id)
                            ? "Browser account connected"
                            : "Use your existing account"}
                        </strong>
                        <p>
                          Sign in through this provider’s supported browser
                          flow.
                        </p>
                      </div>
                      <div className="oauth-buttons">
                        {draft.oauthConnections.includes(llm.id) && (
                          <button
                            type="button"
                            className="inline-link"
                            disabled={!!authBusy || pendingLogin}
                            onClick={() => void disconnect(llm.id)}
                          >
                            Disconnect
                          </button>
                        )}
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!!authBusy || pendingLogin}
                          onClick={() => void connect(llm.id)}
                        >
                          <ExternalLink size={14} />
                          {draft.oauthConnections.includes(llm.id)
                            ? "Reconnect"
                            : "Sign in"}
                        </button>
                      </div>
                    </div>
                  )}
                {authControls}
              </div>
              {keyProviders.length > 0 && (
                <div className="settings-section">
                  <div className="settings-section-title">
                    <ShieldCheck size={20} />
                    <div>
                      <h3>Provider API keys</h3>
                      <p>
                        Keys are saved on your device and never returned to the
                        browser.
                      </p>
                    </div>
                  </div>
                  {keyProviders.map((provider) => (
                    <label className="field" key={provider.id}>
                      {provider.name}
                      {draft.configuredKeys.includes(provider.id) && (
                        <span className="configured">
                          <Check size={12} />
                          Key configured
                          <button
                            type="button"
                            className="remove-key"
                            aria-label={`Remove saved ${provider.name} API key`}
                            title="Remove saved key"
                            onClick={() => void removeKey(provider.id)}
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      )}
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          draft.configuredKeys.includes(provider.id)
                            ? "Enter a new key to replace the saved key"
                            : "Paste your API key"
                        }
                        value={keys[provider.id] || ""}
                        onChange={(e) =>
                          setKeys({ ...keys, [provider.id]: e.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="inline-link"
                        aria-label={`Save ${provider.name} API key`}
                        disabled={
                          busy || !!authBusy || !keys[provider.id]?.trim()
                        }
                        onClick={() => void saveKey(provider.id)}
                      >
                        Save key
                      </button>
                    </label>
                  ))}
                </div>
              )}
              <div className="info-note">
                <ShieldCheck size={16} />
                <span>
                  Local providers keep processing on your device. Choosing a
                  cloud provider sends audio or transcript text to that
                  provider. Only the selected providers receive your meeting
                  content.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="settings-section">
                <div className="settings-section-title">
                  <span className="small-icon">
                    <Monitor size={19} />
                  </span>
                  <div>
                    <h3>Your local engine</h3>
                    <p>
                      Run speech recognition and language models on your own
                      computer.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="inline-link"
                    onClick={() => void onRefresh()}
                  >
                    Refresh
                  </button>
                </div>
                <div className="health-grid">
                  {[
                    {
                      name: "FFmpeg",
                      ready: health?.ffmpeg,
                      detail: "Audio conversion",
                    },
                    {
                      name: "Python",
                      ready: health?.python,
                      detail: "Local model runtime",
                    },
                    {
                      name: "Faster Whisper",
                      ready: health?.whisper,
                      detail: "Speech recognition",
                    },
                    {
                      name: "Ollama",
                      ready: health?.ollama,
                      detail: "Local language models",
                    },
                  ].map((item) => (
                    <div className="health-item" key={item.name}>
                      <span
                        className={`health-indicator ${item.ready ? "ready" : ""}`}
                      >
                        {item.ready ? (
                          <Check size={13} />
                        ) : (
                          <Circle size={12} />
                        )}
                      </span>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.detail}</small>
                      </div>
                      <span>{item.ready ? "Ready" : "Not detected"}</span>
                    </div>
                  ))}
                </div>
                <div className="setup-instructions">
                  <h4>First-time setup</h4>
                  <p>
                    From the project folder, run the local speech setup script.
                    Install Ollama, then download a language model.
                  </p>
                  <code>npm run setup:local</code>
                  <code>ollama pull qwen3:0.6b</code>
                  <p>
                    The first speech transcription downloads the selected
                    Whisper model. Models need disk space and can take a few
                    minutes to load.
                  </p>
                  <a
                    href="https://ollama.com/download"
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternalLink(
                        "https://ollama.com/download",
                      ).catch((error) => setError((error as Error).message));
                    }}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get Ollama <ExternalLink size={12} />
                  </a>
                </div>
              </div>
              <div className="settings-section">
                <label className="field">
                  Python executable
                  <input
                    value={draft.local.pythonPath}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        local: { ...draft.local, pythonPath: e.target.value },
                      })
                    }
                    placeholder=".venv/bin/python"
                  />
                </label>
                <label className="field">
                  Ollama server URL
                  <input
                    type="url"
                    value={draft.local.ollamaUrl}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        local: { ...draft.local, ollamaUrl: e.target.value },
                      })
                    }
                  />
                </label>
                {health?.ollamaModels?.length ? (
                  <p className="provider-description">
                    Installed models: {health.ollamaModels.join(", ")}
                  </p>
                ) : null}
                <div className="data-location">
                  <ShieldCheck size={15} />
                  <span>
                    Meeting data location
                    <code>{health?.dataDir || "Not available"}</code>
                  </span>
                </div>
              </div>
            </>
          )}
          {section === "setup" && authControls}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <footer className="settings-footer">
          <span>
            {saved ? (
              <>
                <Check size={14} />
                Preferences saved
              </>
            ) : (
              <>
                <ShieldCheck size={14} />
                Your choices stay on this device
              </>
            )}
          </span>
          <button
            className="button primary"
            type="submit"
            disabled={
              busy ||
              !!authBusy ||
              speechModels.loading ||
              languageModels.loading
            }
          >
            {busy ? <Spinner /> : <Check size={15} />}Save preferences
          </button>
        </footer>
      </form>
    </Modal>
  );
}
