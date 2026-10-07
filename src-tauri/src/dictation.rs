//! On-demand, local dictation using Handy's Moonshine V2 Small speech pack.
//! Capture stays on its own thread; audio never leaves RAM. No model or device
//! is opened at startup, and every inference owns and drops its model sessions.
#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use rubato::{FftFixedIn, Resampler};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use transcribe_rs::onnx::moonshine::StreamingModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

const MODEL_NAME: &str = "moonshine-small-streaming-en";
const MODEL_URL: &str = "https://blob.handy.computer/moonshine-small-streaming-en.tar.gz";
// Handy v0.9.8's catalog pins the compressed archive, not individual files.
const MODEL_HASH: &str = "dbb3e1c1832bd88a4ac712f7449a136cc2c9a18c5fe33a12ed1b7cb1cfe9cdd5";
const RUNTIME_NAME: &str = "onnxruntime-win-x64-1.24.2";
const RUNTIME_URL: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.24.2/onnxruntime-win-x64-1.24.2.zip";
// Published digest on Microsoft's v1.24.2 release asset.
const RUNTIME_HASH: &str = "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0";
const MODEL_FILES: &[&str] = &[
    "streaming_config.json",
    "frontend.ort",
    "encoder.ort",
    "adapter.ort",
    "cross_kv.ort",
    "decoder_kv.ort",
    "tokenizer.bin",
];
const MODEL_BUNDLED_FILES: &[&str] = &[
    "streaming_config.json",
    "frontend.ort",
    "encoder.ort",
    "adapter.ort",
    "cross_kv.ort",
    "decoder_kv.ort",
    "tokenizer.bin",
    "LICENSE.txt",
];
const RUNTIME_FILES: &[&str] = &[
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
    "LICENSE",
    "ThirdPartyNotices.txt",
];
const RATE: usize = 16_000;
const RECORD_LIMIT: Duration = Duration::from_secs(120);
const CANCELLED: &str = "Dictation was cancelled.";
const LIMIT_ERROR: &str = "Recording reached two minutes. Start again with a shorter message.";
const PACK_MARKER: &str = "verified.sha256";
const WAVEFORM_BINS: usize = 96;
const WAVEFORM_BIN_MS: usize = 75;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Preparing,
    Recording,
    Transcribing,
    Error,
}

#[derive(Clone, Serialize)]
pub struct DictationStatus {
    pub id: Option<String>,
    pub phase: Phase,
    pub ready: bool,
    pub progress: Option<f64>,
    pub error: Option<String>,
    /// Recent 75 ms microphone-volume bins, oldest first, normalized to 0..=1.
    /// No audio samples or partial recognized words cross this boundary.
    pub waveform: Vec<f32>,
}

impl Default for DictationStatus {
    fn default() -> Self {
        Self {
            id: None,
            phase: Phase::Idle,
            ready: false,
            progress: None,
            error: None,
            waveform: Vec::new(),
        }
    }
}

impl DictationStatus {
    fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
        if phase != Phase::Recording {
            self.waveform.clear();
        }
    }
}

struct Run {
    id: String,
    generation: u64,
    cancelled: Arc<AtomicBool>,
    capture: Option<mpsc::Sender<CaptureRequest>>,
}

#[derive(Default)]
struct Inner {
    status: DictationStatus,
    run: Option<Run>,
    generation: u64,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    // A cancelled download/inference may still be unwinding. Serialize these
    // workers so a retry cannot replace files or load a second model underneath it.
    work: Mutex<()>,
}

#[derive(Clone, Default)]
pub struct DictationState {
    shared: Arc<Shared>,
}

