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
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Composer } from "./Composer";
import { effortLabel, ModelTools } from "./ModelPicker";
import { Transcript } from "./Transcript";
import { Usage } from "./Usage";
import { WindowControls } from "./WindowControls";

/** The conversation itself. Both rails live beside it, not inside it. */
export function ChatView(): React.ReactElement {
  const chat = useChat();
  const harness = currentHarness();
  const { effort } = currentModel();
  const title =
    chat.sessions.find((s) => s.id === chat.activeId)?.title ??
    (chat.draft ? "New conversation" : null);

  // "Opus (1M context) Medium" -- the model and how hard it thought, which is
  // the pair that actually explains a reply.
  const attribution = effort ? `${agentName()} ${effortLabel(effort)}` : agentName();

  return (
    <main className="chat">
      {/* Also the window's drag handle, since there is no title bar above it. */}
      <header className="chat__head" data-tauri-drag-region>
        <span
          className={`chat__dot ${chat.busy ? "chat__dot--busy" : ""}`}
          aria-hidden="true"
        />
        <h1 className="chat__title">{title ?? "kitty"}</h1>
        <WindowControls />
      </header>

      {chat.error && (
        <p className="banner banner--error" role="alert">
          {chat.error}
        </p>
      )}

      {chat.activeId === null && chat.draft === null ? (
        <Empty hasProject={chat.project !== null} />
      ) : (
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

      <ContextRow />

      <Composer
        busy={chat.busy}
        disabled={chat.activeId === null && chat.draft === null}
        tools={<Tools />}
        onSend={(text) => void send(text)}
        onCancel={() => void cancel()}
      />
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

  return (
    <div className="contextrow">
      <button
        type="button"
        className="chip chip--path"
        title="Working folder. Click to open a different one."
        onClick={() => void chooseProject()}
      >
        <span className="chip__label">{chat.project.root}</span>
        <span className="chip__chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      <StatusLine />
    </div>
  );
}

/** The chips along the bottom of the box. */
function Tools(): React.ReactElement {
  const chat = useChat();
  const harness = currentHarness();
  const { model, effort } = currentModel();

  return (
    <ModelTools
      harness={harness}
      catalog={harness ? chat.catalogs[harness] : undefined}
      model={model}
      runningModel={chat.runningModel}
      effort={effort}
      favourites={harness ? chat.favourites[harness] ?? [] : []}
      disabled={chat.busy}
      onOpen={() => {
        if (harness && !chat.catalogs[harness]) void loadModels(harness);
      }}
      onRefresh={() => {
        if (harness) void loadModels(harness, true);
      }}
      onChoose={(next, level) => void chooseModel(next, level)}
      onStar={(id) => {
        if (harness) void toggleFavourite(harness, id);
      }}
    />
  );
}

function Empty({ hasProject }: { hasProject: boolean }): React.ReactElement {
  return (
    <div className="transcript transcript--empty">
      <p className="muted">
        {hasProject
          ? "Pick an agent to start a conversation."
          : "Open a folder to work in."}
      </p>
    </div>
  );
}

/**
 * One line of truth about the running turn: what it is doing, what it cost,
 * and why it stopped.
 */
function StatusLine(): React.ReactElement | null {
  const { busy, status, notice, usage, context, limits } = useChat();
  const harness = currentHarness();

  const parts: string[] = [];
  if (context?.used != null && context.window != null) {
    parts.push(`context ${percent(context.used / context.window)}`);
  }
  if (usage) {
    parts.push(`${usage.outputTokens} out`);
    if (usage.cacheReadTokens > 0) {
      parts.push(`${usage.cacheReadTokens.toLocaleString()} cached`);
    }
  }

  const said = status ?? (busy ? "Working…" : notice ?? "");
  if (!said && parts.length === 0 && limits.length === 0) return null;

  return (
    <div className="statusline">
      <span className="statusline__state">
        {busy && <span className="spinner" aria-hidden="true" />}
        {said}
      </span>
      {parts.length > 0 && (
        <span className="statusline__meta">{parts.join(" · ")}</span>
      )}
      <Usage harness={harness} limits={limits} />
    </div>
  );
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
