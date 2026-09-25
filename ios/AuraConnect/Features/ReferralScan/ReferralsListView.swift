import SwiftUI
import Observation

@MainActor
@Observable
final class ReferralsViewModel {
    let orgId: String
    private(set) var referrals: [Referral] = []
    private(set) var isLoading = true
    var errorMessage: String?

    init(orgId: String) {
        self.orgId = orgId
    }

    struct QueueSection: Hashable {
        let title: String
        let statuses: [ReferralStatus]
    }

    /// Work queue order: things needing a person first.
    static let sectionOrder: [QueueSection] = [
        QueueSection(title: "Needs review", statuses: [.needsReview]),
        QueueSection(title: "Processing", statuses: [.uploaded, .extracting]),
        QueueSection(title: "Failed", statuses: [.failed]),
        QueueSection(title: "Accepted", statuses: [.accepted]),
        QueueSection(title: "Rejected", statuses: [.rejected]),
    ]

    func referrals(in statuses: [ReferralStatus]) -> [Referral] {
        referrals.filter { statuses.contains($0.referralStatus) }
    }

    func run() async {
        do {
            for try await list in ReferralRepository(orgId: orgId).referrals() {
                referrals = list
                isLoading = false
                errorMessage = nil
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }
}

struct ReferralsListView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        ReferralsListContent(orgId: org.orgId)
    }
}

private struct ReferralsListContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: ReferralsViewModel
    @State private var showScan = false

    init(orgId: String) {
        _model = State(initialValue: ReferralsViewModel(orgId: orgId))
    }

    var body: some View {
        List {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            ForEach(ReferralsViewModel.sectionOrder, id: \.title) { section in
                let items = model.referrals(in: section.statuses)
                if !items.isEmpty {
                    Section(section.title) {
                        ForEach(items) { referral in
                            if let id = referral.id {
                                NavigationLink(value: Route.referral(id)) {
                                    ReferralRow(referral: referral)
                                }
                            }
                        }
                    }
                }
            }
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.referrals.isEmpty && model.errorMessage == nil {
                ContentUnavailableView {
                    Label("No referrals", systemImage: "doc.viewfinder")
                } description: {
                    Text("Scan a referral packet to extract patient details automatically.")
                } actions: {
                    Button("Scan referral") { showScan = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Referrals")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showScan = true
                } label: {
                    Label("Scan referral", systemImage: "doc.viewfinder")
                }
            }
        }
        .sheet(isPresented: $showScan) {
            ReferralScanView { referralId in
                showScan = false
                router.push(.referral(referralId))
            }
            .environment(org)
        }
        .task { await model.run() }
    }
}

struct ReferralRow: View {
    let referral: Referral

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(referral.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                StatusPill(text: referral.referralStatus.label, color: referral.referralStatus.color)
            }
            HStack(spacing: 6) {
                if referral.referralStatus.isProcessing {
                    ProgressView().controlSize(.mini)
                }
                Text(RelativeTime.full(referral.createdAt))
                if let source = referral.extracted?.referralSource?.nilIfBlank {
                    Text("· \(source)").lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
