import SwiftUI

/// AI shift handoff (`generateHandoff`). Never stored.
/// O4: covers my care team (default) or my own overnight activity (triage calls I took or was
/// assigned, visits I completed, and calls not linked to a patient).
struct HandoffView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        HandoffContent(orgId: org.orgId)
    }
}

/// Holds the scope the request closure reads (the closure is created once, in `init`).
private final class HandoffScopeBox {
    var scope: HandoffScope = .careTeam
}

private struct HandoffContent: View {
    @State private var model: AiTextRequestModel
    @State private var box: HandoffScopeBox
    @State private var scope: HandoffScope = .careTeam

    init(orgId: String) {
        let box = HandoffScopeBox()
        _box = State(initialValue: box)
        _model = State(initialValue: AiTextRequestModel(sinceHours: 12) { hours in
            try await FunctionsClient().generateHandoff(orgId: orgId, sinceHours: hours, scope: box.scope, patientIds: nil)
        })
    }

    var body: some View {
        List {
            Section {
                Picker("Cover", selection: $scope) {
                    ForEach(HandoffScope.allCases) { value in
                        Text(value.label).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                Text(scope == .careTeam
                     ? "Summarizes the last few hours of messages, triage calls, visits, timeline events, open tasks and due deadlines for patients on your care teams, including any who died or were discharged in that time."
                     : "Summarizes your own overnight activity: patients from triage calls you took or were assigned, visits you completed, and calls not linked to a patient.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            AiTextSections(model: model, generateTitle: "Generate handoff", shareSubject: "Shift handoff")
        }
        .navigationTitle("Shift handoff")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: scope) { _, value in
            box.scope = value
        }
    }
}
