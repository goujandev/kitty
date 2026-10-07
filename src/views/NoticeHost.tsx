import { dismissNotice, useNotice } from "../stores/noticeStore";
import { Icon } from "./Icon";

/**
 * Where list confirmations and failures appear: bottom centre, above the
 * composer's reach, one at a time. Confirmations are announced politely;
 * failures as alerts, and they stay until dismissed or acted on.
 */
export function NoticeHost(): React.ReactElement {
  const notice = useNotice();
  return <div className="notice-host" aria-live="polite">
    {notice && <div key={notice.id} className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      <span className="notice__text">{notice.message}</span>
      {notice.action && <button type="button" className="notice__action" onClick={() => { const run = notice.action!.run; dismissNotice(); run(); }}>{notice.action.label}</button>}
      <button type="button" className="notice__close" aria-label="Dismiss" title="Dismiss" onClick={dismissNotice}><Icon name="close" size={14} /></button>
    </div>}
  </div>;
}
