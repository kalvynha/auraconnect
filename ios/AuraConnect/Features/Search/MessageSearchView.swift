import SwiftUI
import Observation

@MainActor
@Observable
final class MessageSearchViewModel {
    let orgId: String
    var query = ""
    private(set) var hits: [MessageSearchHit] = []
    private(set) var truncated = false
    private(set) var searchedQuery: String?
    private(set) var isSearching = false
    var errorMessage: String?

    init(orgId: String) {
        self.orgId = orgId
    }

    var canSearch: Bool {
        guard let text = query.nilIfBlank else { return false }
        return text.count >= 2 && !isSearching
    }

    func search() async {
        guard canSearch, let text = query.nilIfBlank else { return }
        isSearching = true
        errorMessage = nil
        defer { isSearching = false }
        do {
            let result = try await FunctionsClient().searchMessages(orgId: orgId, query: text)
            hits = result.hits
            truncated = result.truncated
            searchedQuery = text
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Searches message text across my conversations (`searchMessages`). Tapping a hit opens the chat.
struct MessageSearchView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        MessageSearchContent(orgId: org.orgId)
    }
}

private struct MessageSearchContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: MessageSearchViewModel

    init(orgId: String) {
        _model = State(initialValue: MessageSearchViewModel(orgId: orgId))
    }

    private var resultCountText: String {
        model.hits.count == 1 ? "1 result" : "\(model.hits.count) results"
    }

    private var footerText: String {
        model.truncated
            ? "Showing the first matches only. Refine your search to narrow the results."
            : "Matches exact text in the last 90 days of your active conversations. This is not full-text search."
    }

    var body: some View {
        @Bindable var model = model
        List {
            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }
            if let searched = model.searchedQuery {
                Section {
                    ForEach(model.hits) { hit in
                        NavigationLink(value: Route.channel(hit.channelId)) {
                            MessageSearchRow(hit: hit, query: searched)
                        }
                    }
                } header: {
                    Text(resultCountText)
                } footer: {
                    Text(footerText)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if model.isSearching {
                ProgressView()
            } else if let searched = model.searchedQuery, model.hits.isEmpty, model.errorMessage == nil {
                ContentUnavailableView.search(text: searched)
            } else if model.searchedQuery == nil {
                ContentUnavailableView("Search messages",
                                       systemImage: "text.magnifyingglass",
                                       description: Text("Find text in messages from the last 90 days."))
            }
        }
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search message text")
        .onSubmit(of: .search) {
            Task { await model.search() }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .navigationTitle("Search messages")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct MessageSearchRow: View {
    @Environment(OrgStore.self) private var org
    let hit: MessageSearchHit
    let query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(hit.channelName ?? "Conversation")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(RelativeTime.short(hit.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(hit.senderName.nilIfBlank ?? "Unknown sender")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(highlighted)
                .font(.subheadline)
                .lineLimit(3)
        }
        .padding(.vertical, 2)
    }

    /// The snippet with the first occurrence of the query in bold.
    private var highlighted: AttributedString {
        var text = AttributedString(hit.snippet)
        if let range = text.range(of: query, options: .caseInsensitive) {
            text[range].inlinePresentationIntent = .stronglyEmphasized
        }
        return text
    }
}
