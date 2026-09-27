import Foundation

/// v2 communication & coordination callables (docs/DATA_MODEL.md, "New callables").
/// Optional request fields typed `T | null` are sent as `NSNull`; fields typed `T?` (may be
/// absent) are omitted when nil.
extension FunctionsClient {
    private func commsString(_ key: String, in response: [String: Any], from name: String) throws -> String {
        guard let value = response[key] as? String, !value.isEmpty else {
            throw FunctionsClientError.badResponse(name)
        }
        return value
    }

    // MARK: Messaging extras

    /// Sender or admin. Empties the body and attachments and sets `recalledAt`.
    func recallMessage(orgId: String, channelId: String, messageId: String) async throws {
        _ = try await call("recallMessage", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
        ])
    }

    /// Case-insensitive substring match over my non-archived channels (last 90 days, ≤ 50 hits).
    func searchMessages(orgId: String, query: String, channelId: String? = nil) async throws -> MessageSearchResult {
        var payload: [String: Any] = ["orgId": orgId, "query": query]
        if let channelId = channelId?.nilIfBlank { payload["channelId"] = channelId }
        let response = try await call("searchMessages", payload)
        let raw = response["hits"] as? [[String: Any]] ?? []
        return MessageSearchResult(
            hits: raw.compactMap { MessageSearchHit(dictionary: $0) },
            truncated: response["truncated"] as? Bool ?? false
        )
    }

    /// Admin. Creates a `broadcast` channel for the resolved recipients and posts the message.
    /// v4: `requireAck` makes recipients acknowledge (`acks/{uid}`, report via `broadcastAckReport`).
    func sendBroadcast(orgId: String, name: String, target: BroadcastTarget, body: String, priority: Priority,
                       requireAck: Bool = false) async throws -> BroadcastResult {
        var payload: [String: Any] = [
            "orgId": orgId,
            "name": name,
            "target": target.dictionary,
            "body": body,
            "priority": priority.rawValue,
        ]
        if requireAck { payload["requireAck"] = true }
        let response = try await call("sendBroadcast", payload)
        return BroadcastResult(
            channelId: try commsString("channelId", in: response, from: "sendBroadcast"),
            messageId: response["messageId"] as? String,
            recipientCount: CallableValue.int(response["recipientCount"]) ?? 0
        )
    }

    // MARK: AI (never stored)

    func summarizeChannel(orgId: String, channelId: String, sinceHours: Int? = nil) async throws -> AiTextResult {
        var payload: [String: Any] = ["orgId": orgId, "channelId": channelId]
        if let sinceHours { payload["sinceHours"] = sinceHours }
        let response = try await call("summarizeChannel", payload)
        return AiTextResult(dictionary: response)
    }

    /// Shift handoff for the caller's care-team patients.
    func generateHandoff(orgId: String, sinceHours: Int, patientIds: [String]? = nil) async throws -> AiTextResult {
        var payload: [String: Any] = ["orgId": orgId, "sinceHours": sinceHours]
        if let patientIds, !patientIds.isEmpty { payload["patientIds"] = patientIds }
        let response = try await call("generateHandoff", payload)
        return AiTextResult(dictionary: response)
    }

    // MARK: IDG

    /// Returns the new meeting id. `patientIds == nil` auto-populates the agenda with patients due for review.
    func createIdgMeeting(
        orgId: String,
        title: String,
        scheduledAt: Date,
        teamId: String?,
        attendeeUids: [String],
        patientIds: [String]?
    ) async throws -> String {
        var payload: [String: Any] = [
            "orgId": orgId,
            "title": title,
            "scheduledAt": CallableValue.isoString(scheduledAt),
            "attendeeUids": attendeeUids,
        ]
        if let teamId = teamId?.nilIfBlank { payload["teamId"] = teamId }
        if let patientIds { payload["patientIds"] = patientIds }
        let response = try await call("createIdgMeeting", payload)
        if let id = (response["id"] as? String)?.nilIfBlank { return id }
        return try commsString("meetingId", in: response, from: "createIdgMeeting")
    }

    /// Only the non-nil fields are changed.
    func updateIdgMeeting(
        orgId: String,
        meetingId: String,
        title: String? = nil,
        scheduledAt: Date? = nil,
        attendeeUids: [String]? = nil,
        patientIds: [String]? = nil
    ) async throws {
        var payload: [String: Any] = ["orgId": orgId, "meetingId": meetingId]
        if let title = title?.nilIfBlank { payload["title"] = title }
        if let scheduledAt { payload["scheduledAt"] = CallableValue.isoString(scheduledAt) }
        if let attendeeUids { payload["attendeeUids"] = attendeeUids }
        if let patientIds { payload["patientIds"] = patientIds }
        _ = try await call("updateIdgMeeting", payload)
    }

    func saveIdgNote(
        orgId: String,
        meetingId: String,
        patientId: String,
        summary: String,
        planOfCareChanges: String?,
        goalsOfCare: String?,
        actionItems: [IdgActionItem],
        reviewed: Bool
    ) async throws {
        _ = try await call("saveIdgNote", [
            "orgId": orgId,
            "meetingId": meetingId,
            "patientId": patientId,
            "summary": summary.trimmed,
            "planOfCareChanges": blankToNull(planOfCareChanges),
            "goalsOfCare": blankToNull(goalsOfCare),
            "actionItems": actionItems.filter { $0.title.nilIfBlank != nil }.map { $0.dictionary },
            "reviewed": reviewed,
        ])
    }

    func completeIdgMeeting(orgId: String, meetingId: String) async throws {
        _ = try await call("completeIdgMeeting", ["orgId": orgId, "meetingId": meetingId])
    }

    /// Stores AI prep in `aiPrep[patientId]` for one patient, or every agenda patient when nil.
    func generateIdgPrep(orgId: String, meetingId: String, patientId: String? = nil) async throws {
        var payload: [String: Any] = ["orgId": orgId, "meetingId": meetingId]
        if let patientId = patientId?.nilIfBlank { payload["patientId"] = patientId }
        _ = try await call("generateIdgPrep", payload)
    }

    // MARK: Triage

    func logTriageCall(
        orgId: String,
        patientId: String?,
        callerName: String,
        callerRelationship: String?,
        callerPhone: String?,
        reason: String,
        symptoms: [String],
        urgency: TriageUrgency,
        roleKey: String?,
        assignedUid: String? = nil
    ) async throws -> TriageLogResult {
        var payload: [String: Any] = [
            "orgId": orgId,
            "callerName": callerName,
            "reason": reason,
            "symptoms": symptoms,
            "urgency": urgency.rawValue,
        ]
        if let patientId = patientId?.nilIfBlank { payload["patientId"] = patientId }
        if let callerRelationship = callerRelationship?.nilIfBlank { payload["callerRelationship"] = callerRelationship }
        if let callerPhone = callerPhone?.nilIfBlank { payload["callerPhone"] = callerPhone }
        if let roleKey = roleKey?.nilIfBlank { payload["roleKey"] = roleKey }
        if let assignedUid = assignedUid?.nilIfBlank { payload["assignedUid"] = assignedUid }
        let response = try await call("logTriageCall", payload)
        return TriageLogResult(
            callId: try commsString("callId", in: response, from: "logTriageCall"),
            assignedUid: response["assignedUid"] as? String,
            alertId: response["alertId"] as? String
        )
    }

    func assignTriageCall(orgId: String, callId: String, assignedUid: String) async throws {
        _ = try await call("assignTriageCall", ["orgId": orgId, "callId": callId, "assignedUid": assignedUid])
    }

    func resolveTriageCall(
        orgId: String,
        callId: String,
        disposition: TriageDisposition,
        dispositionNote: String?,
        followUpTask: TriageFollowUpTask?
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
        _ = try await call("resolveTriageCall", payload)
    }

    // MARK: Metrics

    /// Admin. Computes today's metrics and writes `metrics/{today}` (the dashboard listener picks it up).
    func computeMetrics(orgId: String) async throws {
        _ = try await call("computeMetrics", ["orgId": orgId])
    }
}
