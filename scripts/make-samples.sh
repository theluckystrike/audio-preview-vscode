#!/bin/zsh
# Makes the small, speech-free sample files used by the tests and screenshots.
# Needs ffmpeg on PATH (dev only, never shipped). Usage: zsh scripts/make-samples.sh test/fixtures
set -e
OUT=${1:-test/fixtures}; mkdir -p $OUT
F=(ffmpeg -hide_banner -loglevel error -y)
TAGS=(-metadata title="Sine Sweep" -metadata artist="Zovo Test Signals" -metadata album="Fixtures" -metadata date=2026 -metadata genre="Test" -metadata comment="20 Hz to 20 kHz <b>&amp;</b>")
# 4 s log sweep 20 Hz -> 20 kHz on the left, pink noise on the right, 44.1 kHz 16-bit
SWEEP='0.5*sin(2*PI*20*4/log(1000)*(exp(t/4*log(1000))-1))'
$F -f lavfi -i "aevalsrc=${SWEEP}:s=44100:d=4" -f lavfi -i "anoisesrc=d=4:c=pink:r=44100:a=0.25:seed=7" \
  -filter_complex "[0][1]join=inputs=2:channel_layout=stereo" -c:a pcm_s16le $TAGS $OUT/sweep-44k-s16.wav
# 1 kHz at -20 dBFS (amplitude 0.1) in both channels, 48 kHz 24-bit: integrated loudness is -20.0 LUFS
$F -f lavfi -i "aevalsrc=0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t):s=48000:d=3" -c:a pcm_s24le $OUT/tone-1k-48k-s24.wav
# 32-bit float mono white noise with a full-scale click (peak 0 dBFS)
$F -f lavfi -i "aevalsrc=if(between(t\,1\,1.0001)\,1\,0.05*(random(0)*2-1)):s=22050:d=2" -c:a pcm_f32le $OUT/noise-22k-f32.wav
# 8-bit unsigned mono 8 kHz
$F -f lavfi -i "aevalsrc=0.5*sin(2*PI*440*t):s=8000:d=1" -c:a pcm_u8 $OUT/tone-8k-u8.wav
# A short synth loop (chords + hats from noise), used for the encoded formats and screenshots
MUSIC="0.18*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t))*(1-mod(t\,0.5)*1.6)*gte(1-mod(t\,0.5)*1.6\,0)*lt(mod(t\,4)\,2)+0.18*(sin(2*PI*196*t)+sin(2*PI*246.94*t)+sin(2*PI*293.66*t))*(1-mod(t\,0.5)*1.6)*gte(1-mod(t\,0.5)*1.6\,0)*gte(mod(t\,4)\,2)+0.5*sin(2*PI*55*t)*exp(-mod(t\,1)*8)"
$F -f lavfi -i "aevalsrc=${MUSIC}|${MUSIC}:s=44100:d=8" -f lavfi -i "anoisesrc=d=8:c=white:r=44100:a=0.3:seed=3" \
  -filter_complex "[1]highpass=f=6000,volume='exp(-mod(t,0.25)*30)':eval=frame,asplit[h1][h2];[h1][h2]join=inputs=2:channel_layout=stereo[h];[0][h]amix=inputs=2:normalize=0[m]" -map "[m]" -c:a pcm_s16le $OUT/.music.wav
MT=(-metadata title="Night Loop" -metadata artist="Zovo Test Signals" -metadata album="Fixtures" -metadata date=2026 -metadata genre="Electronic" -metadata track=3)
$F -i $OUT/.music.wav -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 $MT $OUT/night-loop.flac
$F -i $OUT/.music.wav -c:a libmp3lame -b:a 128k $MT -id3v2_version 3 $OUT/night-loop.mp3
$F -i $OUT/.music.wav -c:a libopus -b:a 64k $MT $OUT/night-loop.opus
$F -i $OUT/.music.wav -c:a vorbis -strict -2 -ac 2 $MT $OUT/night-loop.ogg
$F -i $OUT/.music.wav -c:a aac -b:a 128k $MT $OUT/night-loop.m4a
$F -i $OUT/.music.wav -c:a aac -b:a 96k -f adts $OUT/night-loop.aac
$F -i $OUT/sweep-44k-s16.wav -c:a libmp3lame -b:a 160k $TAGS -id3v2_version 4 $OUT/sweep.mp3
rm -f $OUT/.music.wav
# Broken files
head -c 30 $OUT/sweep-44k-s16.wav > $OUT/broken-header.wav
head -c 12 $OUT/night-loop.flac > $OUT/broken.flac
# Reference loudness from ffmpeg ebur128 for the tests
for f in sweep-44k-s16.wav tone-1k-48k-s24.wav night-loop.flac; do
  I=$(ffmpeg -hide_banner -nostats -i $OUT/$f -af ebur128 -f null - 2>&1 | awk '/Integrated loudness:/{f=1} f&&/I:/{print $2; exit}')
  echo "$f $I"
done > $OUT/ebur128.txt
ls -la $OUT; cat $OUT/ebur128.txt