#[derive(Clone)]
struct Ticket {
    id: String,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

impl Ticket {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A failed worker must not permanently lock out a recoverable retry.
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn owns(inner: &Inner, ticket: &Ticket) -> bool {
    inner
        .run
        .as_ref()
        .is_some_and(|run| run.id == ticket.id && run.generation == ticket.generation)
}

impl Shared {
    fn begin(&self, id: String) -> Result<Ticket, String> {
        if id.is_empty() || id.len() > 200 {
            return Err("Choose a valid dictation request.".into());
        }
        let mut inner = lock(&self.inner);
        if matches!(
            inner.status.phase,
            Phase::Preparing | Phase::Recording | Phase::Transcribing
        ) {
            return Err("Another recording is already in progress.".into());
        }
        inner.generation = inner.generation.wrapping_add(1);
        let ticket = Ticket {
            id: id.clone(),
            generation: inner.generation,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        inner.run = Some(Run {
            id: id.clone(),
            generation: ticket.generation,
            cancelled: ticket.cancelled.clone(),
            capture: None,
        });
        inner.status = DictationStatus {
            id: Some(id),
            phase: Phase::Preparing,
            ready: inner.status.ready,
            progress: None,
            error: None,
            waveform: Vec::new(),
        };
        Ok(ticket)
    }

    fn error(&self, ticket: &Ticket, message: String) {
        let mut inner = lock(&self.inner);
        if owns(&inner, ticket) {
            if let Some(run) = inner.run.as_mut() {
                run.cancelled.store(true, Ordering::Release);
                if let Some(capture) = run.capture.take() {
                    let _ = capture.send(CaptureRequest::Cancel);
                }
            }
            inner.status.set_phase(Phase::Error);
            inner.status.progress = None;
            inner.status.error = Some(message);
        }
    }

    fn progress(&self, ticket: &Ticket, progress: f64) {
        let mut inner = lock(&self.inner);
        if owns(&inner, ticket) && inner.status.phase == Phase::Preparing {
            inner.status.progress = Some((progress / 100.0).clamp(0.0, 1.0));
        }
    }

    fn waveform(&self, ticket: &Ticket, envelope: &VolumeEnvelope) {
        let mut inner = lock(&self.inner);
        if owns(&inner, ticket) && ticket.check().is_ok() && inner.status.phase == Phase::Recording
        {
            inner.status.waveform.clear();
            inner.status.waveform.extend(envelope.levels());
        }
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri owns deserialized IPC arguments.
pub fn dictation_status(state: State<'_, DictationState>) -> DictationStatus {
    lock(&state.shared.inner).status.clone()
}

#[tauri::command]
pub async fn dictation_start(
    app: AppHandle,
    state: State<'_, DictationState>,
    id: String,
) -> Result<(), String> {
    let shared = state.shared.clone();
    let ticket = shared.begin(id)?;
    let work_ticket = ticket.clone();
    let work_shared = shared.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _serial = lock(&work_shared.work);
        work_ticket.check()?;
        let root = app
            .path()
            .app_data_dir()
            .map_err(|_| "Pantheon could not open its speech-pack folder.".to_string())?
            .join("dictation");
        let bundled = app
            .path()
            .resource_dir()
            .ok()
            .map(|path| path.join("dictation"));
        prepare_pack(&root, bundled.as_deref(), &work_ticket, &work_shared)?;
        work_ticket.check()?;
        let capture = open_capture(work_shared.clone(), work_ticket.clone())?;
        let mut inner = lock(&work_shared.inner);
        if !owns(&inner, &work_ticket) || work_ticket.check().is_err() {
            let _ = capture.send(CaptureRequest::Cancel);
            return Err(CANCELLED.into());
        }
        if let Some(run) = inner.run.as_mut() {
            run.capture = Some(capture);
        }
        inner.status.set_phase(Phase::Recording);
        inner.status.ready = true;
        inner.status.progress = None;
        Ok(())
    })
    .await
    .map_err(|_| "Dictation could not start. Try again.".to_string())
    .and_then(std::convert::identity);
    if let Err(message) = &result {
        shared.error(&ticket, message.clone());
    }
    result
}

#[tauri::command]
pub async fn dictation_finish(
    app: AppHandle,
    state: State<'_, DictationState>,
    id: String,
) -> Result<String, String> {
    let shared = state.shared.clone();
    let (ticket, capture) = {
        let mut inner = lock(&shared.inner);
        if inner.status.id.as_deref() != Some(&id) {
            return Err(CANCELLED.into());
        }
        if inner.status.phase == Phase::Error {
            return Err(inner
                .status
                .error
                .clone()
                .unwrap_or_else(|| "Recording stopped. Try again.".into()));
        }
        if inner.status.phase != Phase::Recording {
            return Err("There is no recording to transcribe.".into());
        }
        let run = inner.run.as_mut().ok_or_else(|| CANCELLED.to_string())?;
        let ticket = Ticket {
            id,
            generation: run.generation,
            cancelled: run.cancelled.clone(),
        };
        let capture = run
            .capture
            .take()
            .ok_or_else(|| "The microphone has stopped. Start again.".to_string())?;
        inner.status.set_phase(Phase::Transcribing);
        (ticket, capture)
    };
    let work_ticket = ticket.clone();
    let work_shared = shared.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        capture
            .send(CaptureRequest::Finish(tx))
            .map_err(|_| "The microphone has stopped. Start again.".to_string())?;
        let audio = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "The microphone did not stop. Try again.".to_string())??;
        // Microphone is already closed before we wait for any previous inference.
        let _serial = lock(&work_shared.work);
        work_ticket.check()?;
        let root = app
            .path()
            .app_data_dir()
            .map_err(|_| "Pantheon could not open its speech-pack folder.".to_string())?
            .join("dictation");
        recognize(&root, audio, &work_ticket)
    })
    .await
    .map_err(|_| "Transcription failed. Try recording again.".to_string())
    .and_then(std::convert::identity);
    let mut inner = lock(&shared.inner);
    if !owns(&inner, &ticket) || ticket.check().is_err() {
        return Err(CANCELLED.into());
    }
    match &result {
        Ok(_) => {
            inner.run = None;
            inner.status = DictationStatus {
                ready: true,
                ..DictationStatus::default()
            };
        }
        Err(message) => {
            inner.status.set_phase(Phase::Error);
            inner.status.error = Some(message.clone());
        }
    }
    result
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri owns deserialized IPC arguments.
pub fn dictation_cancel(state: State<'_, DictationState>, id: String) {
    state.cancel(&id);
}

impl DictationState {
    /// Also called when the owning window is closing, without opening any device.
    pub fn cancel_all(&self) {
        let id = lock(&self.shared.inner).status.id.clone();
        if let Some(id) = id {
            self.cancel(&id);
        }
    }

    fn cancel(&self, id: &str) {
        let mut inner = lock(&self.shared.inner);
        if inner.status.id.as_deref() != Some(id) {
            return;
        }
        if let Some(run) = inner.run.take() {
            run.cancelled.store(true, Ordering::Release);
            if let Some(capture) = run.capture {
                let _ = capture.send(CaptureRequest::Cancel);
            }
        }
        inner.status = DictationStatus {
            ready: inner.status.ready,
            ..DictationStatus::default()
        };
    }
}

struct Audio {
    samples: Vec<f32>,
    rate: u32,
}
enum CaptureRequest {
    Finish(mpsc::Sender<Result<Audio, String>>),
    Cancel,
}
#[derive(Default)]
struct CaptureBuffer {
    samples: Vec<f32>,
    error: Option<String>,
    full: bool,
    envelope: VolumeEnvelope,
}

/// A fixed ring avoids allocating or publishing IPC in the realtime callback.
/// Sample-count windows make the waveform independent of device callback size.
#[derive(Clone, Copy)]
struct VolumeEnvelope {
    values: [f32; WAVEFORM_BINS],
    next: usize,
    len: usize,
    window_samples: usize,
    samples: usize,
    energy: f64,
}

impl Default for VolumeEnvelope {
    fn default() -> Self {
        Self::new(RATE)
    }
}

impl VolumeEnvelope {
    fn new(rate: usize) -> Self {
        Self {
            values: [0.0; WAVEFORM_BINS],
            next: 0,
            len: 0,
            window_samples: (rate * WAVEFORM_BIN_MS / 1_000).max(1),
            samples: 0,
            energy: 0.0,
        }
    }

