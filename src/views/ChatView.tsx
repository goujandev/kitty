import {
  agentName,
  archiveChat,
  cancel,
  chooseModel,
  chooseApprovalMode,
  chooseProject,
  currentHarness,
  currentModel,
  loadModels,
  toggleFavourite,
  respondApproval,
  restartAgentContext,
  send,
  useChat,
} from "../stores/chatStore";
import { useAppearance } from "../stores/appearanceStore";
import { useHarnessState } from "../stores/harnessStore";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Composer } from "./Composer";
import { effortLabel, ModelTools } from "./ModelPicker";
import { Popover } from "./Popover";
import { Transcript } from "./Transcript";
import { ThreadDetails } from "./ThreadDetails";
import { Icon } from "./Icon";
import { Wallpaper } from "./Wallpaper";
import { WorkingBar } from "./WorkingBar";
import { ProjectMonogram } from "./ProjectMonogram";
import { useProjects } from "../stores/projectStore";

/** The conversation itself. Both rails live beside it, not inside it. */
export function ChatView({ detailsOpen, onCloseDetails, onSwitchProject }: { detailsOpen: boolean; onCloseDetails: () => void; onSwitchProject: (projectId: string) => void }): React.ReactElement {
  const chat = useChat();
  const { background } = useAppearance();
  const composerKey = chat.activeId ?? `${chat.project?.id ?? "empty"}:draft`;
  const harness = currentHarness();
  // The wallpaper belongs to a ready draft. Saved chats briefly have no
  // blocks while their transcript is loading.
  const blank = (chat.activeId !== null || chat.draft !== null) &&
    !chat.loading && chat.blocks.length === 0 && !chat.busy && !chat.approval && !chat.error;
  /** A conversation is open or chosen, so the box is usable. */
  const live = !chat.loading && (chat.activeId !== null || chat.draft !== null);
  // Said once, in the box you would try to type into. A separate line above
  // saying the same thing is the app talking to itself.
  // The only two reasons the box is not usable any more. Picking a model is
  // no longer one of them: a new conversation arrives with one already
  // chosen.
  const cannotType = chat.project
    ? "No agent is ready — see Settings › Agents"
    : "Open a project to get started";
  const { effort } = currentModel();
  // "Opus (1M context) Medium" -- the model and how hard it thought, which is
  // the pair that actually explains a reply.
  const attribution = effort ? `${agentName()} ${effortLabel(effort)}` : agentName();
  const archived = chat.sessions.find(session => session.id === chat.activeId && Boolean(session.archivedAt)) ?? null;

  return (
    <main className={`chat ${blank ? "chat--blank" : ""}`}>
      <div className="chat__body">
      <div className="canvas">
        {/* Full strength on a new chat; stepped back behind a conversation so
            the transcript stays easy to read. */}
        {background && <Wallpaper url={background} dim={!blank} />}

        {chat.error && (
          <p className="banner banner--error" role="alert">
            {chat.error}
            {chat.activeId && !chat.busy && <button type="button" disabled={chat.loading} title="Keeps saved Kitty history, starts fresh model context, and does not resend requests" onClick={() => void restartAgentContext()}>Start fresh agent context</button>}
          </p>
        )}

        {!blank && (
        // Keyed per conversation. Row heights are remembered by block
        // sequence, and every session numbers its blocks from zero, so
        // without this a new conversation inherits the old one's measurements.
          <Transcript
            key={chat.activeId ?? "draft"}
            blocks={chat.blocks}
            busy={chat.busy}
            harness={harness}
            agentName={attribution}
            timings={chat.timings}
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
          {blank && !background && <h1 className="draft-headline">What should we build in <span>{chat.project?.name ?? "Kitty"}</span>?</h1>}
          {archived && <p className="archived-note" role="status">
            <span>This chat is archived. Sending a message restores it.</span>
            <button type="button" className="ws-link" onClick={() => void archiveChat(archived.projectId, archived.id, false)}>Restore</button>
          </p>}
          {chat.busy && <WorkingBar
            blocks={chat.blocks}
            timings={chat.timings}
            startedAt={chat.startedAt}
            status={chat.status}
            waiting={chat.approval !== null}
          />}
          <Composer
            key={composerKey}
            storageKey={composerKey}
            busy={chat.busy}
            disabled={!live}
            placeholder={cannotType}
            tools={<Tools />}
            context={<ContextRow onSwitchProject={onSwitchProject} />}
            onSend={(text, attachments) => void send(text, attachments)}
            onCancel={() => void cancel()}
          />
        </div>
      </div>
      {detailsOpen && <ThreadDetails onClose={onCloseDetails} />}
      </div>
    </main>
  );
}
/**
 * What is above the box: where the agent is working, and what the running turn
 * is costing.
 */
function ContextRow({ onSwitchProject }: { onSwitchProject: (projectId: string) => void }): React.ReactElement | null {
  const chat = useChat();
  const { projects } = useProjects();
  if (!chat.project) return null;
  const { root, name, id } = chat.project;
  const others = projects.filter(project => project.root !== null && project.exists && project.id !== id);

  return (
    <div className="contextrow">
      <Popover below title="Project" trigger="chip chip--context" label={<><ProjectMonogram name={name} /><span className="chip__label">{name}</span></>}>
        {close => <>
          <div className="pop__section">Start a chat in</div>
          {others.map(project => <button key={project.id} type="button" className="pop__row pop__row--button" onClick={() => { close(); onSwitchProject(project.id); }}>
            <ProjectMonogram name={project.name} /><span className="pop__row-name">{project.name}</span>
          </button>)}
          <button type="button" className="pop__row pop__row--button" onClick={() => { close(); void chooseProject(); }}>
            <Icon name="folderPlus" size={14} /><span className="pop__row-name">New project…</span>
          </button>
        </>}
      </Popover>
      {root !== null && (
        <span className="chip chip--context chip--static" title={root}>
          <Icon name="folder" size={14} /><span className="chip__label">{root.split(/[\\/]/).filter(Boolean).pop()}</span>
        </span>
      )}
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
    <>
    {/* Settings that are set once and rarely touched live behind one small
        button, so the row reads as just the model and how hard it thinks. */}
    <Popover title="Chat settings" icon trigger="chip chip--icon chip--settings" label={<Icon name="sliders" size={16} />}>
      {close => <>
        <div className="pop__section">Permissions</div>
        {([
          { id: "auto", name: "Auto-approve all", detail: "Default. Automatically allow this conversation's permission requests." },
          { id: "ask", name: "Ask me", detail: "Review approval requests yourself." },
          { id: "edits", name: "Auto-approve edits", detail: "Approve file edits; ask for commands and other permissions." },
        ] as const).map(mode => <button key={mode.id} type="button" className="pop__row pop__row--button permission-choice" aria-pressed={chat.approvalMode === mode.id} onClick={() => { void chooseApprovalMode(mode.id); close(); }}><span><span className="permission-choice__name">{mode.name}</span><span className="permission-choice__detail">{mode.detail}</span></span>{chat.approvalMode === mode.id && <span aria-hidden="true">✓</span>}</button>)}
      </>}
    </Popover>
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
    </>
  );
}
