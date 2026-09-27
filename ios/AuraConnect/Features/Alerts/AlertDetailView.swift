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
    @State private var resolvingCallId: String?

    private func triageCallId(_ alert: AuraAlert) -> String? {
        guard alert.source?.type == "triage" else { return nil }
        return alert.source?.callId?.nilIfBlank
    }

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
        .sheet(item: Binding(
            get: { resolvingCallId.map { IdentifiedCallId(id: $0) } },
            set: { resolvingCallId = $0?.id }
        )) { item in
            TriageResolveFromAlertSheet(orgId: model.orgId, callId: item.id) {
                await model.resolve()
            }
            .environment(org)
        }
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
                            // L4: no system text selection on PHI; copy is local-only and expires.
                            .contextMenu {
                                Button {
                                    SecurePasteboard.copy(text)
                                } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                            }
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
                    if let callId = triageCallId(alert) {
                        // O3: resolving a triage alert means resolving the call (disposition, visit, follow-up).
                        Button {
                            resolvingCallId = callId
                        } label: {
                            Label("Resolve call…", systemImage: "checkmark.seal.fill")
                        }
                        .disabled(model.isWorking)
                    } else {
                        Button {
                            Task { await model.resolve() }
                        } label: {
                            Label("Resolve", systemImage: "checkmark.seal.fill")
                        }
                        .disabled(model.isWorking)
                    }
                } footer: {
                    if alert.alertStatus == .open {
                        Text("Acknowledging stops escalation to the next person in the policy.")
                    }
                }
            }

            if let source = alert.source {
                Section("Source") {
                    if source.type == "triage", let callId = source.callId {
                        NavigationLink(value: Route.triageCall(callId)) {
                            Label("Open triage call", systemImage: "phone.arrow.down.left")
                        }
                    }
                    if source.isMessage, let channelId = source.channelId {
                        NavigationLink(value: Route.channel(channelId)) {
                            Label("Open conversation", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                    if let visitId = source.visitId?.nilIfBlank {
                        NavigationLink(value: Route.visit(visitId)) {
                            Label("Open visit", systemImage: "calendar.badge.clock")
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

private struct IdentifiedCallId: Identifiable {
    let id: String
}

/// O3: loads the triage call behind an alert and shows its resolve form. If the call is already
/// resolved (or unavailable), the alert itself is resolved instead.
private struct TriageResolveFromAlertSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: TriageCallDetailViewModel
    /// Keeps the form up once shown, so the call turning "resolved" on submit doesn't swap the view.
    @State private var showedForm = false
    let resolveAlertOnly: () async -> Void

    init(orgId: String, callId: String, resolveAlertOnly: @escaping () async -> Void) {
        _model = State(initialValue: TriageCallDetailViewModel(orgId: orgId, callId: callId))
        self.resolveAlertOnly = resolveAlertOnly
    }

    var body: some View {
        Group {
            if let call = model.call, call.isOpen || showedForm {
                TriageResolveSheet(model: model)
                    .onAppear { showedForm = true }
            } else if model.isLoading {
                ProgressView()
            } else {
                NavigationStack {
                    ContentUnavailableView {
                        Label("Call already resolved", systemImage: "checkmark.seal")
                    } description: {
                        Text("The triage call is resolved or unavailable. Resolve just the alert?")
                    } actions: {
                        Button("Resolve alert") {
                            Task {
                                await resolveAlertOnly()
                                dismiss()
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Cancel") { dismiss() }
                    }
                }
            }
        }
        .task { await model.run() }
    }
}
