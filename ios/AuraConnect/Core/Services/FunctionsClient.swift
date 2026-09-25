import Foundation
import FirebaseFunctions

enum FunctionsClientError: LocalizedError {
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .badResponse(let name): return "Unexpected response from \(name)."
        }
    }
}

struct AdmitResult: Hashable {
    var patientId: String
    var channelId: String
}

/// Typed wrappers around the HTTPS callables in `us-central1` (docs/DATA_MODEL.md).
/// Requests are encoded manually as `[String: Any]` so optional fields are sent as `null`.
struct FunctionsClient {
    private func call(_ name: String, _ payload: [String: Any]) async throws -> [String: Any] {
        let callable = FirebaseService.functions.httpsCallable(name)
        let result = try await callable.call(payload)
        return (result.data as? [String: Any]) ?? [:]
    }

    private func string(_ key: String, in response: [String: Any], from name: String) throws -> String {
        guard let value = response[key] as? String, !value.isEmpty else {
            throw FunctionsClientError.badResponse(name)
        }
        return value
    }

    // MARK: Org

    func createOrg(name: String, timezone: String, displayName: String, discipline: Discipline) async throws -> String {
        let response = try await call("createOrg", [
            "name": name,
            "timezone": timezone,
            "displayName": displayName,
            "discipline": discipline.rawValue,
        ])
        return try string("orgId", in: response, from: "createOrg")
    }

    func listMyInvites() async throws -> [InviteSummary] {
        let response = try await call("listMyInvites", [:])
        let raw = response["invites"] as? [[String: Any]] ?? []
        return raw.compactMap { item -> InviteSummary? in
            guard let orgId = item["orgId"] as? String, let inviteId = item["inviteId"] as? String else { return nil }
            let role = (item["role"] as? String).flatMap { Role(rawValue: $0) } ?? .viewer
            return InviteSummary(orgId: orgId, inviteId: inviteId, orgName: item["orgName"] as? String ?? "Organization", role: role)
        }
    }

    func acceptInvite(orgId: String, inviteId: String) async throws {
        _ = try await call("acceptInvite", ["orgId": orgId, "inviteId": inviteId])
    }

    // MARK: Messaging

    /// `type` is `direct`, `group` or `team`. Direct channels are idempotent server-side.
    func createChannel(orgId: String, type: ChannelType, memberUids: [String], name: String? = nil) async throws -> String {
        var payload: [String: Any] = ["orgId": orgId, "type": type.rawValue, "memberUids": memberUids]
        if let name = name?.nilIfBlank { payload["name"] = name }
        let response = try await call("createChannel", payload)
        return try string("channelId", in: response, from: "createChannel")
    }

    /// Returns the channel the message was written to.
    func sendRoleMessage(orgId: String, roleKey: String, body: String, priority: Priority) async throws -> String {
        let response = try await call("sendRoleMessage", [
            "orgId": orgId,
            "roleKey": roleKey,
            "body": body,
            "priority": priority.rawValue,
        ])
        return try string("channelId", in: response, from: "sendRoleMessage")
    }

    // MARK: Alerts

    func ackAlert(orgId: String, alertId: String) async throws {
        _ = try await call("ackAlert", ["orgId": orgId, "alertId": alertId])
    }

    func resolveAlert(orgId: String, alertId: String) async throws {
        _ = try await call("resolveAlert", ["orgId": orgId, "alertId": alertId])
    }

    // MARK: Patients

    func admitPatient(
        orgId: String,
        patientId: String?,
        patient: PatientInput,
        admissionDate: String,
        startingBenefitPeriod: Int,
        levelOfCare: LevelOfCare,
        careTeamUids: [String],
        consents: Consents
    ) async throws -> AdmitResult {
        var payload: [String: Any] = [
            "orgId": orgId,
            "patient": patient.dictionary,
            "admissionDate": admissionDate,
            "startingBenefitPeriod": startingBenefitPeriod,
            "levelOfCare": levelOfCare.rawValue,
            "careTeamUids": careTeamUids,
            "consents": consents.dictionary,
        ]
        if let patientId { payload["patientId"] = patientId }
        let response = try await call("admitPatient", payload)
        return AdmitResult(
            patientId: try string("patientId", in: response, from: "admitPatient"),
            channelId: response["channelId"] as? String ?? ""
        )
    }

    // MARK: Referrals

    func acceptReferral(orgId: String, referralId: String, patient: PatientInput) async throws -> String {
        let response = try await call("acceptReferral", [
            "orgId": orgId,
            "referralId": referralId,
            "patient": patient.dictionary,
        ])
        return try string("patientId", in: response, from: "acceptReferral")
    }

    func rejectReferral(orgId: String, referralId: String, reason: String) async throws {
        _ = try await call("rejectReferral", ["orgId": orgId, "referralId": referralId, "reason": reason])
    }

    func retryReferralExtraction(orgId: String, referralId: String) async throws {
        _ = try await call("retryReferralExtraction", ["orgId": orgId, "referralId": referralId])
    }
}

extension Error {
    /// A user-presentable message. For callable errors (`FunctionsErrorCode`) the SDK puts the
    /// server's `HttpsError` message in `localizedDescription`.
    var userMessage: String {
        let message = localizedDescription
        return message.isEmpty ? "Something went wrong. Please try again." : message
    }
}
