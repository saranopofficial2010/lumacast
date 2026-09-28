# LumaCast

LumaCast is a browser-based streaming studio. The browser captures a selected screen or window, sends WebM chunks to the Node.js relay, and FFmpeg encodes the stream for YouTube RTMP(S).

## Requirements

- Node.js 18 or later
- FFmpeg available on the server (`ffmpeg` on `PATH`, or an absolute executable path in `FFMPEG_PATH`)
- HTTPS in production; browsers only allow screen capture from secure contexts (localhost is allowed for local development)
- A YouTube Live stream URL and stream key

## Configure and run

1. Copy `.env.example` to `.env` on the server.
2. Set `RTMP_TARGET` to the full YouTube RTMPS URL, including the stream key. Keep `.env` private and do not commit it.
3. Set `FFMPEG_PATH` if FFmpeg is not available on `PATH`.
4. Install Node.js and FFmpeg on the server, then run `npm start` from this folder.
5. Put the site behind an HTTPS reverse proxy that forwards WebSocket upgrades for `/relay` to the Node server. Open the HTTPS site and allow screen sharing in the browser.
6. In YouTube Studio, confirm the stream key matches `RTMP_TARGET`. With scheduled streams, wait for the encoder preview and click **Go live** in Studio unless the broadcast is configured to auto-start.

The default port is `4173`. `/api/health` reports whether the relay can find FFmpeg. A healthy response includes `ok: true`.

## Stream destination

For a single trusted deployment, configure the stream key on the server with `RTMP_TARGET`. The server-side destination takes precedence over custom ingest values entered in the browser. YouTube RTMP(S) hosts are allowed by default. To permit another ingest provider, add its exact hostname or a `*.domain.example` rule to `RTMP_ALLOWED_HOSTS`.

## Important deployment limits

This is a single-user prototype, not a hardened public service. The demo sign-in screen does not provide server-side authentication. Before making the site publicly accessible, add real authentication and authorization, TLS/WSS, rate limits, per-user stream isolation, and protections for the stream key. Do not expose an unauthenticated relay with a YouTube stream key configured. Keep `.env` out of source control and backups that are accessible to the public.

The browser page must remain open while streaming. Mobile browsers and operating systems may pause screen capture in the background or when the device is locked.

## Orientation

Portrait outputs 1080×1920 (9:16). Landscape and Auto output 1920×1080 (16:9). FFmpeg scales and center-crops the input to fill the selected output ratio.
