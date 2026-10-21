#!/bin/sh
# Run from the runtime sources directory on Apple Silicon with Xcode command-line tools.
# No third-party libraries or Homebrew are needed; source remains unmodified.
set -eu
cd "$(dirname "$0")"
tar -xf ffmpeg-8.0.1.tar.xz
cd ffmpeg-8.0.1
# These arguments mirror ffmpeg-configure.json. Node is not needed to rebuild.
MACOSX_DEPLOYMENT_TARGET=14.0 PATH=/usr/bin:/bin sh configure \
 --arch=arm64 --cc=/usr/bin/clang --disable-autodetect --disable-network \
 --disable-doc --disable-debug --disable-shared --enable-static \
 --disable-gpl --disable-nonfree --disable-version3 --disable-ffplay --disable-avdevice \
 --disable-everything --enable-ffmpeg --enable-ffprobe --enable-protocol=file,pipe \
 --enable-demuxer=aac,aiff,asf,avi,caf,flac,matroska,mov,mp3,mpegps,mpegts,ogg,wav \
 --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis \
 --enable-decoder=aac,aac_latm,ac3,adpcm_ima_qt,adpcm_ima_wav,alac,flac,mp3,mp3float,opus,pcm_alaw,pcm_f32le,pcm_f64le,pcm_mulaw,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,vorbis,wmav1,wmav2 \
 --enable-encoder=pcm_s16le --enable-muxer=wav,null --enable-filter=aresample,aformat,anull,atrim,asetpts
PATH=/usr/bin:/bin make -j4 ffmpeg ffprobe
