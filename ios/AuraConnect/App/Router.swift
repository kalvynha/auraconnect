import Foundation
import Observation

enum AppTab: Hashable {
    case today, inbox, patients, alerts, more
}

/// Navigation destinations shared by every tab's `NavigationStack`.
enum Route: Hashable {
    case channel(String)
    case patient(String)
    case alert(String)
    case referral(String)
    case referrals
    case members
    case settings
    // v2 communication & coordination
    case messageThread(channelId: String, messageId: String)
    case messageSearch
    case handoff
    case triage
    case triageCall(String)
    case idgMeetings
    case idgMeeting(String)
    case dashboard
    // v2 care workflows
    case myTasks
    case myVisits
    case bereavement
    case bereavementPlan(String)
    case volunteers
    // v3 field usability
    case visit(String)
    case onCallSchedule
    // v4 directory, presence and notifications
    case directory
    case memberProfile(String)
    case myStatus
    case notificationSettings
}

/// Holds tab selection and per-tab navigation paths so push notifications
/// and cross-feature actions can deep-link.
@MainActor
@Observable
final class Router {
    static let shared = Router()

    var selectedTab: AppTab = .today
    var todayPath: [Route] = []
    var inboxPath: [Route] = []
    var patientsPath: [Route] = []
    var alertsPath: [Route] = []
    var morePath: [Route] = []

    /// A notification tap waiting for the org session to be ready.
    var pendingPush: PushData?

    /// Pushes onto the currently selected tab's stack.
    func push(_ route: Route) {
        switch selectedTab {
        case .today: todayPath.append(route)
        case .inbox: inboxPath.append(route)
        case .patients: patientsPath.append(route)
        case .alerts: alertsPath.append(route)
        case .more: morePath.append(route)
        }
    }

    func handleNotificationTap(_ push: PushData) {
        pendingPush = push
    }

    /// Applies `pendingPush` if it belongs to the current org.
    func consumePendingPush(orgId: String) {
        guard let push = pendingPush else { return }
        pendingPush = nil
        guard push.orgId.isEmpty || push.orgId == orgId else { return }
        switch push.type {
        case .message:
            if let channelId = push.channelId {
                selectedTab = .inbox
                inboxPath = [.channel(channelId)]
            }
        case .alert:
            // Urgent/critical messages send a single alert push that also carries the
            // channelId: open the conversation. Other alerts open the alert detail.
            if let channelId = push.channelId {
                selectedTab = .inbox
                inboxPath = [.channel(channelId)]
            } else if let alertId = push.alertId {
                selectedTab = .alerts
                alertsPath = [.alert(alertId)]
            }
        }
    }

    func reset() {
        selectedTab = .today
        todayPath = []
        inboxPath = []
        patientsPath = []
        alertsPath = []
        morePath = []
    }
}
