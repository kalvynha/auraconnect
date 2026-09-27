import SwiftUI
import Observation

extension TriageUrgency {
    var color: Color {
        switch self {
        case .routine: return .blue
        case .urgent: return .orange
        case .emergent: return .red
        }
    }

    var symbol: String {
        switch self {
        case .routine: return "phone"
        case .urgent: return "exclamationmark.circle.fill"
        case .emergent: return "exclamationmark.triangle.fill"
        }
    }
}

@MainActor
@Observable
final class TriageListViewModel {
    let orgId: String
    private(set) var calls: [TriageCall] = []
    private(set) var isLoading = true
    var errorMessage: String?

    init(orgId: String) {
        self.orgId = orgId
    }

    /// Open calls, most urgent first, then newest.
    var openCalls: [TriageCall] {
        calls.filter { $0.isOpen }.sorted { a, b in
            if a.callUrgency.severity != b.callUrgency.severity {
                return a.callUrgency.severity > b.callUrgency.severity
            }
            return (a.receivedAt ?? .distantPast) > (b.receivedAt ?? .distantPast)
        }
    }

    var resolvedCalls: [TriageCall] {
        Array(calls.filter { !$0.isOpen }.prefix(30))
    }

    func run() async {
        do {
            for try await list in TriageRepository(orgId: orgId).recentCalls() {
                calls = list
                isLoading = false
                errorMessage = nil
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }
}

/// After-hours triage: open calls and "Log call".
struct TriageListView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        TriageListContent(orgId: org.orgId)
    }
}

private struct TriageListContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: TriageListViewModel
    @State private var showLogCall = false

    init(orgId: String) {
        _model = State(initialValue: TriageListViewModel(orgId: orgId))
    }

    /// Triage mutations require a clinical role (admin, clinician, intake).
    private var canLog: Bool { org.role.canManageReferrals }

    var body: some View {
        List {
            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }
            Section("Open") {
                if model.openCalls.isEmpty && !model.isLoading {
                    Text("No open calls.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.openCalls) { call in
                    if let id = call.id {
                        NavigationLink(value: Route.triageCall(id)) {
                            TriageCallRow(call: call)
                        }
                    }
                }
            }
            if !model.resolvedCalls.isEmpty {
                Section("Recently resolved") {
                    ForEach(model.resolvedCalls) { call in
                        if let id = call.id {
                            NavigationLink(value: Route.triageCall(id)) {
                                TriageCallRow(call: call)
                            }
                        }
                    }
                }
            }
        }
        .overlay {
            if model.isLoading { ProgressView() }
        }
        .navigationTitle("Triage")
        .toolbar {
            if canLog {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showLogCall = true
                    } label: {
                        Label("Log call", systemImage: "phone.badge.plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showLogCall) {
            LogTriageCallView { callId in
                showLogCall = false
                router.push(.triageCall(callId))
            }
            .environment(org)
        }
        .task { await model.run() }
    }
}

struct TriageCallRow: View {
    @Environment(OrgStore.self) private var org
    let call: TriageCall

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                StatusPill(text: call.callUrgency.label, color: call.callUrgency.color)
                Text(call.patientName?.nilIfBlank ?? call.displayCaller)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(RelativeTime.short(call.receivedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reason = call.reason?.nilIfBlank {
                Text(reason)
                    .font(.subheadline)
                    .lineLimit(2)
            }
            Text(call.isOpen
                 ? (call.assignedUid.map { "Assigned to \(org.name(for: $0))" } ?? "Unassigned")
                 : (call.disposition?.label ?? "Resolved"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
