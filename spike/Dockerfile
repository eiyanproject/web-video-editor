# Throwaway spike image: ffmpeg only, for validating the smart-cut algorithm.
# Reuses debian:bookworm-slim which is already in the local image cache.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
ENTRYPOINT ["/bin/bash"]
