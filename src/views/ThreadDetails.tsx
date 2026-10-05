import { toolMeta } from "../ipc/bindings";
import { agentName, currentModel, useChat } from "../stores/chatStore";
import { Icon } from "./Icon";

export function ThreadDetails({ onClose }: { onClose: () => void }): React.ReactElement {
  const chat = useChat();
  const model = currentModel();
  const tools = chat.blocks.filter(block => block.kind === "tool").slice(-12).reverse();
  const active = chat.activeId !== null || chat.draft !== null;
  return <aside className="thread-details" aria-label="Thread details">
    <header className="thread-details__head"><span>Thread details</span><button type="button" className="icon-button" aria-label="Close thread details" onClick={onClose}><Icon name="close" size={14} /></button></header>
    <div className="thread-details__content">
      <section><h3>Workspace</h3><div className="thread-details__project"><Icon name={chat.project?.root ? "folder" : "message"} /><strong>{chat.project?.name ?? "New thread"}</strong></div><p className="thread-details__path">{chat.project?.root ?? "Personal conversation"}</p></section>
      <section><h3>Agent</h3><dl><div><dt>Model</dt><dd>{agentName()}</dd></div>{model.effort && <div><dt>Reasoning</dt><dd>{model.effort}</dd></div>}<div><dt>Status</dt><dd><span className={`thread-details__status ${chat.busy || !active ? "is-working" : ""}`} />{chat.approval ? "Awaiting approval" : chat.busy ? "Working" : active ? "Ready" : "No thread selected"}</dd></div><div><dt>Messages</dt><dd>{chat.blocks.filter(block => block.kind === "user" || block.kind === "assistant").length}</dd></div></dl></section>
      <section><h3>Recent activity</h3>{tools.length ? <ul className="thread-details__activity">{tools.map(block => {
        const meta = toolMeta(block);
        return <li key={block.seq}><Icon name={meta.status === "ok" ? "check" : "activity"} size={14} /><div><span>{block.text || "Tool call"}</span><small>{meta.status === "ok" ? "Completed" : meta.status === "running" ? "Running" : meta.status === "denied" ? "Denied" : "Failed"}</small>{meta.detail && <details><summary>Details</summary><pre>{meta.detail}</pre></details>}</div></li>;
      })}</ul> : <p className="thread-details__empty">Agent activity will appear here as you work.</p>}</section>
    </div>
  </aside>;
}
