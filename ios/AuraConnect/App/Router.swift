import Foundation
import Observation

enum AppTab: Hashable {
    case inbox, patients, alerts, schedule, more
}

/// Navigation destinations shared by every tab's `NavigationStack`.
enum Route: Hashable {
    case channel(String)
    case patient(String)
    case alert(String)
    case referral(String)
    case referrals
    case settings
}

/// Holds tab selection and per-tab navigation paths so push notifications
/// and cross-feature actions can deep-link.
@MainActor
@Observable
final class Router {
    static let shared = Router()

    var selectedTab: AppTab = .inbox
    var inboxPath: [Route] = []
    var patientsPath: [Route] = []
    var alertsPath: [Route] = []
    var schedulePath: [Route] = []
    var morePath: [Route] = []

    /// A notification tap waiting for the org session to be ready.
    var pendingPush: PushData?

    /// Pushes onto the currently selected tab's stack.
    func push(_ route: Route) {
        switch selectedTab {
        case .inbox: inboxPath.append(route)
        case .patients: patientsPath.append(route)
        case .alerts: alertsPath.append(route)
        case .schedule: schedulePath.append(route)
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
        selectedTab = .inbox
        inboxPath = []
        patientsPath = []
        alertsPath = []
        schedulePath = []
        morePath = []
    }
}
