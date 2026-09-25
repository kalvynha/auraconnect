import Foundation
import Observation
import FirebaseAuth
import FirebaseFirestore

/// The signed-in user's org membership, resolved from `userOrgs/{uid}` and the token claims.
struct OrgContext: Hashable {
    let orgId: String
    let uid: String
    let role: Role
    let email: String?
}

/// Observes Firebase Auth and resolves which org the user belongs to.
@MainActor
@Observable
final class SessionStore {
    enum Phase: Equatable {
        case loading
        case signedOut
        /// Signed in but no `userOrgs/{uid}` yet: show org onboarding.
        case needsOrg
        case ready(OrgContext)
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var uid: String?
    private(set) var email: String?
    private(set) var authDisplayName: String?
    /// Accepting an invite requires a verified email (creating an org does not).
    private(set) var isEmailVerified = false

    @ObservationIgnored private var authHandle: AuthStateDidChangeListenerHandle?
    @ObservationIgnored private var loadGeneration = 0

    var context: OrgContext? {
        if case .ready(let context) = phase { return context }
        return nil
    }

    var isSignedIn: Bool { uid != nil }

    func start() {
        guard FirebaseService.isConfigured, authHandle == nil else { return }
        authHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            let uid = user?.uid
            Task { @MainActor [weak self] in
                await self?.authChanged(uid: uid)
            }
        }
    }

    private func authChanged(uid newUid: String?) async {
        guard newUid != uid || phase == .loading else { return }
        let user = Auth.auth().currentUser
        uid = user?.uid
        email = user?.email
        authDisplayName = user?.displayName
        isEmailVerified = user?.isEmailVerified ?? false
        if user == nil {
            phase = .signedOut
        } else {
            await loadOrg()
        }
    }

    /// Looks up `userOrgs/{uid}` and makes sure the ID token carries matching claims.
    func loadOrg() async {
        guard let user = Auth.auth().currentUser else {
            phase = .signedOut
            return
        }
        loadGeneration += 1
        let generation = loadGeneration
        phase = .loading
        do {
            let snapshot = try await FirebaseService.userOrgRef(user.uid).getDocument()
            guard generation == loadGeneration else { return }
            guard snapshot.exists,
                  let userOrg = try? snapshot.data(as: UserOrg.self),
                  let orgId = userOrg.orgId?.nilIfBlank else {
                phase = .needsOrg
                return
            }
            // Claims are what the security rules check; refresh if they are stale.
            var token = try await user.getIDTokenResult()
            // Claims are set by Cloud Functions and can lag the userOrgs write slightly.
            var attempt = 0
            while (token.claims["orgId"] as? String) != orgId && attempt < 3 {
                if attempt > 0 {
                    try await Task.sleep(nanoseconds: 1_500_000_000)
                }
                token = try await user.getIDTokenResult(forcingRefresh: true)
                attempt += 1
            }
            guard generation == loadGeneration else { return }
            let claimRole = (token.claims["role"] as? String).flatMap { Role(rawValue: $0) }
            let role = claimRole ?? userOrg.role ?? .viewer
            phase = .ready(OrgContext(orgId: orgId, uid: user.uid, role: role, email: user.email))
        } catch {
            guard generation == loadGeneration else { return }
            phase = .failed(error.userMessage)
        }
    }

    // MARK: Auth actions

    func signIn(email: String, password: String) async throws {
        _ = try await Auth.auth().signIn(withEmail: email.trimmed, password: password)
    }

    func createAccount(email: String, password: String, displayName: String) async throws {
        let result = try await Auth.auth().createUser(withEmail: email.trimmed, password: password)
        if let name = displayName.nilIfBlank {
            let change = result.user.createProfileChangeRequest()
            change.displayName = name
            try? await change.commitChanges()
            authDisplayName = name
        }
    }

    func sendPasswordReset(email: String) async throws {
        try await Auth.auth().sendPasswordReset(withEmail: email.trimmed)
    }

    func sendEmailVerification() async throws {
        guard let user = Auth.auth().currentUser else { return }
        try await user.sendEmailVerification()
    }

    /// Reloads the user after they tap the verification link, then refreshes the ID token
    /// so the backend sees `email_verified`. Returns the new verification state.
    @discardableResult
    func reloadEmailVerification() async throws -> Bool {
        guard let user = Auth.auth().currentUser else { return false }
        try await user.reload()
        let refreshed = Auth.auth().currentUser ?? user
        _ = try await refreshed.getIDTokenResult(forcingRefresh: true)
        isEmailVerified = refreshed.isEmailVerified
        return isEmailVerified
    }

    /// Call after `createOrg` / `acceptInvite`: forces a token refresh to pick up the new claims.
    func didJoinOrg() async {
        guard let user = Auth.auth().currentUser else { return }
        _ = try? await user.getIDTokenResult(forcingRefresh: true)
        await loadOrg()
    }

    func signOut() async {
        await PushTokenRegistrar.shared.detach()
        do {
            try Auth.auth().signOut()
        } catch {
            phase = .failed(error.userMessage)
            return
        }
        await FirebaseService.clearLocalData()
    }
}
