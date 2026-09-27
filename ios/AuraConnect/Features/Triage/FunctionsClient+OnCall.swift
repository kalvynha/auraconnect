import Foundation

/// v3 on-call, triage, handoff and IDG callables (docs/DATA_MODEL.md "v3 — on-call, messaging,
/// triage, IDG"). Kept beside the features that use them; the v2 wrappers stay in
/// `FunctionsClient+Comms.swift`.
extension FunctionsClient {
    // MARK: Alerts (O3)

    /// `resolveAlert`; for a triage alert the call is resolved too (disposition `other` and note
    /// "Resolved from alert" unless given).
    func resolveAlert(orgId: String, alertId: String, disposition: TriageDisposition?, dispositionNote: String?) async throws {
        var payload: [String: Any] = ["orgId": orgId, "alertId": alertId]
        if let disposition { payload["disposition"] = disposition.rawValue }
        if let note = dispositionNote?.nilIfBlank { payload["dispositionNote"] = note }
        _ = try await call("resolveAlert", payload)
    }

    // MARK: Triage (O3)

    /// `resolveTriageCall` with an optional PRN visit (assigned to the caller unless `visit.assignedUid`).
    func resolveTriageCall(
        orgId: String,
        callId: String,
        disposition: TriageDisposition,
        dispositionNote: String?,
        followUpTask: TriageFollowUpTask?,
        visit: TriagePrnVisit?
    ) async throws {
        var payload: [String: Any] = [
            "orgId": orgId,
            "callId": callId,
            "disposition": disposition.rawValue,
        ]
        if let note = dispositionNote?.nilIfBlank { payload["dispositionNote"] = note }
        if let followUpTask, followUpTask.title.nilIfBlank != nil {
            payload["followUpTask"] = followUpTask.dictionary
        }
        if let visit { payload["visit"] = visit.dictionary }
        _ = try await call("resolveTriageCall", payload)
    }

    // MARK: Handoff (O4)

    func generateHandoff(orgId: String, sinceHours: Int, scope: HandoffScope, patientIds: [String]?) async throws -> AiTextResult {
        var payload: [String: Any] = ["orgId": orgId, "sinceHours": sinceHours, "scope": scope.rawValue]
        if scope == .careTeam, let patientIds, !patientIds.isEmpty { payload["patientIds"] = patientIds }
        let response = try await call("generateHandoff", payload)
        return AiTextResult(dictionary: response)
    }

    // MARK: On-call coverage (O5)

    func joinPatientChannelForCoverage(orgId: String, patientId: String, reason: String) async throws -> CoverageJoinResult {
        let response = try await call("joinPatientChannelForCoverage", [
            "orgId": orgId,
            "patientId": patientId,
            "reason": reason.trimmed,
        ])
        guard let channelId = (response["channelId"] as? String)?.nilIfBlank else {
            throw FunctionsClientError.badResponse("joinPatientChannelForCoverage")
        }
        return CoverageJoinResult(
            channelId: channelId,
            until: CallableValue.date(response["until"]),
            alreadyMember: response["alreadyMember"] as? Bool ?? false
        )
    }

    // MARK: IDG (F5)

    func saveIdgDisciplineNote(orgId: String, meetingId: String, patientId: String, discipline: Discipline, text: String) async throws {
        _ = try await call("saveIdgDisciplineNote", [
            "orgId": orgId,
            "meetingId": meetingId,
            "patientId": patientId,
            "discipline": discipline.rawValue,
            "text": text.trimmed,
        ])
    }

    /// One batch (≤ 25 patients) of AI prep, skipping patients with prep newer than `skipFreshHours`.
    func generateIdgPrepBatch(orgId: String, meetingId: String, patientIds: [String], skipFreshHours: Double) async throws -> IdgPrepBatchResult {
        let response = try await call("generateIdgPrep", [
            "orgId": orgId,
            "meetingId": meetingId,
            "patientIds": patientIds,
            "skipFreshHours": skipFreshHours,
        ])
        return IdgPrepBatchResult(
            generated: response["generatedPatientIds"] as? [String] ?? [],
            failed: response["failedPatientIds"] as? [String] ?? [],
            skipped: response["skippedPatientIds"] as? [String] ?? []
        )
    }

    /// Completes (locks) the meeting; returns warnings such as missing IDG disciplines.
    func completeIdgMeetingWithWarnings(orgId: String, meetingId: String) async throws -> [String] {
        let response = try await call("completeIdgMeeting", ["orgId": orgId, "meetingId": meetingId])
        return response["warnings"] as? [String] ?? []
    }
}

/// O3: optional PRN visit created when a triage call is resolved.
struct TriagePrnVisit: Hashable {
    var start: Date
    var end: Date
    /// nil = the resolver.
    var assignedUid: String?

    var dictionary: [String: Any] {
        var value: [String: Any] = [
            "start": CallableValue.isoString(start),
            "end": CallableValue.isoString(end),
        ]
        if let assignedUid = assignedUid?.nilIfBlank { value["assignedUid"] = assignedUid }
        return value
    }
}

/// O4: what a handoff covers.
enum HandoffScope: String, CaseIterable, Identifiable, Hashable {
    case careTeam = "care_team"
    case myActivity = "my_activity"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .careTeam: return "My care team"
        case .myActivity: return "My overnight activity"
        }
    }
}

/// O5: result of `joinPatientChannelForCoverage`.
struct CoverageJoinResult: Hashable {
    var channelId: String
    var until: Date?
    var alreadyMember: Bool
}

struct IdgPrepBatchResult: Hashable {
    var generated: [String]
    var failed: [String]
    var skipped: [String]
}
