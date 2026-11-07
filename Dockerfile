FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.96-bookworm AS backend
WORKDIR /app
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --uid 10001 --create-home app && mkdir -p /data && chown app:app /data
WORKDIR /app
COPY --from=frontend /app/frontend/dist ./frontend/dist
COPY --from=backend /app/target/release/form-lab-server /usr/local/bin/form-lab-server
USER app
ENV FORM_LAB_BIND=0.0.0.0:3000 FORM_LAB_DATABASE=/data/form-lab.sqlite3 FORM_LAB_ASSETS=/app/frontend/dist
EXPOSE 3000
CMD ["form-lab-server"]
