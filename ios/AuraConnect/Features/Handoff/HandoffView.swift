import SwiftUI

/// AI shift handoff for my care-team patients (`generateHandoff`). Never stored.
struct HandoffView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        HandoffContent(orgId: org.orgId)
    }
}

private struct HandoffContent: View {
    @State private var model: AiTextRequestModel

    init(orgId: String) {
        _model = State(initialValue: AiTextRequestModel(sinceHours: 12) { hours in
            try await FunctionsClient().generateHandoff(orgId: orgId, sinceHours: hours)
        })
    }

    var body: some View {
        List {
            Section {
                Text("Summarizes the last few hours of messages, triage calls, visits, open tasks and due deadlines for patients on your care teams.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            AiTextSections(model: model, generateTitle: "Generate handoff", shareSubject: "Shift handoff")
        }
        .navigationTitle("Shift handoff")
        .navigationBarTitleDisplayMode(.inline)
    }
}
