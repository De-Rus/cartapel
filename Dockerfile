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
COPY --from=build /app/target/release/cartapel /usr/local/bin/cartapel
COPY demo /demo
ENV CARTAPEL_LISTEN=0.0.0.0:8686 \
    CARTAPEL_DATA=/data
EXPOSE 8686
VOLUME ["/data"]
ENTRYPOINT ["cartapel"]
CMD ["serve"]
