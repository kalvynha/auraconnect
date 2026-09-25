import Foundation
import FirebaseCore
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions
import FirebaseStorage

/// App-wide constants.
enum AppConfig {
    /// All callables are deployed to this region (see docs/DATA_MODEL.md).
    static let functionsRegion = "us-central1"

    /// Request the `.criticalAlert` notification option. Keep `false` until Apple approves the
    /// Critical Alerts entitlement and it is enabled in AuraConnect.entitlements.
    static let criticalAlertsEnabled = false

    /// Re-lock with Face ID / passcode after this long in the background.
    static let autoLockInterval: TimeInterval = 5 * 60

    /// Extracted referral fields below this confidence are highlighted for review.
    static let lowConfidenceThreshold = 0.7

    /// Storage rules reject files over 25 MB.
    static let maxUploadBytes = 25 * 1024 * 1024

    /// Firestore rules cap message bodies at 8000 characters.
    static let maxMessageLength = 8000

    /// Fallback for `org.deadlineLeadDays` when the org document has none.
    static let defaultDeadlineLeadDays = 7

    /// Firestore offline cache size.
    static let firestoreCacheBytes: Int64 = 100 * 1024 * 1024
}

/// Owns Firebase configuration and exposes the shared SDK instances.
enum FirebaseService {
    nonisolated(unsafe) private(set) static var isConfigured = false
    nonisolated(unsafe) private(set) static var usingEmulators = false

    /// `USE_FIREBASE_EMULATORS=1` in the scheme's environment, or the launch argument
    /// `-USE_FIREBASE_EMULATORS YES` (launch arguments populate UserDefaults).
    static var emulatorsRequested: Bool {
        let env = ProcessInfo.processInfo.environment["USE_FIREBASE_EMULATORS"]
        if env == "1" || env?.lowercased() == "true" { return true }
        return UserDefaults.standard.bool(forKey: "USE_FIREBASE_EMULATORS")
    }

    /// Host running the emulator suite. Override with `FIREBASE_EMULATOR_HOST`
    /// (e.g. your Mac's LAN IP when running on a physical device).
    static var emulatorHost: String {
        ProcessInfo.processInfo.environment["FIREBASE_EMULATOR_HOST"]?.nilIfBlank ?? "localhost"
    }

    /// Project id used when running against emulators without a GoogleService-Info.plist.
    static var emulatorProjectId: String {
        ProcessInfo.processInfo.environment["FIREBASE_PROJECT_ID"]?.nilIfBlank ?? "demo-auraconnect"
    }

    /// Configures Firebase if `GoogleService-Info.plist` is bundled (or emulators are requested).
    /// Safe to call more than once. When nothing can be configured the app shows a setup screen.
    static func configure() {
        guard !isConfigured else { return }
        let useEmulators = emulatorsRequested

        if FirebaseApp.app() == nil {
            if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
               let options = FirebaseOptions(contentsOfFile: path) {
                FirebaseApp.configure(options: options)
            } else if useEmulators {
                // Placeholder options so the emulator suite can be used without a real project.
                // The API key only has to be well-formed; emulators do not validate it.
                let options = FirebaseOptions(googleAppID: "1:000000000000:ios:0000000000000000",
                                              gcmSenderID: "000000000000")
                options.projectID = emulatorProjectId
                options.apiKey = "AIzaSyDemoKeyForLocalEmulatorsOnly00000"
                options.storageBucket = "\(emulatorProjectId).appspot.com"
                FirebaseApp.configure(options: options)
            } else {
                return
            }
        }

        configureFirestore(useEmulators: useEmulators)

        if useEmulators {
            let host = emulatorHost
            Auth.auth().useEmulator(withHost: host, port: 9099)
            functions.useEmulator(withHost: host, port: 5001)
            Storage.storage().useEmulator(withHost: host, port: 9199)
        }

        usingEmulators = useEmulators
        isConfigured = true
    }

