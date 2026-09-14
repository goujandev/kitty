# Model catalog

The requirement is every Anthropic model and every OpenAI model. Because kitty
drives the vendor CLIs, the honest and complete answer is to ask them. Whatever
your subscription exposes is what you see, and it stays current without kitty
shipping a release.

## Discovery

Each manifest carries a `CatalogSpec` describing how to enumerate models.

| Harness | Mechanism | Yields |
|---|---|---|
| `claude` | a `list_models` control request over the same stream protocol used for sessions | every Anthropic model the subscription allows, with effort levels |
| `codex` | spawn `codex app-server`, JSON-RPC `initialize`, then paginate `model/list` | every OpenAI model the subscription allows, with `supportedReasoningEfforts`, `defaultReasoningEffort` and service tiers |

MonoCode implements both of these and they work. The Codex path in particular
is worth copying closely: it checks the account first so an unauthenticated CLI
produces "run `codex login`" rather than an empty list, pages until the cursor
is exhausted, honours a `hidden` flag, and orders the CLI's own default first.

Probes run in the background after the window is shown, never on the startup
path. Results are cached per harness with the CLI version stamped alongside,
and invalidated when the binary's version changes.

## Per-model settings come from the probe

A model is not just an id. The probe returns the settings that model supports,
and the picker renders them generically:

```
Model {
  id, harness, display_name, native_id,
  context_window: Option<u32>,
  settings: Vec<Setting>,     // select or toggle, with options and a default
}
```

Reasoning effort is the common case, and its vocabulary differs per vendor and
per model. It is stored as the native value and displayed through an alias
table, so a harness that calls a level `extra-high` and one that calls it
`xhigh` are the same choice to the user and the correct string to the CLI.

## Seed list, and why it stays small

A small built-in list per harness exists only so the picker is not empty during
first paint, and it is replaced wholesale by the first successful probe. It is
never merged with live results, because merging is how stale entries survive.

MonoCode's seed is larger and is the source of a recurring failure: a new model
ships, the CLI supports it, but it does not appear until MonoCode updates its
hardcoded array. That is upstream issue #196, Fable 5.1 missing from the
selector. Its Codex entry avoids this by having no seed at all and showing a
loading state instead, which is the better default.

## The escape hatch is required, not optional

The picker always allows typing a model id the probe did not return. It is
passed to the CLI verbatim and marked custom in the UI.

This costs one text field and removes an entire class of "kitty does not
support the model that shipped this morning" problem. MonoCode lacks it and has
an open pull request adding it.

## Resolution and persistence

A session stores `(harness, native_id, settings)`. On load, resolution is exact
match first, then native id, and only then a fallback to the harness default
with a visible notice that the model changed.

MonoCode resolves with prefix matching in both directions between its full
startup ids and the CLI's short live aliases, and had to ship a fix because
relaunching could silently move a saved session to a different model family.
Storing the native id the CLI gave us avoids the ambiguity rather than papering
over it.

## Availability

A harness that is not installed, not logged in, or below its required version
is still listed in the picker, greyed out, with the reason and the exact
command that fixes it. Hiding it just makes the app look broken.
