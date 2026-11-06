# Limits and the ffmpeg fallback

- `audioPreview.maxWavMB` (2048): WAV files up to this size are read in 2 MB chunks for the waveform and loudness. Bigger files still play.
- `audioPreview.maxDecodedMB` (600): MP3, FLAC, Ogg, Opus and M4A are decoded whole. Above this size of decoded samples, the file only plays.
- `audioPreview.maxRemoteFileMB` (512): files in remote or virtual workspaces are read whole.
- `audioPreview.ffmpegPath` (ffmpeg): VS Code has no AAC decoder. If ffmpeg is on your machine, a **Decode with ffmpeg** button appears on M4A and AAC files. The extension never downloads or bundles ffmpeg.
