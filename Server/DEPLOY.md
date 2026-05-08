# GamePing Cloud Deploy

This server can run as a small HTTPS web app. The browser version is served from `/`, and the API is served from the same origin.

## Render

1. Push this folder to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Use `GamePing/Server` as the root directory if Render asks.
4. Build command:

```sh
npm run check
```

5. Start command:

```sh
npm run start:prod
```

6. Add a persistent disk mounted at `/var/data`.
7. Set environment variables:

```sh
NODE_ENV=production
HOST=0.0.0.0
GAMEPING_DATA_DIR=/var/data
GAMEPING_API_TOKEN=<long-random-token>
VAPID_PUBLIC_KEY=<web-push-public-key>
VAPID_PRIVATE_KEY=<web-push-private-key>
VAPID_SUBJECT=mailto:you@example.com
```

Keep `GAMEPING_API_TOKEN` somewhere safe. You need the same value in the first shared link.
Render also sets `RENDER_EXTERNAL_URL`; the server uses that as its public URL automatically.

Share the first invite link like this:

```text
https://your-gameping-url.onrender.com/?token=<long-random-token>
```

The web app stores the token locally and removes it from the visible URL after opening.

## Render API

After the code is in a GitHub repo, the service can be created with the Render API:

```sh
RENDER_API_KEY=rnd_... \
GITHUB_REPO_URL=https://github.com/your-name/gameping \
npm run deploy:render
```

By default this creates a free web service for first cloud testing. For persistent storage, use:

```sh
RENDER_PLAN=starter \
RENDER_API_KEY=rnd_... \
GITHUB_REPO_URL=https://github.com/your-name/gameping \
npm run deploy:render
```

## Docker

```sh
docker build -t gameping .
docker run --rm -p 8787:8787 \
  -e GAMEPING_API_TOKEN=choose-a-long-random-token \
  -e PUBLIC_URL=http://localhost:8787 \
  -v gameping-data:/data \
  gameping
```

## App Store Path

For the native iPhone app, Apple Developer Program membership is required. It is 99 USD per year, and App Store distribution requires App Review. APNs locked-screen/background push also requires the Push Notifications capability and APNs key configuration.
