# Local dictation

Kitty v0.2.3 includes dictation using Handy's local recognition stack and Kitty's
own composer interaction. The user selected and tested the prototype direction,
then authorized release with the model/runtime included in the installer.

## Interaction

- Microphone is immediately before Send. Click starts preparation/recording;
  it becomes a neutral Stop square during recording, distinct from Send's accent.
- Recording activity is visible; no partial recognized words are shown or sent
  to the frontend. Speech is recognized after capture ends.
- An X and waveform fill the footer between model/effort controls and Stop/Send.
  Quiet input appears as dots; louder microphone audio makes taller bars. It
  shows incoming audio volume, not a recognition-confidence score.
- Click Stop to finish and insert the full transcript at the saved
  caret/selection. Existing text around the selection remains available to edit.
- Click Send (or Enter) during recording to finish, recognize, and send the
  combined message. Preparation/transcription disable duplicate submissions.
- X/Escape, changing chats, or an unavailable composer cancels the run.
  Original drafts survive cancellation. Late results cannot edit another chat
  or send after cancellation. Errors leave the original draft available.
- Preparation/transcription use feedback in the microphone button and accessible
  hidden phase announcements. No visible Recording/Cancel row expands the prompt
  box; X remains available to cancel pending work. Errors show recovery text.

## Architecture

Rust owns capture, preparation, recognition, cancellation and run identity.
The typed commands are `dictation_status`, `dictation_start`,
`dictation_finish`, and `dictation_cancel`. Status exposes phase, readiness,
download progress and errors, with no partial text. Finish returns only the
complete transcript. The frontend snapshots its draft/selection before capture
and only accepts a result for that still-current composer/run.

Capture also maintains a fixed 96-bin ring of 75 ms mono RMS measurements.
The existing capture monitor publishes normalized volume history only while
its request/generation owns an active recording. No raw audio samples are sent
over IPC. Status is polled at 100 ms during recording and 350 ms during other
active phases. The waveform view renders at most 80 bars, with newest levels
on the right; narrow footers clip the oldest portion rather than shrinking the
bars to unreadable widths. Silence has no artificial animation. Stop, cancel,
error and a new recording clear the history on both sides of IPC.
The 75 ms bins slow scrolling by one third relative to the original 50 ms bins;
the 80 displayed samples now cover six seconds. Polling/capture stays responsive.

The engine is Handy's `transcribe-rs` 0.3.8 ONNX path with English Moonshine V2
Small. This native dependency requires Rust 1.88 or later to build Kitty;
the CI stable toolchain already satisfies it. The build prepares the speech pack,
including the
model (104,842,676-byte source archive) and Microsoft's CPU ONNX Runtime
(74,075,355-byte source archive). The build script verifies their SHA256 pins,
extracts only allowlisted files and bundles 179,217,486 bytes of model/runtime
resources and licensing notices. Generated files are ignored and never committed.
`tauri.conf.json` maps `resources/dictation/` to the installed `dictation/` folder.
The installer also includes four unmodified, signed Microsoft Visual C++ x64
runtime DLLs from Visual Studio's release redistributables. These are installed
beside Kitty.exe for dependency resolution; no separate VC++ installation is
needed. The preparation script checks their Microsoft signatures and x64 PE
architecture. Their redistribution notice is included in the app directory.
On first use, Rust stages this pack into app-data using cancellable copies and
publishes readiness only after all files are present. Complete installed/cached
packs skip network setup entirely. Unbundled development builds retain the
verified download fallback. Recognition requires no API key, account, upload or
separate LLM refinement.

Audio stays in memory. The microphone is opened only for an explicit run and
closed before recognition/cancellation. Recordings are bounded to two minutes.
The recognizer/model is released after use; ONNX Runtime's loaded library can
remain resident. Do not equate downloaded file size with active RAM, or claim
all system memory is immediately returned.

Inference cancellation is cooperative between recognition chunks. Cancelling
immediately discards the pending result, but an executing native inference
must return before its model memory is released. Initial downloads use
cancellation-aware I/O so a cancelled stalled request does not hold up retries.

The browser development preview simulates phase changes and returns clearly
marked sample text. It never opens a microphone or executes speech recognition.
Only the native Windows build provides real dictation.

## Attribution

Source reference: [Handy v0.9.8](https://github.com/cjpais/Handy/tree/v0.9.8),
including its model catalog and Moonshine engine configuration. Retain the
Handy MIT notice and speech dependency/model licences in `docs/licenses` and
the application's Open-source credits. Kitty uses its own in-composer controls
instead of Handy's global hotkeys, floating overlay, clipboard and paste path.

## Validation

The production prepare/download/extract/recognize path passed on Windows using
the public `dots.wav` fixture from transcribe-rs, without capturing the user's
microphone. The 35.33-second recording took 12.10 seconds including cold model
loading in the unoptimized test build. Its isolated process peaked at 372.5 MiB
(about 391 MB) working set; that is not total Kitty RAM or a guaranteed bound.
The verified extracted model is 164,714,425 bytes and runtime is 14,503,061 bytes,
179,217,486 bytes combined. Recognition sessions are dropped before returning
the result; the ONNX library/environment remain loaded in the process.

Native regressions cover cancellation of stalled network operations, wire
progress, stale ownership/errors, archive extraction, audio format conversion,
resampling tail preservation and long-recording segmentation. Controller tests
cover direct-send sequencing, cancellation and late responses. Browser preview
checks cover recording with no partial words, finish-to-edit, preserved draft on
Cancel, delayed direct Send, and layout at 560px width.

The waveform revision adds native tests for volume response, fixed sample
windows, bounded ordering and ownership/phase fencing, plus frontend tests for
safe normalization, recording updates, clearing and stale replies. Browser
waveform review uses simulated audio levels; default-microphone responsiveness
still needs personal testing in the native prototype.

Browser review at 1280px and the 560px minimum width confirmed the composer stays
124px tall between idle and recording, neutral Stop differs from Send, X preserves
drafts, and Stop returns completed editable text. Existing 20 frontend dictation
tests cover the controller and waveform. The final 75 ms history bins slow
scrolling by one third; capture monitoring/status polling retain their cadence.

A fresh bundled-pack cache also passed real fixture recognition without network
downloads: 35.33 seconds of audio recognized in 11.88 seconds including cold model
loading. Native tests cover offline provisioning, incomplete resources, cancellation
and retained licensing notices. Combined TypeScript/frontend tests, native workspace
tests, formatting and strict Clippy passed for the bundled release. Default microphone, user
voice/accent and subjective accuracy remain for personal testing; the disposable
Windows account two-version installed-update smoke is not available here.
