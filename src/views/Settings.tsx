import {
  chooseBackground,
  removeBackground,
  setTheme,
  useAppearance,
  type Theme,
} from "../stores/appearanceStore";
import {
  loadModels,
  setDefaultChoice,
  toggleFavourite,
  useChat,
} from "../stores/chatStore";
import { useHarnessState } from "../stores/harnessStore";
import { HarnessList } from "./HarnessList";
import { ModelTools } from "./ModelPicker";
import { WindowControls } from "./WindowControls";

/**
 * Settings.
 *
 * Two sections, both of which exist because something in the app needs them
 * today. No placeholders for things we have not built: a settings screen full
 * of empty rooms tells the user the app is unfinished, and every one of them
 * has to be maintained until it is filled.
 */
export type Section = "appearance" | "agents";

export const SECTIONS: { id: Section; name: string }[] = [
  { id: "appearance", name: "Appearance" },
  { id: "agents", name: "Agents" },
];

/** The settings nav, in place of the conversations rail. */
export function SettingsRail({
  section,
  onSelect,
  onClose,
}: {
  section: Section;
  onSelect: (section: Section) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <aside className="rail rail--chats">
      <header className="rail__head" data-tauri-drag-region>
        <h2 className="rail__title">Settings</h2>
        <button type="button" className="linkish" onClick={onClose}>
          Done
        </button>
      </header>

      <ul className="rail__list">
        {SECTIONS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={`entry ${entry.id === section ? "entry--active" : ""}`}
              onClick={() => onSelect(entry.id)}
            >
              <span className="entry__name">{entry.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** The chosen section, in the pane the conversation usually occupies. */
export function SettingsView({
  section,
}: {
  section: Section;
}): React.ReactElement {
  const name = SECTIONS.find((entry) => entry.id === section)?.name ?? "Settings";

  return (
    <main className="chat">
      <header className="chat__head" data-tauri-drag-region>
        <h1 className="chat__title">{name}</h1>
        <WindowControls />
      </header>

      <div className="canvas">
        {section === "agents" ? <AgentSettings /> : <AppearanceSettings />}
      </div>
    </main>
  );
}

function AgentSettings(): React.ReactElement {
  return (
    <div className="settings">
      <div className="settings__inner">
        <h2 className="settings__heading">New conversations</h2>
        <DefaultModel />
      </div>
      <HarnessList />
    </div>
  );
}

/**
 * The model a new conversation starts on.
 *
 * The same two chips as the composer, deliberately: this is the same decision,
 * made in advance, and a settings screen that invents its own control for it
 * is a second thing to learn and a second thing to keep in step.
 */
function DefaultModel(): React.ReactElement {
  const chat = useChat();
  const { scan } = useHarnessState();
  const ready = (scan?.harnesses ?? []).filter((h) => h.ready);
  const choice = chat.defaultChoice;

  return (
    <div className="settings__row">
      <div className="settings__label">
        <span className="settings__name">Default model</span>
        <span className="settings__blurb">
          What a new conversation opens with, so the box is ready to type into
          without choosing anything first. If this agent is not available, the
          one that is runs on whatever it recommends.
        </span>
      </div>

      <div className="settings__control">
        <ModelTools
          harness={choice?.harness ?? ready[0]?.id ?? null}
          harnesses={ready}
          catalogs={chat.catalogs}
          model={choice?.model ?? null}
          runningModel={null}
          effort={choice?.effort ?? null}
          favourites={chat.favourites}
          locked={false}
          disabled={ready.length === 0}
          onOpen={() => {
            for (const entry of ready) {
              if (!chat.catalogs[entry.id]) void loadModels(entry.id);
            }
          }}
          onRefresh={(id) => void loadModels(id, true)}
          onChoose={(harness, model, effort) =>
            void setDefaultChoice({ harness, model, effort })
          }
          onStar={(harness, model) => void toggleFavourite(harness, model)}
        />
        {choice && (
          <button
            type="button"
            className="button"
            title="Go back to whatever the agent recommends"
            onClick={() => void setDefaultChoice(null)}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function AppearanceSettings(): React.ReactElement {
  const { theme, background, error } = useAppearance();

  return (
    <div className="settings">
      <div className="settings__inner">
        {error && (
          <p className="banner banner--error" role="alert">
            {error}
          </p>
        )}

        <h2 className="settings__heading">Theme</h2>
        <div className="themes">
          {(["system", "light", "dark"] as Theme[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`theme ${option === theme ? "theme--chosen" : ""}`}
              onClick={() => void setTheme(option)}
            >
              <ThemeSwatch theme={option} />
              <span className="theme__name">
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </span>
            </button>
          ))}
        </div>

        <h2 className="settings__heading">Background</h2>
        <div className="settings__row">
          <div className="settings__label">
            <span className="settings__name">Window background</span>
            <span className="settings__blurb">
              Shown behind the composer when a conversation is empty, and out of
              the way once there is something to read.
            </span>
          </div>

          <div className="settings__control">
            {background && (
              <span
                className="settings__preview"
                style={{ backgroundImage: `url("${background}")` }}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              className="button"
              onClick={() => void chooseBackground()}
            >
              {background ? "Change" : "Choose"}
            </button>
            {background && (
              <button
                type="button"
                className="button button--deny"
                onClick={() => void removeBackground()}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A miniature of the window in each theme.
 *
 * Drawn rather than screenshotted so it cannot go stale the next time the
 * layout changes, and so the accent is literally the accent.
 */
function ThemeSwatch({ theme }: { theme: Theme }): React.ReactElement {
  return (
    <span className={`swatch swatch--${theme}`} aria-hidden="true">
      <span className="swatch__half swatch__half--light">
        <span className="swatch__rail" />
        <span className="swatch__body">
          <span className="swatch__line" />
          <span className="swatch__line swatch__line--short" />
          <span className="swatch__box" />
        </span>
      </span>
      <span className="swatch__half swatch__half--dark">
        <span className="swatch__rail" />
        <span className="swatch__body">
          <span className="swatch__line" />
          <span className="swatch__line swatch__line--short" />
          <span className="swatch__box" />
        </span>
      </span>
    </span>
  );
}
