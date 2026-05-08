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

## Cloud HTTPS Test

For friends outside the same Wi-Fi, deploy `Server` to a cloud host with HTTPS. The server is ready for Render or Docker:

- [Server/DEPLOY.md](/Users/seung-yoon/Documents/Codex/2026-05-08/new-chat/GamePing/Server/DEPLOY.md)
- [render.yaml](/Users/seung-yoon/Documents/Codex/2026-05-08/new-chat/GamePing/render.yaml)
- [Server/Dockerfile](/Users/seung-yoon/Documents/Codex/2026-05-08/new-chat/GamePing/Server/Dockerfile)

Use a long `GAMEPING_API_TOKEN` in production. Share the HTTPS link as:

```text
https://your-gameping-url.example/?token=YOUR_TOKEN
```

The web app stores the token locally and removes it from the visible URL after opening.

The app posts ping requests to the configured server URL. If the server is unavailable, the app still records the ping and shows a local notification preview.

The app also polls its server inbox while open, so two iPhones on the same Wi-Fi can test received calls even before APNs credentials are attached. APNs is still the production path for locked-screen/background delivery.

Useful endpoints:

- `GET /health`
- `GET /pings`
- `POST /pings`
- `GET /inbox/:userID`
- `GET /devices`
- `POST /devices`
- `GET /invites/:inviteCode`

`POST /devices` is the APNs handoff point. The app registers its profile automatically as `{ "userID", "userName", "inviteCode", "pushToken" }`. On Simulator it uses a `SIMULATOR-*` token so invite-code lookup can still be tested without Apple push credentials.

Friend lookup:

```sh
curl http://127.0.0.1:8787/invites/GP-ABC123
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
