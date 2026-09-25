# AuraConnect for iOS

This is the SwiftUI iPhone and iPad client for AuraConnect, a secure messaging and collaboration app for hospice care teams. It runs on Firebase:

- Auth
- Firestore
- Cloud Functions (`us-central1`)
- Storage
- Cloud Messaging (FCM)

The app follows the contract in [`docs/DATA_MODEL.md`](../docs/DATA_MODEL.md) and [`functions/src/shared/types.ts`](../functions/src/shared/types.ts).

**Requirements:** Xcode 16 or later (Swift 5 language mode) and an iOS 17.0 or later deployment target.

The project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen), so no `.xcodeproj` is committed.

## Quick start

```sh
brew install xcodegen
cd ios
xcodegen generate          # creates AuraConnect.xcodeproj from project.yml
open AuraConnect.xcodeproj
```

The first build resolves `firebase-ios-sdk` 11.x through Swift Package Manager, which takes a few minutes.

**Firebase products used:**
- FirebaseAuth
- FirebaseFirestore
- FirebaseFunctions
- FirebaseStorage
- FirebaseMessaging

**Firebase products left out on purpose:** FirebaseAnalytics and Crashlytics are not included, because Google's BAA doesn't cover them and they could capture PHI. Don't add them.

Re-run `xcodegen generate` whenever you add or remove files, or change `project.yml`.

## 1. Add `GoogleService-Info.plist`

`GoogleService-Info.plist` is **not committed**. It is listed in `.gitignore`.

1. In the Firebase console, open **Project settings → Your apps**.
2. Add an iOS app with bundle ID `com.auraconnect.app`.
3. Download `GoogleService-Info.plist`.
4. Put it in `ios/AuraConnect/Resources/GoogleService-Info.plist`.
5. Run `xcodegen generate` again so the file is added to the app target.

If the plist is missing, the app doesn't crash. It shows a "Firebase is not configured" screen instead, unless you run against the emulators (see below).

## 2. Signing and capabilities

1. Set your team:
   - either in `project.yml` under `settings.base.DEVELOPMENT_TEAM`,
   - or in Xcode's **Signing & Capabilities** tab.
2. The entitlements file `AuraConnect/Resources/AuraConnect.entitlements` already contains:
   - `aps-environment = development` (Push Notifications).
   - `com.apple.developer.default-data-protection = NSFileProtectionComplete`. This encrypts every file the app writes with the device passcode, including the Firestore offline cache, attachment previews and scanned referrals. Such files can't be read while the device is locked.
3. With automatic signing, Xcode adds the Push Notifications capability to the App ID for you. For manual signing, enable **Push Notifications** on the App ID in the Apple Developer portal.

## 3. Push notifications (APNs → FCM)

1. In the Apple Developer portal, go to **Keys** and create a key with **Apple Push Notifications service (APNs)** enabled. Download the `.p8` file.
2. In the Firebase console, go to **Project settings → Cloud Messaging → Apple app configuration**. Upload the `.p8` key with its Key ID and your Team ID.
3. Run on a **physical device**. The Simulator can receive pushes on Apple silicon with Xcode 14+, but a real device is the reliable way to test APNs.

How push works in the app:

- **Manual wiring.** `FirebaseAppDelegateProxyEnabled` is `false`, so `AppDelegate` forwards the APNs token to FCM itself.
- **Token storage.** The app saves the FCM token to `orgs/{orgId}/members/{uid}.fcmTokens`. It keeps at most 20 tokens, as the rules require. It removes the token on sign-out.
- **No PHI in pushes.** Push content is generic ("New message" / "Urgent message"). Tapping a push deep-links to the chat or alert, and the content is fetched only after the user unlocks the app. For that reason there is no Notification Service Extension.
- **Urgent and critical messages** arrive as a single `type: "alert"` push that includes a `channelId`. Tapping it opens the chat.

### Critical Alerts (optional)

A `critical` priority alert can break through Do Not Disturb and mute only if Apple grants the Critical Alerts entitlement.

1. Request it: <https://developer.apple.com/contact/request/notifications-critical-alerts-entitlement/>
2. After approval:
   - Uncomment `com.apple.developer.usernotifications.critical-alerts` in `AuraConnect.entitlements`.
   - Regenerate your provisioning profile.
   - Set `AppConfig.criticalAlertsEnabled = true` in `Core/Services/FirebaseService.swift`.

