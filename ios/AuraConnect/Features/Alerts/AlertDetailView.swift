import SwiftUI
import Observation

@MainActor
@Observable
final class AlertDetailViewModel {
    let orgId: String
    let alertId: String
    private(set) var alert: AuraAlert?
    private(set) var isLoading = true
    private(set) var isWorking = false
    var errorMessage: String?

    init(orgId: String, alertId: String) {
        self.orgId = orgId
        self.alertId = alertId
    }

    func run() async {
        do {
            for try await value in AlertRepository(orgId: orgId).alert(id: alertId) {
                alert = value
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    func acknowledge() async {
        await perform { try await FunctionsClient().ackAlert(orgId: self.orgId, alertId: self.alertId) }
    }

    func resolve() async {
        await perform { try await FunctionsClient().resolveAlert(orgId: self.orgId, alertId: self.alertId) }
    }

    private func perform(_ action: () async throws -> Void) async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await action()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

struct AlertDetailView: View {
    @Environment(OrgStore.self) private var org
    let alertId: String

    var body: some View {
        AlertDetailContent(orgId: org.orgId, alertId: alertId)
    }
}

private struct AlertDetailContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: AlertDetailViewModel

    init(orgId: String, alertId: String) {
        _model = State(initialValue: AlertDetailViewModel(orgId: orgId, alertId: alertId))
    }

    var body: some View {
        Group {
            if let alert = model.alert {
                details(alert)
            } else if model.isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Alert unavailable",
                                       systemImage: "bell.slash",
                                       description: Text(model.errorMessage ?? "You may no longer be a recipient of this alert."))
            }
        }
        .navigationTitle("Alert")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.run() }
    }

    @ViewBuilder
    private func details(_ alert: AuraAlert) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        PriorityBadge(priority: alert.alertPriority, showNormal: true)
                        StatusPill(text: alert.alertStatus.label, color: alert.alertStatus.color)
                        if alert.exhausted == true {
                            StatusPill(text: "Escalation exhausted", color: .red)
                        }
                    }
                    Text(alert.displayTitle)
                        .font(.title3.weight(.semibold))
                    if let text = alert.body?.nilIfBlank {
                        Text(text)
                            .font(.body)
                            .textSelection(.enabled)
                    }
                    Text(RelativeTime.full(alert.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            if org.role.canSendMessages && alert.alertStatus != .resolved {
                Section {
                    if alert.alertStatus == .open {
                        Button {
                            Task { await model.acknowledge() }
                        } label: {
                            Label("Acknowledge", systemImage: "hand.raised.fill")
                                .font(.body.weight(.semibold))
                        }
                        .disabled(model.isWorking)
                    }
                    Button {
                        Task { await model.resolve() }
                    } label: {
                        Label("Resolve", systemImage: "checkmark.seal.fill")
                    }
                    .disabled(model.isWorking)
                } footer: {
                    if alert.alertStatus == .open {
                        Text("Acknowledging stops escalation to the next person in the policy.")
                    }
                }
            }

            if let source = alert.source {
                Section("Source") {
                    if source.isMessage, let channelId = source.channelId {
                        NavigationLink(value: Route.channel(channelId)) {
                            Label("Open conversation", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                    if let patientId = source.patientId {
                        NavigationLink(value: Route.patient(patientId)) {
                            Label("Open patient", systemImage: "person.text.rectangle")
                        }
                    }
                    if source.isDeadline {
                        InfoRow(label: "Milestone", value: source.milestone?.label)
                        InfoRow(label: "Due", value: source.dueDate.map { ISODate.display($0) })
                    }
                    if source.type == "manual" && source.patientId == nil {
                        Text("Raised manually").foregroundStyle(.secondary)
                    }
                }
            }

            Section("Status") {
                LabeledContent("Escalation level", value: "\(alert.level ?? 0)")
                InfoRow(label: "Current recipients", value: org.names(for: alert.currentTargetUids ?? []))
                if let ackedBy = alert.ackedBy {
                    LabeledContent("Acknowledged by", value: org.name(for: ackedBy))
                    InfoRow(label: "Acknowledged at", value: alert.ackedAt.map { RelativeTime.full($0) })
                }
                InfoRow(label: "Raised by", value: alert.createdBy == "system" ? "System" : alert.createdBy.map { org.name(for: $0) })
            }

            let history = alert.history ?? []
            if !history.isEmpty {
                Section("History") {
                    ForEach(Array(history.enumerated()), id: \.offset) { _, event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Level \(event.level ?? 0) · \(RelativeTime.full(event.at))")
                                .font(.subheadline.weight(.semibold))
                            Text(org.names(for: event.targetUids ?? []))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}
