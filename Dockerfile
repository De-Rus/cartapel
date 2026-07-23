FROM node:22-bookworm-slim AS ui
WORKDIR /ui
RUN corepack enable
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY ui/ ./
RUN pnpm build

FROM rust:1.95-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY --from=ui /ui/dist ./ui/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/steward /usr/local/bin/steward
COPY demo /demo
ENV STEWARD_LISTEN=0.0.0.0:8686 \
    STEWARD_DATA=/data
EXPOSE 8686
VOLUME ["/data"]
ENTRYPOINT ["steward"]
CMD ["serve"]