Don't enable the entitlement before approval, because code signing will fail. Until then, iOS delivers `critical` pushes as time-sensitive.

## 4. Run against the local emulators

Start the emulator suite from the repo root:

```sh
firebase emulators:start --project demo-auraconnect
(cd scripts && npm install && npm run seed)   # optional demo data (e.g. rn@demo.test / password123)
```

Then run the **AuraConnect-Emulators** scheme. It sets `USE_FIREBASE_EMULATORS=1`, and the app connects to:

| Service | Port |
|---|---|
| Auth | `localhost:9099` |
| Firestore | `localhost:8080` |
| Functions | `localhost:5001` |
| Storage | `localhost:9199` |

Notes:

- **Without a plist.** In emulator mode a `GoogleService-Info.plist` isn't needed. The app configures placeholder options for project `demo-auraconnect`. Override the project with the `FIREBASE_PROJECT_ID` environment variable.
- **On a physical device**, set `FIREBASE_EMULATOR_HOST` to your Mac's LAN IP in the scheme. Start the emulators with `--host 0.0.0.0` (or configure `host` in `firebase.json`).
- **Launch argument.** You can also use `-USE_FIREBASE_EMULATORS YES` instead of the environment variable.

## Architecture

```
AuraConnect/
  App/            AuraConnectApp, AppDelegate (push), RootView, MainTabView, Router (deep links)
  Core/
    Models/       Codable mirrors of types.ts (@DocumentID, tolerant decoding)
    Services/     FirebaseService (config, emulators, listener streams), SessionStore,
                  OrgStore (members cache), *Repository, FunctionsClient, PushTokenRegistrar,
                  SecureDownload
    Security/     AppLockManager (Face ID / passcode, 5-minute auto-lock), PrivacyShieldView
    Util/         ISODate, MilestoneLogic, ChannelLogic, Binding helpers
    UI/           Shared components (badges, pills, form fields)
  Features/       Auth, Onboarding, Inbox, Chat, NewMessage, Patients, PatientOnboarding,
                  Alerts, Schedule, ReferralScan, Settings
  Resources/      Assets.xcassets, AuraConnect.entitlements
AuraConnectTests/ Unit tests for the pure logic (dates, milestones, unread, push parsing, models)
```

- **View models.** They use MVVM with `@Observable` and `@MainActor`. Each screen creates its view model in `init` and starts listeners from `.task { … }`.
- **Listeners.** Repositories expose Firestore listeners as `AsyncThrowingStream`s. The Firestore listener is removed automatically when the view's task is cancelled.
- **Callables.** They are sent as hand-built `[String: Any]` dictionaries, so optional fields go out as `null` exactly as the contract expects.
- **Direct writes.** Messages, read receipts and referral records are written straight to Firestore. Each one uses the exact field set that `firestore.rules` requires.

## Security and HIPAA notes

- **App lock.** Face ID or Touch ID (falling back to the device passcode) is required on launch and after 5 minutes in the background. A blur shield hides content whenever the scene isn't active, including in the app switcher.
- **Offline cache.** Firestore's persistent cache is enabled and protected by `NSFileProtectionComplete`. On sign-out, the app terminates Firestore and clears its on-disk cache and any attachment previews.
- **Attachments and referrals.**
  - Downloads use an ephemeral `URLSession`, so nothing lands in the shared URL cache.
  - Files are written with complete file protection and deleted when the preview closes.
  - Uploads are create-only. Removing an attachment from a draft leaves the uploaded object in Storage, and it needs a server-side cleanup.
- **Logging.** No analytics or crash reporting SDKs are included. Debug logging never prints document contents.

## Firestore indexes used

These are defined in the repo's `firestore.indexes.json`:

- `channels`: `memberUids` array-contains, then `lastMessageAt` descending
- `alerts`: `targetUids` array-contains, then `createdAt` descending

The remaining queries use single-field indexes:

- `patients` ordered by `lastName`
- `referrals` ordered by `createdAt`
- `shifts` filtered on `end >=` and ordered by `end`
- messages ordered by `createdAt`

## Tests

```sh
xcodebuild test -project AuraConnect.xcodeproj -scheme AuraConnect \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```
