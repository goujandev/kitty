import { useMemo, useState } from "react";

import type { HarnessId, ModelCatalog, ModelInfo } from "../ipc/bindings";
import { Mark } from "./Marks";
import { Popover } from "./Popover";

/**
 * Choosing a model, and choosing how hard it thinks.
 *
 * Two chips rather than one control: they are separate decisions and the
 * effort levels belong to whichever model is chosen, so a menu that held both
 * had to re-explain itself every time the model changed.
 *
 * The list comes from the CLI, never from a table in this repo, so a model
 * released this morning appears without kitty shipping anything
 * (`MODEL-CATALOG.md`). The custom field exists for the same reason from the
 * other direction: if the probe has not caught up, you can still type an id
 * and it is passed through untouched.
 */
export function ModelTools({
  harness,
  catalog,
  model,
  runningModel,
  effort,
  favourites,
  disabled,
  onOpen,
  onRefresh,
  onChoose,
  onStar,
}: {
  harness: HarnessId | null;
  catalog: ModelCatalog | undefined;
  /** What the user asked for, keyed to the catalog. Null means the default. */
  model: string | null;
  /** What the CLI resolved to. Display only. */
  runningModel: string | null;
  effort: string | null;
  /** Starred model ids, listed first. */
  favourites: string[];
  disabled: boolean;
  onOpen: () => void;
  onRefresh: () => void;
  onChoose: (model: string, effort: string | null) => void;
  onStar: (model: string) => void;
}): React.ReactElement | null {
  if (!harness) return null;

  // With no explicit choice the CLI's own default is in force, so its entry is
  // what the effort levels come from.
  const chosen = catalog?.models.find((m) => m.id === model);
  const shown =
    chosen ?? (model ? undefined : catalog?.models.find((m) => m.isDefault));
  const name = shown?.displayName ?? model ?? runningModel ?? "Default model";
  const levels = shown?.efforts ?? [];

  return (
    <>
      <Popover
        disabled={disabled}
        onOpen={onOpen}
        title="Model"
        label={
          <>
            <Mark harness={harness} size={15} />
            <span className="chip__label">{name}</span>
          </>
        }
      >
        {(close) => (
          <Models
            harness={harness}
            catalog={catalog}
            model={model}
            favourites={favourites}
            onRefresh={onRefresh}
            onStar={onStar}
            onChoose={(id, level) => {
              onChoose(id, level);
              close();
            }}
          />
        )}
      </Popover>

      {levels.length > 0 && shown && (
        <Popover
          narrow
          disabled={disabled}
          title="Reasoning effort"
          label={<span className="chip__label">{effortLabel(effort)}</span>}
        >
          {(close) => (
            <>
              <div className="pop__section">Reasoning</div>
              {levels.map((level) => (
                <button
                  key={level}
                  type="button"
                  className="pop__row pop__row--button"
                  onClick={() => {
                    onChoose(shown.id, level);
                    close();
                  }}
                >
                  <span className="pop__row-name">{effortLabel(level)}</span>
                  {level === effort && <Tick />}
                </button>
              ))}
            </>
          )}
        </Popover>
      )}
    </>
  );
}

/**
 * Effort ids as the CLI spells them, made presentable.
 *
 * The id is what gets sent; this is only ever shown. Anything unrecognised is
 * capitalised and passed through, so a level added tomorrow still reads
 * properly without kitty shipping an update for it.
 */
export function effortLabel(level: string | null): string {
  if (!level) return "Effort";
  if (level === "xhigh") return "Extra high";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function Tick(): React.ReactElement {
  return (
    <svg
      className="pop__tick"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M2 6.4 4.8 9.2 10 3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Star({ on }: { on: boolean }): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M6 1.2 7.5 4.4l3.3.4-2.4 2.3.6 3.3L6 8.8 3 10.4l.6-3.3L1.2 4.8l3.3-.4z"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Models({
  harness,
  catalog,
  model,
  favourites,
  onRefresh,
  onStar,
  onChoose,
}: {
  harness: HarnessId;
  catalog: ModelCatalog | undefined;
  model: string | null;
  favourites: string[];
  onRefresh: () => void;
  onStar: (model: string) => void;
  onChoose: (model: string, effort: string | null) => void;
}): React.ReactElement {
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState("");

  // Starred models first, then the rest. Searching collapses the two into one
  // list: when you are hunting for a name, which group it is in is not the
  // question you are asking.
  const { starred, rest, searching } = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = (catalog?.models ?? []).filter(
      (entry) =>
        !needle ||
        entry.displayName.toLowerCase().includes(needle) ||
        entry.id.toLowerCase().includes(needle),
    );

    if (needle) return { starred: [], rest: all, searching: true };
    return {
      starred: all.filter((entry) => favourites.includes(entry.id)),
      rest: all.filter((entry) => !favourites.includes(entry.id)),
      searching: false,
    };
  }, [catalog, favourites, filter]);

  const row = (entry: ModelInfo) => {
    const starredNow = favourites.includes(entry.id);
    return (
      <div
        key={entry.id}
        className={`pop__row ${entry.id === model ? "pop__row--chosen" : ""}`}
      >
        <button
          type="button"
          className="pop__pick"
          title={entry.description ?? undefined}
          onClick={() => onChoose(entry.id, entry.defaultEffort)}
        >
          <Mark harness={harness} size={15} />
          <span className="pop__row-name">{entry.displayName}</span>
          {entry.isDefault && <span className="pop__tag">default</span>}
        </button>
        <button
          type="button"
          className={`pop__star ${starredNow ? "pop__star--on" : ""}`}
          title={starredNow ? "Remove from favourites" : "Add to favourites"}
          aria-label={starredNow ? "Remove from favourites" : "Add to favourites"}
          onClick={() => onStar(entry.id)}
        >
          <Star on={starredNow} />
        </button>
        <span className="pop__mark">{entry.id === model && <Tick />}</span>
      </div>
    );
  };

  return (
    <>
      <input
        className="pop__search"
        value={filter}
        placeholder="Search models"
        onChange={(event) => setFilter(event.target.value)}
      />

      {!catalog && <p className="muted pop__note">Asking the CLI…</p>}

      {catalog && starred.length + rest.length === 0 && (
        <p className="muted pop__note">No model matches that.</p>
      )}

      {starred.length > 0 && <div className="pop__section">Favourites</div>}
      {starred.map(row)}

      {!searching && starred.length > 0 && rest.length > 0 && (
        <div className="pop__section">All models</div>
      )}
      {rest.map(row)}

      <form
        className="pop__custom"
        onSubmit={(event) => {
          event.preventDefault();
          const id = custom.trim();
          if (!id) return;
          // Passed through untouched: if the probe has not caught up with a
          // new model, typing its id should still work.
          onChoose(id, null);
          setCustom("");
        }}
      >
        <input
          className="pop__input"
          value={custom}
          placeholder="Or type a model id"
          onChange={(event) => setCustom(event.target.value)}
        />
        <button type="submit" className="button" disabled={!custom.trim()}>
          Use
        </button>
      </form>

      <button type="button" className="linkish pop__refresh" onClick={onRefresh}>
        Refresh from {harness}
      </button>
    </>
  );
}
