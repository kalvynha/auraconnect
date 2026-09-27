import SwiftUI

/// AI summary of recent messages in a channel (`summarizeChannel`). Never stored.
struct ChannelSummarySheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: AiTextRequestModel

    init(orgId: String, channelId: String) {
        _model = State(initialValue: AiTextRequestModel(sinceHours: 24) { hours in
            try await FunctionsClient().summarizeChannel(orgId: orgId, channelId: channelId, sinceHours: hours)
        })
    }

    var body: some View {
        NavigationStack {
            List {
                AiTextSections(model: model, generateTitle: "Summarize", shareSubject: "Conversation summary")
            }
            .navigationTitle("Summary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                if model.result == nil { await model.generate() }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
