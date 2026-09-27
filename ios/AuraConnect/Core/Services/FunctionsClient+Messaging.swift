import Foundation

/// v4 messaging callables (docs/DATA_MODEL.md "v4: messaging"; types.ts "v4 callables").
/// Optional request fields (`T?`) are omitted when nil.
extension FunctionsClient {
    // MARK: Templates

    /// Creates (no `templateId`) or updates a template. `org` scope is admin-only; `personal`
    /// writes `members/{me}/templates`. Returns the template id.
    @discardableResult
    func saveTemplate(orgId: String, templateId: String? = nil, scope: TemplateScope, template: MessageTemplate) async throws -> String {
        var payload: [String: Any] = [
            "orgId": orgId,
            "scope": scope.rawValue,
            "template": template.requestDictionary,
        ]
        if let templateId = templateId?.nilIfBlank { payload["templateId"] = templateId }
        let response = try await call("saveTemplate", payload)
        return (response["templateId"] as? String)?.nilIfBlank
            ?? (response["id"] as? String)?.nilIfBlank
            ?? templateId?.nilIfBlank
            ?? ""
    }

    func deleteTemplate(orgId: String, templateId: String, scope: TemplateScope) async throws {
        _ = try await call("deleteTemplate", ["orgId": orgId, "templateId": templateId, "scope": scope.rawValue])
    }

    /// Admin. Adds the default org templates (SBAR, fall report, …) that are missing.
    func seedDefaultTemplates(orgId: String) async throws {
        _ = try await call("seedDefaultTemplates", ["orgId": orgId])
    }

    // MARK: Messages

    /// Sender only, within 15 minutes, not recalled. Sets `body` and `editedAt`; does not re-push.
    func editMessage(orgId: String, channelId: String, messageId: String, body: String) async throws {
        _ = try await call("editMessage", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
            "body": body,
        ])
    }

    /// Any member who can post. At most 10 pins per channel.
    func pinMessage(orgId: String, channelId: String, messageId: String, pinned: Bool) async throws {
        _ = try await call("pinMessage", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
            "pinned": pinned,
        ])
    }

    // MARK: Channels

    /// Group and team channels; the creator or an admin.
    func renameChannel(orgId: String, channelId: String, name: String) async throws {
        _ = try await call("renameChannel", ["orgId": orgId, "channelId": channelId, "name": name])
    }

    /// Group and team channels (not patient channels, not the last member).
    func leaveChannel(orgId: String, channelId: String) async throws {
        _ = try await call("leaveChannel", ["orgId": orgId, "channelId": channelId])
    }

    /// Adds and/or removes members (not direct or broadcast channels). At least one list must be non-empty.
    func updateChannelMembers(orgId: String, channelId: String, add: [String] = [], remove: [String] = []) async throws {
        var payload: [String: Any] = ["orgId": orgId, "channelId": channelId]
        if !add.isEmpty { payload["add"] = add }
        if !remove.isEmpty { payload["remove"] = remove }
        _ = try await call("updateChannelMembers", payload)
    }

    // MARK: Delivery tracking

    func messageReadStatus(orgId: String, channelId: String, messageId: String) async throws -> MessageReadStatus {
        let response = try await call("messageReadStatus", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
        ])
        return MessageReadStatus(dictionary: response)
    }

    /// Sender or admin; at most once per message per 10 minutes. Returns how many members were nudged.
    @discardableResult
    func nudgeUnread(orgId: String, channelId: String, messageId: String) async throws -> Int {
        let response = try await call("nudgeUnread", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
        ])
        return CallableValue.int(response["nudged"]) ?? 0
    }

    /// `minutes` is 15, 30, 60 or 120. Returns the reminder id when the server reports it.
    @discardableResult
    func remindIfNoReply(orgId: String, channelId: String, messageId: String, minutes: Int) async throws -> String? {
        let response = try await call("remindIfNoReply", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
            "minutes": minutes,
        ])
        return (response["reminderId"] as? String)?.nilIfBlank ?? (response["id"] as? String)?.nilIfBlank
    }

    func cancelReminder(orgId: String, reminderId: String) async throws {
        _ = try await call("cancelReminder", ["orgId": orgId, "reminderId": reminderId])
    }

    // MARK: Ack-required broadcasts

    /// The sender, admins, or members with the `reports` capability.
    func broadcastAckReport(orgId: String, channelId: String, messageId: String) async throws -> BroadcastAckReport {
        let response = try await call("broadcastAckReport", [
            "orgId": orgId,
            "channelId": channelId,
            "messageId": messageId,
        ])
        return BroadcastAckReport(dictionary: response)
    }
}
