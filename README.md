# GamePing

GamePing is a SwiftUI iPhone MVP for one-tap game party pings.

## Local Mock API

Start the mock API before testing server delivery in the iOS Simulator:

```sh
cd Server
npm start
```

For a real iPhone on the same Wi-Fi as your Mac, start the server on your LAN:

```sh
cd Server
npm run start:lan
```

The server prints reachable URLs. Put the Mac LAN URL, for example `http://192.168.0.12:8787`, into the app's profile screen.

## No-Signing iPhone Test

If Xcode asks for a development team, use the browser version first. Start the LAN server:

```sh
cd Server
npm run start:lan
```

Open the printed LAN URL, for example `http://192.168.0.12:8787`, in iPhone Safari. This runs the same one-tap calling flow without installing a signed native app. Keep the page open for received-call polling, sound, and vibration.

## Live HTTPS App

For friends outside the same Wi-Fi, use the Cloudflare Workers deployment:

```text
https://gameping.ethan1100110000.workers.dev
```

Open this link on each phone, add it to the iPhone Home Screen, then tap `알림 켜기`. The current Cloudflare deployment does not require an API token.

Deployment notes are in [Server/DEPLOY.md](/Users/seung-yoon/Documents/Codex/2026-05-08/new-chat/GamePing/Server/DEPLOY.md).

The app posts ping requests to the configured server URL. If the server is unavailable, the app still records the ping and shows a local notification preview.

The web app uses Web Push when VAPID keys are configured and falls back to inbox polling while open. APNs is still the native-app path for locked-screen/background delivery.

Useful endpoints:

- `GET /health`
- `GET /pings`
- `POST /pings`
- `GET /inbox/:userID`
- `GET /push/public-key`
- `GET /devices`
- `POST /devices`
- `GET /invites/:inviteCode`

`POST /devices` is the APNs handoff point. The app registers its profile automatically as `{ "userID", "userName", "inviteCode", "pushToken" }`. On Simulator it uses a `SIMULATOR-*` token so invite-code lookup can still be tested without Apple push credentials.

Friend lookup:

```sh
curl https://gameping.ethan1100110000.workers.dev/invites/GP-ABC123
```

APNs environment variables:

The checked-in Xcode target keeps APNs entitlements disabled so the app can install on a real iPhone with a normal Apple Development signing profile and use the in-app inbox polling fallback. When you are ready for locked-screen/background push, add the Push Notifications capability back in Xcode so `GamePing.entitlements` is used, then configure the server with:

```sh
export APNS_TEAM_ID=...
export APNS_KEY_ID=...
export APNS_BUNDLE_ID=com.your.bundle.id
export APNS_PRIVATE_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
export APNS_ENV=sandbox
```

Optional API token protection:

```sh
export GAMEPING_API_TOKEN=choose-a-long-random-token
npm run start:lan
```

Then put the same token into the app's profile screen.

## Build

```sh
xcodebuild -project GamePing.xcodeproj -scheme GamePing -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData build
```
