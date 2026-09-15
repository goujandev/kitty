import { useHarnessState } from "../stores/harnessStore";
import {
  cancel,
  chooseProject,
  newSession,
  openSession,
  respondApproval,
  send,
  useChat,
} from "../stores/chatStore";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Composer } from "./Composer";
import { Sidebar } from "./Sidebar";
import { Transcript } from "./Transcript";

export function ChatView(): React.ReactElement {
  const chat = useChat();
  const { scan } = useHarnessState();
  const harnesses = scan?.harnesses ?? [];

  return (
    <div className="chat">
      <Sidebar
        projectName={chat.project?.name ?? null}
        sessions={chat.sessions}
        activeId={chat.activeId}
        draft={chat.draft}
        harnesses={harnesses}
        onChooseProject={() => void chooseProject()}
        onNewSession={(harness) => void newSession(harness)}
        onOpenSession={(id) => void openSession(id)}
      />

      <main className="chat__main">
        {chat.error && (
          <p className="banner banner--error" role="alert">
            {chat.error}
          </p>
        )}

        {chat.activeId === null && chat.draft === null ? (
          <Empty hasProject={chat.project !== null} />
        ) : (
          <Transcript blocks={chat.blocks} busy={chat.busy} />
        )}

        <StatusLine />

        {chat.approval && (
          <ApprovalPrompt
            approval={chat.approval}
            onRespond={(allow) => void respondApproval(allow)}
          />
        )}

        <Composer
          busy={chat.busy}
          disabled={chat.activeId === null && chat.draft === null}
          onSend={(text) => void send(text)}
          onCancel={() => void cancel()}
        />
      </main>
    </div>
  );
}

function Empty({ hasProject }: { hasProject: boolean }): React.ReactElement {
  return (
    <div className="transcript transcript--empty">
      <p className="muted">
        {hasProject
          ? "Start a session from the sidebar."
          : "Choose a folder to work in."}
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
  for (const limit of limits) {
    parts.push(`${limit.label} ${percent(limit.utilization)}`);
  }

  if (!busy && !status && !notice && parts.length === 0) return null;

  return (
    <div className="statusline">
      <span className="statusline__state">
        {busy && <span className="spinner" aria-hidden="true" />}
        {status ?? (busy ? "Working…" : notice ?? "")}
      </span>
      {parts.length > 0 && (
        <span className="statusline__meta">{parts.join(" · ")}</span>
      )}
    </div>
  );
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
