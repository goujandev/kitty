import { useCallback, useMemo, useState } from "react";

import type {
  HarnessId,
  HarnessStatus,
  ModelCatalog,
  ModelInfo,
} from "../ipc/bindings";
import { Mark } from "./Marks";
import { Popover } from "./Popover";

/**
 * Choosing a model, and choosing how hard it thinks.
 *
 * One list, both vendors. Which CLI runs a conversation is not a decision
 * anyone makes on its own -- you pick a model, and the vendor comes with it --
 * so asking for the agent first and the model second was asking the same
 * question twice.
 *
 * Two chips rather than one, though: the model and its effort are separate
 * decisions, and the effort levels belong to whichever model is chosen, so a
 * menu holding both had to re-explain itself every time the model changed.
 *
 * The list comes from the CLIs, never from a table in this repo, so a model
 * released this morning appears without kitty shipping anything
 * (`MODEL-CATALOG.md`). The custom field exists for the same reason from the
 * other direction: if the probe has not caught up, you can still type an id
 * and it is passed through untouched.
 */
export function ModelTools({
  harness,
  harnesses,
  catalogs,
  model,
  runningModel,
  effort,
  favourites,
  locked,
  disabled,
  onOpen,
  onRefresh,
  onChoose,
  onStar,
}: {
  /** The vendor in force, from the open session or the pending draft. */
  harness: HarnessId | null;
  /** Every harness kitty found, for labels and for whether it can run. */
  harnesses: HarnessStatus[];
  catalogs: Partial<Record<HarnessId, ModelCatalog>>;
  /** What the user asked for, keyed to the catalog. Null means the default. */
  model: string | null;
  /** What the CLI resolved to. Display only. */
  runningModel: string | null;
  effort: string | null;
  /** Starred model ids, per harness. Listed first, across vendors. */
  favourites: Partial<Record<HarnessId, string[]>>;
  /**
   * The conversation has started, so the vendor is settled.
   *
   * Changing model inside a session restarts the CLI and resumes its history;
   * the other vendor has no history to resume, because it was never told any
   * of it. So its models are shown and not selectable, rather than hidden and
   * unexplained.
   */
  locked: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRefresh: (harness: HarnessId) => void;
  onChoose: (harness: HarnessId, model: string, effort: string | null) => void;
  onStar: (harness: HarnessId, model: string) => void;
}): React.ReactElement | null {
  // With no explicit choice the CLI's own default is in force, so its entry is
  // what the effort levels come from.
  const catalog = harness ? catalogs[harness] : undefined;
  const chosen = catalog?.models.find((m) => m.id === model);
  const shown =
    chosen ?? (model ? undefined : catalog?.models.find((m) => m.isDefault));
  const name = shown?.displayName ?? model ?? runningModel ?? "Choose a model";
  const levels = shown?.efforts ?? [];

  return (
    <>
      <Popover
        disabled={disabled}
        onOpen={onOpen}
        title="Model"
        label={
          <>
            {harness && <Mark harness={harness} size={15} />}
            <span className="chip__label">{name}</span>
          </>
        }
      >
        {(close) => (
          <Models
            harness={harness}
            harnesses={harnesses}
            catalogs={catalogs}
            model={model}
            favourites={favourites}
            locked={locked}
            onRefresh={onRefresh}
            onStar={onStar}
            onChoose={(vendor, id, level) => {
              onChoose(vendor, id, level);
              close();
            }}
          />
        )}
      </Popover>

      {levels.length > 0 && shown && harness && (
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
                    onChoose(harness, shown.id, level);
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

/** One model, tagged with the vendor it belongs to. */
interface Entry {
  harness: HarnessId;
  model: ModelInfo;
}

function Models({
  harness,
  harnesses,
  catalogs,
  model,
  favourites,
  locked,
  onRefresh,
  onStar,
  onChoose,
}: {
  harness: HarnessId | null;
  harnesses: HarnessStatus[];
  catalogs: Partial<Record<HarnessId, ModelCatalog>>;
  model: string | null;
  favourites: Partial<Record<HarnessId, string[]>>;
  locked: boolean;
  onRefresh: (harness: HarnessId) => void;
  onStar: (harness: HarnessId, model: string) => void;
  onChoose: (harness: HarnessId, model: string, effort: string | null) => void;
}): React.ReactElement {
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState("");

  const starredHere = useCallback(
    (entry: Entry): boolean =>
      (favourites[entry.harness] ?? []).includes(entry.model.id),
    [favourites],
  );
  // Starred models first, across vendors, then the rest grouped by vendor.
  // Searching collapses all of it into one list: when you are hunting for a
  // name, whose model it is and which group it is in are not the question you
  // are asking.
  const { starred, groups, searching, empty } = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (entry: Entry): boolean =>
      !needle ||
      entry.model.displayName.toLowerCase().includes(needle) ||
      entry.model.id.toLowerCase().includes(needle);

    const all: Entry[] = harnesses.flatMap((status) =>
      (catalogs[status.id]?.models ?? [])
        .map((m) => ({ harness: status.id, model: m }))
        .filter(matches),
    );

    if (needle) {
      return { starred: [], groups: [all], searching: true, empty: all.length === 0 };
    }

    const stars = all.filter(starredHere);
    const rest = harnesses.map((status) =>
      all.filter((entry) => entry.harness === status.id && !starredHere(entry)),
    );
    return {
      starred: stars,
      groups: rest,
      searching: false,
      empty: all.length === 0,
    };
  }, [catalogs, favourites, filter, harnesses, starredHere]);

  const row = (entry: Entry) => {
    const { model: info } = entry;
    const starredNow = starredHere(entry);
    // Only the vendor already running this conversation can keep running it.
    const reachable = !locked || harness === null || entry.harness === harness;
    const chosen = entry.harness === harness && info.id === model;

    return (
      <div
        key={`${entry.harness}:${info.id}`}
        className={`pop__row ${chosen ? "pop__row--chosen" : ""}`}
      >
        <button
          type="button"
          className="pop__pick"
          disabled={!reachable}
          title={
            reachable
              ? info.description ?? undefined
              : "Start a new chat to use this one — a conversation cannot change vendor half way through"
          }
          onClick={() => onChoose(entry.harness, info.id, info.defaultEffort)}
        >
          <Mark harness={entry.harness} size={15} />
          <span className="pop__row-name">{info.displayName}</span>
          {info.isDefault && <span className="pop__tag">default</span>}
        </button>
        <button
          type="button"
          className={`pop__star ${starredNow ? "pop__star--on" : ""}`}
          title={starredNow ? "Remove from favourites" : "Add to favourites"}
          aria-label={starredNow ? "Remove from favourites" : "Add to favourites"}
          onClick={() => onStar(entry.harness, info.id)}
        >
          <Star on={starredNow} />
        </button>
        <span className="pop__mark">{chosen && <Tick />}</span>
      </div>
    );
  };

  const loading = harnesses.some((status) => !catalogs[status.id]);

  return (
    <>
      <input
        className="pop__search"
        value={filter}
        placeholder="Search models"
        onChange={(event) => setFilter(event.target.value)}
      />

      {empty && loading && <p className="muted pop__note">Asking the CLIs…</p>}
      {empty && !loading && (
        <p className="muted pop__note">
          {filter.trim() ? "No model matches that." : "No models to offer."}
        </p>
      )}

      {starred.length > 0 && <div className="pop__section">Favourites</div>}
      {starred.map(row)}

      {groups.map((entries, index) => {
        if (entries.length === 0) return null;
        const status = harnesses[index];
        return (
          <div key={status?.id ?? index}>
            {/* Named per vendor rather than one "All models" heading, so the
                two lists are told apart by reading and not by squinting at the
                logo on every row. */}
            {!searching && status && (
              <div className="pop__section">{status.label}</div>
            )}
            {entries.map(row)}
          </div>
        );
      })}

      {harness && (
        <>
          <form
            className="pop__custom"
            onSubmit={(event) => {
              event.preventDefault();
              const id = custom.trim();
              if (!id) return;
              // Passed through untouched: if the probe has not caught up with
              // a new model, typing its id should still work.
              onChoose(harness, id, null);
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

          <button
            type="button"
            className="linkish pop__refresh"
            onClick={() => onRefresh(harness)}
          >
            Refresh from {harness}
          </button>
        </>
      )}
    </>
  );
}
