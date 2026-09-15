# Design philosophy

kitty should feel like a finished product, not a tool with a UI bolted on. The
bar is the one Apple sets: you should be able to hand it to someone who has
never seen it, watch them use it, and have nothing to explain.

This document is about *how it should feel*. `ARCHITECTURE.md` is about how it
is built, and the ADRs record why. When those two disagree with this one,
this one loses — an app that is beautiful and wrong is worse than one that is
plain and right.

## The bar

**Nothing on screen that is not doing work.** Every control, label, icon and
divider has to earn its place. If a thing can be removed and the app is still
understood, remove it. A row of buttons that do nothing, a status bar that
repeats what is already visible, a tooltip that restates the label — these are
not neutral. They cost attention, and attention is the whole budget.

This is why kitty's composer has no `+` button and no settings gear, even
though the app it was modelled on has both. There is nothing behind them yet.
A button that does nothing is a broken promise the user only discovers by
pressing it.

**One obvious way to do each thing.** Two routes to the same outcome is a
decision the user has to make for no benefit. Pick the better one, build it
properly, delete the other.

**The content is the interface.** A conversation is the thing you came for, so
it gets the light, the space and the contrast. Chrome recedes: rails are quiet,
metadata is muted, and the agent's answer is the brightest thing in the window.
When we moved model attribution from a header above each message to a line
underneath it, that was this rule — the answer is what you are reading, and
which model produced it is a footnote you look for only when you want it.

**Say the true thing, quietly.** Do not round a number up to look better, do not
show a progress bar for something that is not progressing, and do not report
success before it has happened. When something fails, say what failed and what
to do about it, in one sentence, without an apology. A usage bar goes amber at
75% and red at 90% and is grey the rest of the time, because a bar that is
amber from 40% has said nothing by the time it matters.

## Motion and feedback

**Respond immediately, always.** Every action gets a visible response inside one
frame, even if the work takes ten seconds. A message appears in the transcript
before the CLI has acknowledged it. A model choice applies before the process
has restarted.

**Never move something the user is reading.** The transcript sticks to the
bottom while you are at the bottom, and stops the instant you scroll away.
Content must not reflow under the cursor.

**Animate only to explain.** Motion should show where a thing came from or
where it went. Decoration that moves is decoration that interrupts. Respect
`prefers-reduced-motion` without exception.

## Density and rhythm

**Set a reading width and keep it.** The transcript, the composer and the
controls above it share one centred column. Text that runs the full width of a
wide window is unreadable regardless of how good the typography is.

**Few sizes, few weights, few colours.** One accent. A text colour and a muted
colour. Type sizes from a short scale. Every extra value is another chance for
two parts of the app to disagree with each other.

**Align to something.** Nothing sits at an arbitrary offset. If two things are
near each other they share an edge.

## Words

**Write like a person, not a system.** "That folder is no longer there", not
"ENOENT: no such file or directory". Sentence case everywhere. No exclamation
marks. Never blame the user.

**Labels say what happens, not what the thing is.** "Open a folder" beats
"Folder". "Forget this project and its conversations" beats "Delete".

## Craft

**The last 5% is most of the product.** Where the caret sits when a panel
opens, whether Escape closes it, what happens on a 300-pixel-wide window,
whether the close button reaches the very corner of the screen when maximised.
Nobody praises these. Everybody feels them.

**The window is ours.** kitty draws its own title bar because an OS frame above
a carefully made app looks like a web page in a picture frame. Doing that means
we owe the user everything the frame gave them: drag, double-click to maximise,
edge resize, and Aero Snap all still work.

**No dead ends.** Every state that can go wrong offers the next step. An agent
that is not installed shows the command to install it. A project whose folder
has moved says so and lets you forget it.

**Fast is a feature.** The window paints before anything is probed. The
transcript is virtualised. Search is an index query, not a scan. Slowness is
not a detail to optimise later; it is the difference between a tool you reach
for and one you avoid.

## What we are not doing

Not skeuomorphism, not gradients for their own sake, not a theme engine, not
configurability as a substitute for judgement. Every preference we expose is a
decision we failed to make. Some are worth exposing — which model, which
folder, which agent. Most are not.
