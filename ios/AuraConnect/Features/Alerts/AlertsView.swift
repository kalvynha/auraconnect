import SwiftUI

struct AlertsView: View {
    @Environment(AlertsStore.self) private var store

    private enum Filter: String, CaseIterable, Identifiable {
        case open = "Open"
        case acked = "Acknowledged"
        case all = "All"
        var id: String { rawValue }
    }

    @State private var filter: Filter = .open

    private var visible: [AuraAlert] {
        switch filter {
        case .open: return store.alerts.filter { $0.alertStatus == .open }
        case .acked: return store.alerts.filter { $0.alertStatus == .acked }
        case .all: return store.alerts
        }
    }

    private var emptyTitle: String {
        filter == .open ? "No open alerts" : "No alerts"
    }

    var body: some View {
        List {
            Section {
                Picker("Status", selection: $filter) {
                    ForEach(Filter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if let error = store.errorMessage {
                ErrorBanner(message: error)
            }
            ForEach(visible) { alert in
                if let id = alert.id {
                    NavigationLink(value: Route.alert(id)) {
                        AlertRow(alert: alert)
                    }
                }
            }
        }
        .overlay {
            if store.isLoading {
                ProgressView()
            } else if visible.isEmpty && store.errorMessage == nil {
                ContentUnavailableView(emptyTitle,
                                       systemImage: "bell.slash",
                                       description: Text("Urgent messages and hospice deadline reminders appear here."))
            }
        }
        .navigationTitle("Alerts")
    }
}

struct AlertRow: View {
    let alert: AuraAlert

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: alert.alertPriority == .normal ? "bell.fill" : alert.alertPriority.symbol)
                .font(.title3)
                .foregroundStyle(alert.alertPriority == .normal ? Color.accentColor : alert.alertPriority.color)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(alert.displayTitle)
                        .font(.headline)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(RelativeTime.short(alert.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    PriorityBadge(priority: alert.alertPriority)
                    StatusPill(text: alert.alertStatus.label, color: alert.alertStatus.color)
                    if (alert.level ?? 0) > 0 {
                        StatusPill(text: "Level \(alert.level ?? 0)", color: .purple)
                    }
                    if alert.exhausted == true {
                        StatusPill(text: "Exhausted", color: .red)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