    private static func configureFirestore(useEmulators: Bool) {
        let settings = FirestoreSettings()
        // Persistent (on-disk) cache so messages and patients are available offline.
        // The cache lives in the app container, which the
        // `com.apple.developer.default-data-protection = NSFileProtectionComplete`
        // entitlement encrypts at rest with the device passcode.
        settings.cacheSettings = PersistentCacheSettings(sizeBytes: NSNumber(value: AppConfig.firestoreCacheBytes))
        if useEmulators {
            settings.host = "\(emulatorHost):8080"
            settings.isSSLEnabled = false
        }
        Firestore.firestore().settings = settings
    }

    /// Removes cached PHI from this device (called on sign-out): terminates Firestore, re-applies
    /// settings on the fresh instance *before* it starts, then clears its on-disk cache.
    @MainActor
    static func clearLocalData() async {
        SecureDownload.removeAll()
        guard isConfigured else { return }
        do {
            try await Firestore.firestore().terminate()
        } catch {
            print("[Firestore] terminate failed: \(error.localizedDescription)")
            return
        }
        // `Firestore.firestore()` now returns a new, not-yet-started instance.
        configureFirestore(useEmulators: usingEmulators)
        do {
            try await Firestore.firestore().clearPersistence()
        } catch {
            print("[Firestore] clearPersistence failed: \(error.localizedDescription)")
        }
    }

    // MARK: Shared instances (only valid after `configure()`)

    static var db: Firestore { Firestore.firestore() }

    /// Region-pinned Functions instance. Created once so emulator settings stick.
    static let functions: Functions = Functions.functions(region: AppConfig.functionsRegion)

    static var storage: Storage { Storage.storage() }

    // MARK: Paths

    static func orgRef(_ orgId: String) -> DocumentReference {
        db.collection("orgs").document(orgId)
    }

    static func userOrgRef(_ uid: String) -> DocumentReference {
        db.collection("userOrgs").document(uid)
    }
}

// MARK: - Listener streams

extension Query {
    /// Live query results decoded as `T`. Documents that fail to decode are skipped
    /// (and logged in debug builds) so one malformed document never breaks a list.
    /// The Firestore listener is removed when the consuming task is cancelled.
    func decodedStream<T: Decodable>(
        _ type: T.Type,
        serverTimestamps: ServerTimestampBehavior = .none
    ) -> AsyncThrowingStream<[T], Error> {
        AsyncThrowingStream { continuation in
            let registration = self.addSnapshotListener { snapshot, error in
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                guard let snapshot else { return }
                var items: [T] = []
                items.reserveCapacity(snapshot.documents.count)
                for document in snapshot.documents {
                    do {
                        items.append(try document.data(as: T.self, with: serverTimestamps))
                    } catch {
                        #if DEBUG
                        print("[Firestore] Skipping \(document.reference.path): \(error)")
                        #endif
                    }
                }
                continuation.yield(items)
            }
            continuation.onTermination = { _ in
                registration.remove()
            }
        }
    }
}

extension DocumentReference {
    /// Live document decoded as `T`; yields `nil` when the document does not exist or fails to decode.
    func decodedStream<T: Decodable>(
        _ type: T.Type,
        serverTimestamps: ServerTimestampBehavior = .none
    ) -> AsyncThrowingStream<T?, Error> {
        AsyncThrowingStream { continuation in
            let registration = self.addSnapshotListener { snapshot, error in
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                guard let snapshot else { return }
                guard snapshot.exists else {
                    continuation.yield(nil)
                    return
                }
                do {
                    continuation.yield(try snapshot.data(as: T.self, with: serverTimestamps))
                } catch {
                    #if DEBUG
                    print("[Firestore] Could not decode \(snapshot.reference.path): \(error)")
                    #endif
                    continuation.yield(nil)
                }
            }
            continuation.onTermination = { _ in
                registration.remove()
            }
        }
    }
}
