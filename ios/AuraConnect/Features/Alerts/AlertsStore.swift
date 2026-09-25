import Foundation
import Observation

/// Live list of alerts targeting me. Owned by the tab bar so the Alerts tab can show a badge.
@MainActor
@Observable
final class AlertsStore {
    let context: OrgContext
    private(set) var alerts: [AuraAlert] = []
    private(set) var isLoading = true
    var errorMessage: String?

    init(context: OrgContext) {
        self.context = context
    }

    var openCount: Int { alerts.filter { $0.alertStatus == .open }.count }

    func alert(id: String) -> AuraAlert? {
        alerts.first { $0.id == id }
    }

    func run() async {
        do {
            for try await list in AlertRepository(orgId: context.orgId).myAlerts(uid: context.uid) {
                alerts = list
                isLoading = false
                errorMessage = nil
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }
}
