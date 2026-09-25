import Foundation
import FirebaseFirestore

/// Flattened form of the `AlertSource` tagged union:
/// `{type:'message', channelId, messageId} | {type:'deadline', patientId, milestone, dueDate} | {type:'manual', patientId}`.
struct AlertSource: Codable, Hashable {
    var type: String?
    var channelId: String?
    var messageId: String?
    var patientId: String?
    var milestone: MilestoneKind?
    var dueDate: String?

    var isMessage: Bool { type == "message" }
    var isDeadline: Bool { type == "deadline" }
}

struct AlertEscalationEvent: Codable, Hashable {
    var level: Int?
    var targetUids: [String]?
    var at: Date?
}

/// `orgs/{orgId}/alerts/{alertId}`. Named `AuraAlert` to avoid clashing with `SwiftUI.Alert`.
struct AuraAlert: Codable, Identifiable {
    @DocumentID var id: String?
    var title: String?
    var body: String?
    var priority: Priority?
    var source: AlertSource?
    var targetUids: [String]?
    var currentTargetUids: [String]?
    var policyId: String?
    var level: Int?
    var exhausted: Bool?
    var status: AlertStatus?
    var createdBy: String?
    var createdAt: Date?
    var ackedBy: String?
    var ackedAt: Date?
    var history: [AlertEscalationEvent]?

    var alertStatus: AlertStatus { status ?? .open }
    var alertPriority: Priority { priority ?? .normal }
    var displayTitle: String { title?.nilIfBlank ?? "Alert" }
}
