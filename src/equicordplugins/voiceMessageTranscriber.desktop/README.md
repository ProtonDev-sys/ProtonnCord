# VoiceMessageTranscriber — Phonon-2

English voice-message recognition uses only `FermionResearch/Phonon-2`, locally through Fermion Research's native runtime. There is no Whisper fallback, selectable speech model, remote transcription endpoint, or renderer-loaded inference code. Existing plugin identity and preferences remain intact; saved Whisper model/language/quantization fields are hidden and unused.

## Automatic first-use setup

Users do not need to install Python, configure PATH, or download a model manually. Press Transcribe: the plugin automatically installs a private managed Python 3.12 environment, `fermion-research==0.2.4`, speech dependencies, and Phonon-2. First setup needs internet access, disk space, and several minutes. Dependency downloads and installed size are larger than the model archive alone.

Setup lives under the client's data directory in `VoiceMessageTranscriber/fermion-0.2.4-python312-v1/`. The plugin does not modify the system Python, install global packages, require a local HTTP service, or use a user's existing `fermion` executable. Linux and Windows use CPU-only `torch==2.8.0`; Apple silicon uses the MLX speech engine.

The bootstrap executable is uv 0.12.21, fetched from Astral's official GitHub release and verified against a pinned SHA-256 before extraction or execution. Only the expected regular executable is extracted; archive paths never become output paths. Runtime installation is shared across requests in this process. A ready marker is published atomically only after dependency installation and the explicit `phonon-2 --download-only` command succeed. Interrupted installs remain retryable. Installed runtime and model caches are reused on subsequent launches.

Cancel aborts active setup or transcription; closing the renderer also cancels its active job. Cancelling shared first-use setup can also interrupt other requests waiting for that installation; retry starts setup again. Network/download timeouts, subprocess timeouts, and output limits bound the work. No transcript or runtime stderr is logged.

## Audio and existing features

Decoded audio is converted to 16 kHz mono PCM WAV in a temporary directory and removed after completion, cancellation, or failure. Each renderer permits one active job, bounded to ten minutes of input and a ten-minute transcription subprocess timeout. Simultaneous automatic jobs show a retryable busy error rather than launching competing model instances.

The model loads once per recording. A private adapter to the pinned runtime publishes genuine decoder previews at word boundaries, not an animation of completed text. CPU decoding uses the Torch TDT loop to expose emitted tokens (the packed encoder remains enabled); Apple silicon publishes tokens from MLX's batched decoder. The CPU decoder can be slower than the non-streaming C loop. Encoding and first-use setup still finish before words can appear. Fast recordings may complete between preview refreshes. The final result replaces the preview and retains segment timestamps; translation starts only after recognition finishes and still sends text to the selected Translate-plugin provider.

Hide keeps the transcript and latest translation available for Show transcript, without rerunning recognition or translation. Selecting the already-cached target language also reuses its translation. Results expire after five minutes without a visible viewer: hiding the result, scrolling it offscreen, hiding the document, or unmounting the message starts the inactivity window. Expiry also clears hidden mounted component state. Visible results remain available; there is one shared expiry timer, a 100-entry limit, and a one-million-character aggregate text bound. Plugin stop and connection changes clear results immediately.

Audio preparation only coalesces up to three in-flight downloads/decodes; completed PCM arrays and audio blobs are not retained in the preparation cache. Transcription reuses decoded samples without an extra renderer-side copy, and timestamp formatting runs only while timestamps are shown. Preview refreshes use one outstanding renderer-scoped request at a time, at most every 100 ms; cancellation, unmount, stop and completion dispose timers and discard partial text. Partial results are never cached as completed transcripts.

The settings button deletes legacy Whisper browser downloads; it does not delete the new managed runtime or model cache.

## Platform and model limitations

Phonon-2 is English-only. Automatic setup supports Windows x86-64, glibc Linux x86-64/Arm64, and Apple silicon Macs. Windows Arm and Intel Macs are not supported by this integration. Older CPUs, missing OS libraries, and insufficient disk space can still prevent inference; unsupported hosts fail rather than silently selecting another model. The plugin does not run administrator-level OS package installation.

A small weight archive does not establish total runtime RAM, dependency size, or speed on every device. This is a desktop native plugin, not a browser or Android implementation.

Upstream model card: https://huggingface.co/FermionResearch/Phonon-2

Runtime documentation: https://github.com/fermionresearch/phonon

Bootstrap runtime: https://github.com/astral-sh/uv/releases/tag/0.12.21

Phonon-2 weights are CC-BY-4.0, derived from NVIDIA's `parakeet-tdt-0.6b-v3`; upstream's model repository includes its NOTICE. The runtime is Apache-2.0. Weights are not bundled in the client.