    fn observe(&mut self, mono: f32) {
        self.energy += f64::from(mono).powi(2);
        self.samples += 1;
        if self.samples == self.window_samples {
            let rms = (self.energy / self.window_samples as f64).sqrt();
            // A decibel scale makes ordinary speech visible while true silence
            // stays flat; -60 dB is the display floor and 0 dB is full scale.
            let level = if rms > 0.0 {
                ((20.0 * rms.log10() + 60.0) / 60.0).clamp(0.0, 1.0) as f32
            } else {
                0.0
            };
            self.values[self.next] = level;
            self.next = (self.next + 1) % WAVEFORM_BINS;
            self.len = (self.len + 1).min(WAVEFORM_BINS);
            self.samples = 0;
            self.energy = 0.0;
        }
    }

    fn levels(&self) -> impl Iterator<Item = f32> + '_ {
        let start = (self.next + WAVEFORM_BINS - self.len) % WAVEFORM_BINS;
        (0..self.len).map(move |offset| self.values[(start + offset) % WAVEFORM_BINS])
    }
}

fn open_capture(
    shared: Arc<Shared>,
    ticket: Ticket,
) -> Result<mpsc::Sender<CaptureRequest>, String> {
    let (tx, rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::channel();
    std::thread::Builder::new().name("pantheon-dictation-microphone".into()).spawn(move || {
            if ticket.check().is_err() { let _ = started_tx.send(Err(CANCELLED.into())); return; }
            let buffer = Arc::new(Mutex::new(CaptureBuffer::default()));
        let setup = capture_stream(&buffer);
        let (stream, rate) = match setup {
            Ok(value) => value,
            Err(message) => { let _ = started_tx.send(Err(message)); return; }
        };
            if ticket.check().is_err() { let _ = started_tx.send(Err(CANCELLED.into())); return; }
            if let Err(error) = stream.play() {
            let _ = started_tx.send(Err(format!("The microphone could not start: {error}. Check Windows microphone permissions.")));
            return;
        }
        if started_tx.send(Ok(())).is_err() { return; }
        let started = Instant::now();
        loop {
            if ticket.check().is_err() { break; }
            let (problem, envelope) = {
                let buffer = lock(&buffer);
                let problem = if buffer.full || started.elapsed() >= RECORD_LIMIT { Some(LIMIT_ERROR.to_string()) } else { buffer.error.clone() };
                (problem, buffer.envelope)
            };
            if let Some(message) = problem {
                drop(stream);
                shared.error(&ticket, message);
                return;
            }
            shared.waveform(&ticket, &envelope);
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(CaptureRequest::Finish(reply)) => {
                    drop(stream);
                    let mut buffer = lock(&buffer);
                    let result = if let Some(message) = buffer.error.take() { Err(message) }
                        else if buffer.full || started.elapsed() >= RECORD_LIMIT { Err(LIMIT_ERROR.into()) }
                        else { Ok(Audio { samples: std::mem::take(&mut buffer.samples), rate }) };
                    let _ = reply.send(result);
                    return;
                }
                Ok(CaptureRequest::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {},
            }
        }
        drop(stream);
    }).map_err(|_| "Pantheon could not open the microphone. Try again.".to_string())?;
    started_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| {
            "The microphone did not start. Check Windows microphone permissions.".to_string()
        })??;
    Ok(tx)
}

fn capture_stream(buffer: &Arc<Mutex<CaptureBuffer>>) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| "No microphone was found. Connect one and try again.".to_string())?;
    let config = device.default_input_config().map_err(|_| {
        "The microphone is unavailable. Check Windows microphone permissions.".to_string()
    })?;
    let rate = config.sample_rate().0;
    if !(8_000..=192_000).contains(&rate) || config.channels() == 0 {
        return Err("This microphone's audio format is unsupported.".into());
    }
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, buffer.clone()),
        cpal::SampleFormat::F64 => build_stream::<f64>(&device, &config, buffer.clone()),
        cpal::SampleFormat::I8 => build_stream::<i8>(&device, &config, buffer.clone()),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, buffer.clone()),
        cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, buffer.clone()),
        cpal::SampleFormat::I64 => build_stream::<i64>(&device, &config, buffer.clone()),
        cpal::SampleFormat::U8 => build_stream::<u8>(&device, &config, buffer.clone()),
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, buffer.clone()),
        cpal::SampleFormat::U32 => build_stream::<u32>(&device, &config, buffer.clone()),
        cpal::SampleFormat::U64 => build_stream::<u64>(&device, &config, buffer.clone()),
        _ => return Err("This microphone's audio format is unsupported.".into()),
    }
    .map_err(|error| {
        format!("The microphone is unavailable: {error}. Check Windows microphone permissions.")
    })?;
    Ok((stream, rate))
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<CaptureBuffer>>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let max_samples = config.sample_rate.0 as usize * RECORD_LIMIT.as_secs() as usize;
    // Reserve once outside the realtime callback; store only mono frames.
    {
        let mut buffer = lock(&buffer);
        buffer.samples.reserve_exact(max_samples);
        buffer.envelope = VolumeEnvelope::new(config.sample_rate.0 as usize);
    }
    let errors = buffer.clone();
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            // The monitor reads flags and copies a fixed volume ring. Brief contention
            // must not drop audio or turn a good recording into an error.
            append_mono(&mut lock(&buffer), data, channels, max_samples);
        },
        move |_error| {
            lock(&errors).error =
                Some("The microphone disconnected. Reconnect it and start again.".into());
        },
        None,
    )
}

