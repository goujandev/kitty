import type { ApprovalKind, PendingApproval } from "../stores/chatStore";

/**
 * The agent asking permission.
 *
 * Deliberately prominent and deliberately blocking: the turn is stalled until
 * this is answered, so burying it as a notification would leave the user
 * watching a spinner with no idea why. Deny is the safe default and is given
 * equal weight, not hidden behind the primary button.
 */
export function ApprovalPrompt({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (allow: boolean) => void;
}): React.ReactElement {
  return (
    <div className="approval" role="alertdialog" aria-label="Permission needed">
      <div className="approval__body">
        <span className={`approval__kind approval__kind--${approval.approvalKind}`}>
          {verb(approval.approvalKind)}
        </span>
        <span className="approval__title" title={approval.title}>
          {approval.title}
        </span>
        {approval.detail && (
          <span className="approval__detail">{approval.detail}</span>
        )}
      </div>
      <div className="approval__actions">
        <button
          type="button"
          className="button button--deny"
          onClick={() => onRespond(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="button button--allow"
          onClick={() => onRespond(true)}
          autoFocus
        >
          Allow
        </button>
      </div>
    </div>
  );
}

function verb(kind: ApprovalKind): string {
  switch (kind) {
    case "edit":
      return "edit files";
    case "command":
      return "run";
    case "network":
      return "network";
    default:
      return "permission";
  }
}
