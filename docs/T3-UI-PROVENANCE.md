# T3 Code interface provenance

Kitty's chrome, composer and sidebar are adapted from T3 Code's appearance, with
controls changed only where Kitty's functionality differs. This document records
the source, the attribution, and what the current direct-chat interface keeps.

## Reference and attribution

Source: [pingdotgg/t3code](https://github.com/pingdotgg/t3code/tree/5eb87730871ac6125266b48b98d067de00a19ec7),
revision `5eb87730871ac6125266b48b98d067de00a19ec7`, inspected 2026-10-05.
The user's 2559x1439 T3 screenshot was the visual target; application content ends
above the taskbar at y1392. Upstream source and that installed version can differ;
measured screenshot geometry took precedence for the opening screen.

Inspected sources under `apps/web/src`: `index.css`, `projectIdentity.ts`,
`projectIconColors.ts`, `components/Sidebar.tsx`, `SidebarThreadHeader.tsx`,
`ProjectFavicon.tsx`, `ProjectMonogram.tsx`, `ChatView.tsx`, and the chat directory's
`ChatCanvas.tsx`, `ChatComposer.tsx`, `ComposerSurface.tsx`,
`ComposerPrimaryActions.tsx`, and `composerProviderState.tsx`.
The inspection used an ignored local source cache under
`.screenshots/t3-reference`; that disposable cache is not a release asset.

T3's theme, component geometry and monogram algorithm/SVG are adapted under MIT.
Copyright 2026 T3 Tools Inc. The complete notice is retained in
[licenses/T3-Code-MIT.txt](licenses/T3-Code-MIT.txt). Lucide React 0.564.0 matches
the inspected upstream dependency, replacing the previous handmade stroke icons.
Its ISC/Feather notices are retained in
[licenses/Lucide-LICENSE.txt](licenses/Lucide-LICENSE.txt). Both notices are bundled
in Settings > Open-source credits. Kitty's existing app icon is unchanged.

## Original reference presentation

- 256px sidebar, collapse control before the brand, search/folder/folder-plus/
  new-chat controls in one row, project monograms and project cards, a Settled
  section and a bottom icon strip. A single Settings entry opens every settings
  section.
- The open project lists its conversations directly under its card, with the
  agent's mark, a working indicator and delete. A card shows the most recently
  opened conversation's title.
- Project / conversation breadcrumb in a 40px title bar, with New chat and
  thread-details buttons.
- Unsent drafts and empty conversations show the centered hero headline and
  composer. Loading, active work, approvals and errors keep their normal views.
  The composer docks once conversation content arrives.
- The composer uses a 768px lane, 24px corners, 16px body/footer insets, 70px
  minimum input, 144px normal main surface and 32px round send button. The lower
  checkout strip uses a 22px side inset, 16px lower corners and 24px control row.
  Model, reasoning and permission selectors share one visual family.
- Measured dark surfaces: canvas #0a0a0a, sidebar #040404, composer #101010,
  checkout strip #131313. Sidebar stroke icons #545454; placeholder #666666;
  disabled send opacity .64. Source light/dark theme tokens, system font and
  compact controls extend to menus, settings and the transcript.
- A one-time `kitty:t3-reference-presentation` preference migration adopts dark
  theme, 100% zoom and a 256px sidebar to match the requested reference. Later
  theme, zoom and resize choices remain saved normally.

Kitty-specific adaptations at that stage: the folder strip opens the project chooser and shows
the actual path in its tooltip. Working/approval badges are orange; unseen
successful results are green, failures and stops distinct, and unread results
clear only when actually viewed. Unsupported Git, attachment, terminal and cloud
actions are not shown as fake controls. The textarea keeps Enter/Shift+Enter/IME/
Stop behavior and per-conversation drafts. Session and provider authority and
IPC contracts stay in Rust.

## History

The adaptation was first built for the agent-team prototype (T-012 to T-016),
whose Boss, Team lead and worker panes were removed with orchestration in T-024
(see `coordination/tasks.md`). The visual measurements above were validated then
against the reference screenshot. Later direct-chat changes add tabs, custom
wallpapers and derived chrome colours, local dictation, image/text attachments,
and a persistent working indicator. The current implemented interface and
supported controls are documented in [README.md](../README.md); the measurements
above preserve the original reference and attribution, not current defaults.