fn append_mono<T>(buffer: &mut CaptureBuffer, data: &[T], channels: usize, max_samples: usize)
where
    T: Sample,
    f32: FromSample<T>,
{
    for frame in data.chunks_exact(channels) {
        if buffer.samples.len() >= max_samples {
            buffer.full = true;
            break;
        }
        let mono = frame
            .iter()
            .map(|&sample| f32::from_sample(sample))
            .sum::<f32>()
            / channels as f32;
        let mono = if mono.is_finite() {
            mono.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        buffer.samples.push(mono);
        buffer.envelope.observe(mono);
    }
}

fn io_error(_: impl std::fmt::Display) -> String {
    "Pantheon could not save its speech pack. Check free disk space and try again.".into()
}

fn verified(directory: &Path, hash: &str, files: &[&str]) -> bool {
    fs::read_to_string(directory.join(PACK_MARKER)).is_ok_and(|marker| marker == hash)
        && files.iter().all(|name| directory.join(name).is_file())
}

fn prepare_pack(
    root: &Path,
    bundled: Option<&Path>,
    ticket: &Ticket,
    shared: &Shared,
) -> Result<(), String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("This dictation prototype requires 64-bit Windows.".into());
    }
    ticket.check()?;
    fs::create_dir_all(root).map_err(io_error)?;
    let model_dir = root.join(MODEL_NAME);
    let runtime_dir = root.join(RUNTIME_NAME);
    // The installer ships the verified pack. Provision it on demand without
    // creating an HTTP client or loading any recognition sessions at startup.
    if let Some(bundled) = bundled {
        if !verified(&model_dir, MODEL_HASH, MODEL_FILES) {
            install_bundled_component(
                &bundled.join(MODEL_NAME),
                &root.join("model.staging"),
                &model_dir,
                MODEL_HASH,
                MODEL_BUNDLED_FILES,
                ticket,
            )?;
        }
        shared.progress(ticket, 60.0);
        if !verified(&runtime_dir, RUNTIME_HASH, RUNTIME_FILES) {
            install_bundled_component(
                &bundled.join(RUNTIME_NAME),
                &root.join("runtime.staging"),
                &runtime_dir,
                RUNTIME_HASH,
                RUNTIME_FILES,
                ticket,
            )?;
        }
    }
    if verified(&model_dir, MODEL_HASH, MODEL_FILES)
        && verified(&runtime_dir, RUNTIME_HASH, RUNTIME_FILES)
    {
        ticket.check()?;
        shared.progress(ticket, 100.0);
        return Ok(());
    }
    // Unbundled development/prototype builds retain the verified download path.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .user_agent("Pantheon-local-dictation/0.2")
        .build()
        .map_err(|_| "The speech-pack download could not start.".to_string())?;
    if !verified(&model_dir, MODEL_HASH, MODEL_FILES) {
        let archive = root.join("model.download");
        download(
            &client,
            DownloadSpec {
                url: MODEL_URL,
                hash: MODEL_HASH,
                max_bytes: 180_000_000,
            },
            &archive,
            ticket,
            shared,
            (0.0, 60.0),
        )?;
        let stage = root.join("model.staging");
        reset_stage(&stage)?;
        extract_model(&archive, &stage, ticket)?;
        fs::write(stage.join(PACK_MARKER), MODEL_HASH).map_err(io_error)?;
        ticket.check()?;
        replace_directory(&stage, &model_dir)?;
        let _ = fs::remove_file(archive);
    }
    shared.progress(ticket, 60.0);
    if !verified(&runtime_dir, RUNTIME_HASH, RUNTIME_FILES) {
        let archive = root.join("runtime.download");
        download(
            &client,
            DownloadSpec {
                url: RUNTIME_URL,
                hash: RUNTIME_HASH,
                max_bytes: 100_000_000,
            },
            &archive,
            ticket,
            shared,
            (60.0, 40.0),
        )?;
        let stage = root.join("runtime.staging");
        reset_stage(&stage)?;
        extract_runtime(&archive, &stage, ticket)?;
        fs::write(stage.join(PACK_MARKER), RUNTIME_HASH).map_err(io_error)?;
        ticket.check()?;
        replace_directory(&stage, &runtime_dir)?;
        let _ = fs::remove_file(archive);
    }
    ticket.check()?;
    shared.progress(ticket, 100.0);
    Ok(())
}

/// Return false for an absent/incomplete pack so unbundled builds can download.
/// Copy only known regular files; publish readiness after all bytes are staged.
fn install_bundled_component(
    source: &Path,
    stage: &Path,
    target: &Path,
    hash: &str,
    files: &[&str],
    ticket: &Ticket,
) -> Result<bool, String> {
    ticket.check()?;
    if !verified(source, hash, files)
        || !files
            .iter()
            .chain(std::iter::once(&PACK_MARKER))
            .all(|name| {
                fs::symlink_metadata(source.join(name)).is_ok_and(|metadata| metadata.is_file())
            })
    {
        return Ok(false);
    }
    reset_stage(stage)?;
    let mut buffer = vec![0_u8; 128 * 1024];
    for name in files {
        ticket.check()?;
        let mut input = File::open(source.join(name)).map_err(io_error)?;
        let mut output = File::create(stage.join(name)).map_err(io_error)?;
        loop {
            ticket.check()?;
            let count = input.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(io_error)?;
        }
    }
    ticket.check()?;
    fs::write(stage.join(PACK_MARKER), hash).map_err(io_error)?;
    replace_directory(stage, target)?;
    Ok(true)
}

fn reset_stage(stage: &Path) -> Result<(), String> {
    if stage.exists() {
        fs::remove_dir_all(stage).map_err(io_error)?;
    }
    fs::create_dir_all(stage).map_err(io_error)
}

fn replace_directory(stage: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(io_error)?;
    }
    fs::rename(stage, target).map_err(io_error)
}

#[derive(Clone, Copy)]
struct DownloadSpec<'a> {
    url: &'a str,
    hash: &'a str,
    max_bytes: u64,
}

