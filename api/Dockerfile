# Production image. Multi-stage so the runtime carries no Rust toolchain.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
# cifs-utils -> mount.cifs for SMB shares configured in the UI
# ffmpeg     -> probing and export, from Phase 1 onward
RUN apt-get update \
 && apt-get install -y --no-install-recommends cifs-utils ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/veditor-api /usr/local/bin/veditor-api

ENV VEDITOR_CONFIG=/config/settings.json \
    VEDITOR_BIND=0.0.0.0:8080
EXPOSE 8080
CMD ["veditor-api"]
