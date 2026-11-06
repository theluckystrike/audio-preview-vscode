# Changelog

## 0.1.2 (2026-11-06)

- A small line under the player has two links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `audioPreview.showSupportLinks` (default `true`) hides it, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "Audio Preview: Support the developer" and "Audio Preview: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.1 (2026-11-06)

- Audio Preview asks one time for a Marketplace rating. It counts each success (an opened audio file). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `audioPreview.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

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