fn download(
    client: &reqwest::Client,
    spec: DownloadSpec<'_>,
    path: &Path,
    ticket: &Ticket,
    shared: &Shared,
    range: (f64, f64),
) -> Result<(), String> {
    let result = tauri::async_runtime::block_on(async {
        ticket.check()?;
        let mut response = cancellable_http(client.get(spec.url).send(), ticket)
            .await?
            .error_for_status()
            .map_err(|_| {
                "The speech pack could not download. Check your connection and try again."
                    .to_string()
            })?;
        let total = response
            .content_length()
            .filter(|&size| size > 0 && size <= spec.max_bytes);
        let mut file = File::create(path).map_err(io_error)?;
        let mut digest = Sha256::new();
        let mut count = 0_u64;
        loop {
            ticket.check()?;
            let Some(chunk) = cancellable_http(response.chunk(), ticket).await? else {
                break;
            };
            count += chunk.len() as u64;
            if count > spec.max_bytes {
                return Err("The speech-pack download was larger than expected. Try again.".into());
            }
            digest.update(&chunk);
            file.write_all(&chunk).map_err(io_error)?;
            if let Some(total) = total {
                shared.progress(ticket, range.0 + range.1 * count as f64 / total as f64);
            }
        }
        file.sync_all().map_err(io_error)?;
        if format!("{:x}", digest.finalize()) != spec.hash {
            return Err(
                "The speech pack failed its integrity check. Try the download again.".into(),
            );
        }
        ticket.check()
    });
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

async fn cancellable_http<T>(
    future: impl std::future::Future<Output = Result<T, reqwest::Error>>,
    ticket: &Ticket,
) -> Result<T, String> {
    let request = tokio::time::timeout(Duration::from_secs(20), future);
    tokio::pin!(request);
    loop {
        tokio::select! {
            result = &mut request => return result
                .map_err(|_| "The speech-pack download stalled. Check your connection and try again.".to_string())?
                .map_err(|_| "The speech-pack download stopped. Check your connection and try again.".to_string()),
            () = tokio::time::sleep(Duration::from_millis(100)) => ticket.check()?,
        }
    }
}

fn extract_model(archive: &Path, stage: &Path, ticket: &Ticket) -> Result<(), String> {
    let file = File::open(archive).map_err(io_error)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut extracted = 0_u64;
    for entry in archive.entries().map_err(io_error)? {
        ticket.check()?;
        let mut entry = entry.map_err(io_error)?;
        let path = entry.path().map_err(io_error)?;
        // Never unpack paths supplied by the archive. Only exact known regular
        // components get a freshly constructed output filename; no links/devices.
        let allowed = MODEL_FILES
            .iter()
            .find(|&&name| path == Path::new(MODEL_NAME).join(name));
        if let Some(&name) = allowed {
            if !entry.header().entry_type().is_file() {
                return Err("The speech pack contained an unexpected file.".into());
            }
            extracted += entry.size();
            if extracted > 250_000_000 {
                return Err("The speech pack was larger than expected.".into());
            }
            let mut output = File::create(stage.join(name)).map_err(io_error)?;
            std::io::copy(&mut entry, &mut output).map_err(io_error)?;
        }
    }
    if !MODEL_FILES.iter().all(|name| stage.join(name).is_file()) {
        return Err("The speech pack was incomplete. Try downloading again.".into());
    }
    fs::write(
        stage.join("LICENSE.txt"),
        include_str!("../../docs/licenses/Dictation-LICENSES.txt"),
    )
    .map_err(io_error)
}

fn extract_runtime(archive: &Path, stage: &Path, ticket: &Ticket) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(File::open(archive).map_err(io_error)?).map_err(io_error)?;
    for (inside, outside) in [
        ("lib/onnxruntime.dll", "onnxruntime.dll"),
        (
            "lib/onnxruntime_providers_shared.dll",
            "onnxruntime_providers_shared.dll",
        ),
        ("LICENSE", "LICENSE"),
        ("ThirdPartyNotices.txt", "ThirdPartyNotices.txt"),
    ] {
        ticket.check()?;
        let mut entry = archive
            .by_name(&format!("{RUNTIME_NAME}/{inside}"))
            .map_err(|_| "The speech runtime was incomplete. Try downloading again.".to_string())?;
        if entry.size() > 30_000_000 {
            return Err("The speech runtime was larger than expected.".into());
        }
        let mut output = File::create(stage.join(outside)).map_err(io_error)?;
        std::io::copy(&mut entry, &mut output).map_err(io_error)?;
    }
    Ok(())
}

fn resample(audio: Audio) -> Result<Vec<f32>, String> {
    if audio.rate as usize == RATE {
        return Ok(audio.samples);
    }
    if audio.samples.is_empty() {
        return Ok(Vec::new());
    }
    let length = audio.samples.len() * RATE / audio.rate as usize;
    let mut resampler = FftFixedIn::<f32>::new(audio.rate as usize, RATE, 1024, 2, 1)
        .map_err(|_| "This microphone's sample rate could not be converted.".to_string())?;
    let delay = resampler.output_delay();
    let mut output = Vec::with_capacity(length + delay + resampler.output_frames_max() * 2);
    let mut remaining = audio.samples.as_slice();
    while remaining.len() >= resampler.input_frames_next() {
        let frames = resampler.input_frames_next();
        let chunk = resampler
            .process(&[&remaining[..frames]], None)
            .map_err(|_| "Microphone audio could not be converted.".to_string())?;
        output.extend_from_slice(&chunk[0]);
        remaining = &remaining[frames..];
    }
    if !remaining.is_empty() {
        let chunk = resampler
            .process_partial(Some(&[remaining]), None)
            .map_err(|_| "Microphone audio could not be converted.".to_string())?;
        output.extend_from_slice(&chunk[0]);
    }
    // Flush the FFT filter, including an exact-block recording's tail, then
    // remove only its known algorithmic delay. Do not clip the speaker's words.
    while output.len() < delay + length {
        let chunk = resampler
            .process_partial::<&[f32]>(None, None)
            .map_err(|_| "Microphone audio could not be converted.".to_string())?;
        output.extend_from_slice(&chunk[0]);
    }
    Ok(output[delay..delay + length].to_vec())
}

