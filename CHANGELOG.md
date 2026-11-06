# Changelog

## 0.1.0 (2026-11-06)

First release.

- Read-only audio editor for `.wav`, `.wave`, `.mp3`, `.flac`, `.ogg`, `.oga`, `.opus`, `.m4a` and `.aac`.
- Waveform per channel and a log-frequency spectrogram, with seek, hover time and a drag-to-set loop region.
- Play and pause, speed from 0.25x to 2x with the pitch kept, volume, A-B loop and keyboard shortcuts.
- Loudness panel with integrated, short-term max and momentary max LUFS (ITU-R BS.1770-4), sample peak, RMS, DC offset and clipped samples. Copy stats puts them on the clipboard.
- Header and tag readers for RIFF/RF64 WAV, MP3 (ID3v1, ID3v2.2 to 2.4, Xing, LAME gapless), FLAC, Ogg Vorbis, Ogg Opus, MP4/M4A and ADTS AAC.
- WAV files are streamed in 2 MB chunks. Compressed files over the decode limit still play and show a message.
- Opus decoding through bundled libopus (WebAssembly), because VS Code's Chromium has none.
- AAC and M4A files show their details and a message. A one-click ffmpeg fallback appears when your own ffmpeg is installed.
