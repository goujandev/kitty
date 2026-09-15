import {
  agentName,
  cancel,
  chooseModel,
  chooseProject,
  currentHarness,
  currentModel,
  loadModels,
  toggleFavourite,
  respondApproval,
  send,
  useChat,
} from "../stores/chatStore";
import { useAppearance } from "../stores/appearanceStore";
import { useHarnessState } from "../stores/harnessStore";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Composer } from "./Composer";
import { effortLabel, ModelTools } from "./ModelPicker";
import { Chevron } from "./Popover";
import { Transcript } from "./Transcript";
import { Usage } from "./Usage";
import { WindowControls } from "./WindowControls";

/** The conversation itself. Both rails live beside it, not inside it. */
export function ChatView(): React.ReactElement {
  const chat = useChat();
  const { background } = useAppearance();
  const harness = currentHarness();
  const { effort } = currentModel();
  // Nothing said yet, whether that is a fresh conversation or none at all.
  const blank = chat.blocks.length === 0;
  /** A conversation is open or chosen, so the box is usable. */
  const live = chat.activeId !== null || chat.draft !== null;
  // Said once, in the box you would try to type into. A separate line above
  // saying the same thing is the app talking to itself.
  // The only two reasons the box is not usable any more. Picking a model is
  // no longer one of them: a new conversation arrives with one already
  // chosen.
  const cannotType = chat.project
    ? "No agent is ready — see Settings › Agents"
    : "Start a chat on the left";
  const title =
    chat.sessions.find((s) => s.id === chat.activeId)?.title ??
    (chat.draft ? "New conversation" : null);

  // "Opus (1M context) Medium" -- the model and how hard it thought, which is
  // the pair that actually explains a reply.
  const attribution = effort ? `${agentName()} ${effortLabel(effort)}` : agentName();

  return (
    <main className={`chat ${blank ? "chat--blank" : ""}`}>
      {/* Full width and flush to the top, because the close button has to
          reach the corner of the screen. Everything below it is inset. */}
      <header className="chat__head" data-tauri-drag-region>
        <span
          className={`chat__dot ${chat.busy ? "chat__dot--busy" : ""}`}
          aria-hidden="true"
        />
        <h1 className="chat__title">{title ?? "kitty"}</h1>
        <WindowControls />
      </header>

      <div className="canvas">
        {/* The picture stays for the whole conversation, but steps back once
            there is something to read: a photograph behind a wall of text is a
            photograph nobody sees and text nobody can read. Mounted in both
            states rather than swapped, so it dims across instead of
            appearing. */}
        {background && (
          <div
            className={`wallpaper${blank ? "" : " wallpaper--behind"}`}
            aria-hidden="true"
          >
            <div
              className="wallpaper__image"
              style={{ backgroundImage: `url("${background}")` }}
            />
            <div className="wallpaper__screen" />
            <div className="wallpaper__fade" />
            <div className="wallpaper__hush" />
          </div>
        )}

        {chat.error && (
          <p className="banner banner--error" role="alert">
            {chat.error}
          </p>
        )}

        {blank ? null : (
        // Keyed per conversation. Row heights are remembered by block
        // sequence, and every session numbers its blocks from zero, so
        // without this a new conversation inherits the old one's measurements.
          <Transcript
            key={chat.activeId ?? "draft"}
            blocks={chat.blocks}
            busy={chat.busy}
            harness={harness}
            agentName={attribution}
          />
        )}

        {chat.approval && (
          <ApprovalPrompt
            approval={chat.approval}
            onRespond={(allow) => void respondApproval(allow)}
          />
        )}

        {/* Pinned to the bottom once there is a transcript above it; centred
            in the empty window, where there is nothing to sit under. */}
        <div className="dock">
          <ContextRow />
          <Composer
            busy={chat.busy}
            disabled={!live}
            placeholder={cannotType}
            tools={<Tools />}
            onSend={(text) => void send(text)}
            onCancel={() => void cancel()}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * What is above the box: where the agent is working, and what the running turn
 * is costing.
 */
function ContextRow(): React.ReactElement | null {
  const chat = useChat();
  if (!chat.project) return null;
  const { root } = chat.project;

  return (
    <div className="contextrow">
      {/* Nothing where the folder would be, for a chat that has none. A chip
          reading "no folder" is the app answering a question nobody asked. */}
      {root !== null && (
        <button
          type="button"
          className="chip chip--path"
          title="Working folder. Click to open a different one."
          onClick={() => void chooseProject()}
        >
          <span className="chip__label">{root}</span>
          <Chevron />
        </button>
      )}
      <StatusLine />
    </div>
  );
}

/** The chips along the bottom of the box. */
function Tools(): React.ReactElement {
  const chat = useChat();
  const { scan } = useHarnessState();
  const harness = currentHarness();
  const { model, effort } = currentModel();
  // Only the ones that can actually run. A model you cannot start is not a
  // choice, it is a disappointment with a logo next to it.
  const ready = (scan?.harnesses ?? []).filter((h) => h.ready);

  return (
    <ModelTools
      harness={harness}
      harnesses={ready}
      catalogs={chat.catalogs}
      model={model}
      runningModel={chat.runningModel}
      effort={effort}
      favourites={chat.favourites}
      locked={chat.activeId !== null}
      disabled={chat.busy}
      onOpen={() => {
        // Both vendors, because the menu shows both. Cached after the first
        // time, so opening it again costs nothing.
        for (const entry of ready) {
          if (!chat.catalogs[entry.id]) void loadModels(entry.id);
        }
      }}
      onRefresh={(id) => void loadModels(id, true)}
      onChoose={(vendor, next, level) => void chooseModel(vendor, next, level)}
      onStar={(vendor, id) => void toggleFavourite(vendor, id)}
    />
  );
}

/**
 * What the running turn is doing, and why it stopped.
 *
 * Token counts used to sit here too. They were the app talking about itself:
 * nobody decides anything differently on learning a turn read 19,200 cached
 * tokens, and the number that does matter -- how much of the quota is gone --
 * is in the composer.
 */
function StatusLine(): React.ReactElement | null {
  const { busy, status, notice, limits } = useChat();
  const harness = currentHarness();

  // A quota belongs to the vendor, so only the one speaking is shown.
  const mine = harness ? limits[harness] ?? [] : [];

  const said = status ?? (busy ? "Working…" : notice ?? "");
  if (!said && mine.length === 0) return null;

  return (
    <div className="statusline">
      <span className="statusline__state">
        {busy && <span className="spinner" aria-hidden="true" />}
        {said}
      </span>
      <Usage harness={harness} limits={mine} />
    </div>
  );
}