fn recognize(root: &Path, audio: Audio, ticket: &Ticket) -> Result<String, String> {
    let samples = resample(audio)?;
    ticket.check()?;
    if samples.len() < RATE / 4 || samples.iter().all(|sample| sample.abs() < 0.0005) {
        return Err("No speech was recorded. Check your microphone and try again.".into());
    }
    ort::init_from(root.join(RUNTIME_NAME).join("onnxruntime.dll"))
        .map_err(|_| "The speech runtime could not load. Check that Windows and its Visual C++ runtime are up to date.".to_string())?
        .with_name("pantheon-dictation").with_telemetry(false).commit();
    let threads = std::thread::available_parallelism().map_or(2, |count| count.get().min(4));
    let mut model = StreamingModel::load(&root.join(MODEL_NAME), threads, &Quantization::Int8)
        .map_err(|_| {
            "The speech model could not load. Restart Pantheon and try again.".to_string()
        })?;
    ticket.check()?;
    let mut parts = Vec::new();
    let mut start = 0;
    while start < samples.len() {
        ticket.check()?;
        let end = utterance_end(&samples, start);
        let chunk = &samples[start..end];
        if chunk.iter().any(|sample| sample.abs() >= 0.0005) {
            let text = model
                .transcribe(chunk, &TranscribeOptions::default())
                .map_err(|_| "Speech recognition failed. Try recording again.".to_string())?
                .text;
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
        start = end;
    }
    drop(model); // All five ONNX sessions and their model weights end here.
    ticket.check()?;
    let text = parts.join(" ");
    if text.is_empty() {
        Err("No speech was recognized. Try recording again.".into())
    } else {
        Ok(text)
    }
}

// Bound model context and RAM for two-minute recordings. Prefer a quiet pause
// near the boundary; short dictation takes one full-utterance recognition pass.
fn utterance_end(samples: &[f32], start: usize) -> usize {
    let maximum = (start + 25 * RATE).min(samples.len());
    if maximum == samples.len() {
        return maximum;
    }
    let minimum = start + 15 * RATE;
    let window = RATE / 5;
    let mut best = None;
    for position in (minimum..maximum - window).step_by(window / 2) {
        let energy = samples[position..position + window]
            .iter()
            .map(|sample| sample * sample)
            .sum::<f32>()
            / window as f32;
        if energy < 0.000_064 && best.is_none_or(|(_, previous)| energy < previous) {
            best = Some((position + window / 2, energy));
        }
    }
    best.map_or(maximum, |(position, _)| position)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn bundled_fixture(root: &Path) -> Result<(), String> {
        for (name, hash, files) in [
            (MODEL_NAME, MODEL_HASH, MODEL_BUNDLED_FILES),
            (RUNTIME_NAME, RUNTIME_HASH, RUNTIME_FILES),
        ] {
            let directory = root.join(name);
            fs::create_dir_all(&directory).map_err(io_error)?;
            for file in files {
                fs::write(directory.join(file), format!("bundled {file}")).map_err(io_error)?;
            }
            fs::write(directory.join(PACK_MARKER), hash).map_err(io_error)?;
        }
        Ok(())
    }

    #[test]
    fn bundled_pack_provisions_offline_and_preserves_notices() -> Result<(), String> {
        let folder = tempfile::tempdir().map_err(io_error)?;
        let bundled = folder.path().join("installed");
        let root = folder.path().join("cache");
        bundled_fixture(&bundled)?;
        // A previous incomplete/cancelled cache is safely replaced.
        fs::create_dir_all(root.join(MODEL_NAME)).map_err(io_error)?;
        fs::write(root.join(MODEL_NAME).join("frontend.ort"), "old").map_err(io_error)?;
        let shared = Shared::default();
        let ticket = shared.begin("bundled".into())?;
        prepare_pack(&root, Some(&bundled), &ticket, &shared)?;
        assert!(verified(&root.join(MODEL_NAME), MODEL_HASH, MODEL_FILES));
        assert!(verified(
            &root.join(RUNTIME_NAME),
            RUNTIME_HASH,
            RUNTIME_FILES
        ));
        for (name, files) in [
            (MODEL_NAME, MODEL_BUNDLED_FILES),
            (RUNTIME_NAME, RUNTIME_FILES),
        ] {
            for file in files {
                assert_eq!(
                    fs::read(root.join(name).join(file)).map_err(io_error)?,
                    fs::read(bundled.join(name).join(file)).map_err(io_error)?
                );
            }
        }
        assert!(!root.join("model.download").exists());
        assert!(!root.join("runtime.download").exists());
        assert!(!root.join("model.staging").exists());
        assert!(!root.join("runtime.staging").exists());
        assert_eq!(lock(&shared.inner).status.progress, Some(1.0));
        // A ready cache also works without either bundle or network.
        prepare_pack(&root, None, &ticket, &shared)?;
        Ok(())
    }

    #[test]
    fn incomplete_bundled_components_allow_download_fallback_without_installing(
    ) -> Result<(), String> {
        let folder = tempfile::tempdir().map_err(io_error)?;
        let bundled = folder.path().join("installed");
        bundled_fixture(&bundled)?;
        let source = bundled.join(MODEL_NAME);
        let stage = folder.path().join("stage");
        let target = folder.path().join("target");
        let shared = Shared::default();
        let ticket = shared.begin("fallback".into())?;
        for marker in [None, Some("incorrect digest"), Some(MODEL_HASH)] {
            if let Some(marker) = marker {
                fs::write(source.join(PACK_MARKER), marker).map_err(io_error)?;
            } else {
                fs::remove_file(source.join(PACK_MARKER)).map_err(io_error)?;
            }
            if marker == Some(MODEL_HASH) {
                fs::remove_file(source.join("encoder.ort")).map_err(io_error)?;
            }
            assert!(!install_bundled_component(
                &source,
                &stage,
                &target,
                MODEL_HASH,
                MODEL_BUNDLED_FILES,
                &ticket
            )?);
            assert!(!target.exists());
            assert!(!stage.exists());
        }
        Ok(())
    }

    #[test]
    fn cancelled_bundled_provisioning_cannot_publish_readiness() -> Result<(), String> {
        let folder = tempfile::tempdir().map_err(io_error)?;
        let bundled = folder.path().join("installed");
        bundled_fixture(&bundled)?;
        let shared = Shared::default();
        let ticket = shared.begin("cancelled bundle".into())?;
        ticket.cancelled.store(true, Ordering::Release);
        let target = folder.path().join("target");
        let result = install_bundled_component(
            &bundled.join(MODEL_NAME),
            &folder.path().join("stage"),
            &target,
            MODEL_HASH,
            MODEL_BUNDLED_FILES,
            &ticket,
        );
        assert_eq!(result.as_ref().err().map(String::as_str), Some(CANCELLED));
        assert!(!target.join(PACK_MARKER).exists());
        Ok(())
    }

    #[test]
    fn stalled_network_operation_is_cancelled_promptly() -> Result<(), String> {
        let shared = Shared::default();
        let ticket = shared.begin("network".into())?;
        let cancel = ticket.cancelled.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel.store(true, Ordering::Release);
        });
        let start = Instant::now();
        let result = tauri::async_runtime::block_on(cancellable_http(
            std::future::pending::<Result<(), reqwest::Error>>(),
            &ticket,
        ));
        worker
            .join()
            .map_err(|_| "Cancellation worker failed".to_string())?;
        assert_eq!(result.as_ref().err().map(String::as_str), Some(CANCELLED));
        assert!(start.elapsed() < Duration::from_secs(1));
        Ok(())
    }

    #[test]
    fn model_extraction_rejects_links_without_writing_outside_stage() -> Result<(), String> {
        let folder = tempfile::tempdir().map_err(io_error)?;
        let archive_path = folder.path().join("test.tar.gz");
        let writer = flate2::write::GzEncoder::new(
            File::create(&archive_path).map_err(io_error)?,
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(writer);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_link(
                &mut header,
                format!("{MODEL_NAME}/frontend.ort"),
                "../outside.ort",
            )
            .map_err(io_error)?;
        builder
            .into_inner()
            .map_err(io_error)?
            .finish()
            .map_err(io_error)?;
        let stage = folder.path().join("stage");
        fs::create_dir(&stage).map_err(io_error)?;
        let shared = Shared::default();
        let ticket = shared.begin("archive".into())?;
        assert!(extract_model(&archive_path, &stage, &ticket).is_err());
        assert!(!folder.path().join("outside.ort").exists());
        assert!(!stage.join("frontend.ort").exists());
        Ok(())
    }

    #[test]
    fn wire_progress_is_a_fraction_and_ignores_old_workers() -> Result<(), String> {
        let state = DictationState::default();
        let old = state.shared.begin("old".into())?;
        state.shared.progress(&old, 60.0);
        assert_eq!(lock(&state.shared.inner).status.progress, Some(0.6));
        let json = serde_json::to_value(lock(&state.shared.inner).status.clone())
            .map_err(|error| error.to_string())?;
        assert_eq!(
            json,
            serde_json::json!({ "id": "old", "phase": "preparing", "ready": false, "progress": 0.6, "error": null, "waveform": [] })
        );
        state.cancel("old");
        let new = state.shared.begin("new".into())?;
        state.shared.progress(&new, 125.0);
        state.shared.progress(&old, 0.0);
        assert_eq!(lock(&state.shared.inner).status.progress, Some(1.0));
        Ok(())
    }

    #[test]
    fn stale_cancellation_and_worker_errors_cannot_affect_a_new_run() -> Result<(), String> {
        let state = DictationState::default();
        let old = state.shared.begin("old".into())?;
        state.cancel("old");
        let new = state.shared.begin("new".into())?;
        state.cancel("old");
        state.shared.error(&old, "old download failed".into());
        let inner = lock(&state.shared.inner);
        assert!(owns(&inner, &new));
        assert_eq!(inner.status.id.as_deref(), Some("new"));
        assert!(inner.status.error.is_none());
        assert!(old.check().is_err());
        Ok(())
    }

    #[test]
    fn recording_error_retains_ownership_and_allows_retry() -> Result<(), String> {
        let shared = Shared::default();
        let ticket = shared.begin("first".into())?;
        shared.error(&ticket, LIMIT_ERROR.into());
        assert_eq!(lock(&shared.inner).status.id.as_deref(), Some("first"));
        assert!(ticket.check().is_err());
        assert!(shared.begin("retry".into()).is_ok());
        Ok(())
    }

    #[test]
    fn mono_downmix_converts_unsigned_samples_and_bounds_memory() {
        let mut buffer = CaptureBuffer::default();
        append_mono(&mut buffer, &[0_u16, u16::MAX, 32768, 32768, 1, 1], 2, 2);
        assert_eq!(buffer.samples.len(), 2);
        assert!(buffer.full);
        assert!(buffer.samples.iter().all(|sample| sample.abs() < 0.0001));
    }

    #[test]
    fn waveform_uses_real_mono_volume_and_stable_sample_windows() {
        let mut buffer = CaptureBuffer {
            envelope: VolumeEnvelope::new(8_000),
            ..CaptureBuffer::default()
        };
        // A 75 ms bin spans callbacks; silence never displays invented activity.
        assert_eq!(buffer.envelope.window_samples, 600);
        append_mono(&mut buffer, &[0.0_f32; 399], 1, 10_000);
        assert_eq!(buffer.envelope.levels().count(), 0);
        append_mono(&mut buffer, &[0.0_f32; 201], 1, 10_000);
        append_mono(&mut buffer, &[0.01_f32; 600], 1, 10_000);
        append_mono(&mut buffer, &[0.1_f32; 600], 1, 10_000);
        append_mono(&mut buffer, &[1.0_f32; 600], 1, 10_000);
        append_mono(&mut buffer, &[f32::NAN; 600], 1, 10_000);
        let levels = buffer.envelope.levels().collect::<Vec<_>>();
        assert_eq!(levels.len(), 5);
        assert_eq!(levels[0], 0.0);
        assert!(levels[1] > 0.0 && levels[1] < levels[2]);
        assert!(levels[2] < levels[3]);
        assert_eq!(levels[3], 1.0);
        assert_eq!(levels[4], 0.0);
        assert!(levels
            .iter()
            .all(|level| level.is_finite() && (0.0..=1.0).contains(level)));
    }

    #[test]
    fn waveform_history_is_bounded_and_ordered_oldest_first() {
        let mut envelope = VolumeEnvelope::new(8_000);
        for bin in 0..WAVEFORM_BINS + 7 {
            // Strictly increasing volumes identify ring wrap/order mistakes.
            let mono = (bin + 1) as f32 / 200.0;
            for _ in 0..600 {
                envelope.observe(mono);
            }
        }
        let levels = envelope.levels().collect::<Vec<_>>();
        assert_eq!(levels.len(), WAVEFORM_BINS);
        assert!(levels.windows(2).all(|pair| pair[0] < pair[1]));
        let expected_oldest = ((20.0 * 0.04_f64.log10() + 60.0) / 60.0) as f32;
        assert!((levels[0] - expected_oldest).abs() < 0.0001);
    }

    #[test]
    fn waveform_clears_on_exit_and_stale_capture_cannot_publish() -> Result<(), String> {
        let state = DictationState::default();
        let old = state.shared.begin("same-id".into())?;
        let mut envelope = VolumeEnvelope::new(20);
        envelope.observe(0.1);
        state.shared.waveform(&old, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform, [] as [f32; 0]);
        lock(&state.shared.inner).status.set_phase(Phase::Recording);
        state.shared.waveform(&old, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform.len(), 1);

        lock(&state.shared.inner)
            .status
            .set_phase(Phase::Transcribing);
        state.shared.waveform(&old, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform, [] as [f32; 0]);
        state.cancel("same-id");
        let new = state.shared.begin("same-id".into())?;
        lock(&state.shared.inner).status.set_phase(Phase::Recording);
        state.shared.waveform(&old, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform, [] as [f32; 0]);
        state.shared.waveform(&new, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform.len(), 1);
        state.shared.error(&new, "microphone disconnected".into());
        state.shared.waveform(&new, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform, [] as [f32; 0]);
        let retry = state.shared.begin("retry".into())?;
        assert_eq!(lock(&state.shared.inner).status.waveform, [] as [f32; 0]);
        lock(&state.shared.inner).status.set_phase(Phase::Recording);
        state.shared.waveform(&retry, &envelope);
        state.cancel("retry");
        state.shared.waveform(&retry, &envelope);
        assert_eq!(lock(&state.shared.inner).status.waveform, [] as [f32; 0]);
        Ok(())
    }

    #[test]
    fn resampling_preserves_duration_and_recording_tail() -> Result<(), String> {
        for rate in [8_000, 44_100, 48_000, 96_000] {
            let count = rate as usize + 123;
            let mut samples = vec![0.0; count];
            // A tone at the end catches missing filter flush or wrong delay trim.
            for (index, sample) in samples.iter_mut().enumerate().skip(count - 1000) {
                *sample = (index as f32 * 0.05).sin() * 0.3;
            }
            let output = resample(Audio { samples, rate })?;
            assert_eq!(output.len(), count * RATE / rate as usize);
            assert!(output[output.len() - 100..]
                .iter()
                .any(|sample| sample.abs() > 0.01));
        }
        Ok(())
    }

    #[test]
    fn long_audio_splits_at_quiet_pause_and_always_advances() {
        let mut samples = vec![0.1; 60 * RATE];
        samples[20 * RATE..21 * RATE].fill(0.0);
        let first = utterance_end(&samples, 0);
        assert!((20 * RATE..21 * RATE).contains(&first));
        let second = utterance_end(&samples, first);
        assert!(second > first && second - first <= 25 * RATE);
        assert_eq!(utterance_end(&samples, second), samples.len());
    }

    /// Explicit public-fixture smoke test; never opens the user's microphone.
    /// Set `PANTHEON_DICTATION_SMOKE_ROOT` to an ignored fixture/cache directory.
    #[test]
    #[ignore = "downloads the speech pack and recognizes a public fixture"]
    fn public_fixture_recognition() -> Result<(), String> {
        let root = PathBuf::from(
            std::env::var_os("PANTHEON_DICTATION_SMOKE_ROOT")
                .ok_or("Set PANTHEON_DICTATION_SMOKE_ROOT")?,
        );
        let shared = Shared::default();
        let ticket = shared.begin("fixture".into())?;
        let bundled = std::env::var_os("PANTHEON_DICTATION_BUNDLED_ROOT").map(PathBuf::from);
        prepare_pack(&root, bundled.as_deref(), &ticket, &shared)?;
        let mut reader = hound::WavReader::open(root.join("dots.wav")).map_err(io_error)?;
        let rate = reader.spec().sample_rate;
        let samples = reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| f32::from(value) / 32768.0))
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        let seconds = samples.len() as f64 / f64::from(rate);
        let started = Instant::now();
        let text = recognize(&root, Audio { samples, rate }, &ticket)?;
        println!(
            "Public fixture: {seconds:.2}s audio; cold load + recognition {:.2}s",
            started.elapsed().as_secs_f64()
        );
        println!("Public fixture transcript: {text}");
        assert!(
            text.to_lowercase().contains("dots"),
            "Unexpected public-fixture transcript: {text}"
        );
        Ok(())
    }
}
