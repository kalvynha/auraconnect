import SwiftUI
import Observation

@MainActor
@Observable
final class DashboardViewModel {
    let orgId: String
    private(set) var metrics: DailyMetrics?
    private(set) var isLoading = true
    private(set) var isRefreshing = false
    var errorMessage: String?

    init(orgId: String) {
        self.orgId = orgId
    }

    func run() async {
        do {
            for try await list in MetricsRepository(orgId: orgId).latest() {
                metrics = list.first
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// `computeMetrics` writes `metrics/{today}`; the listener picks it up.
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        errorMessage = nil
        defer { isRefreshing = false }
        do {
            try await FunctionsClient().computeMetrics(orgId: orgId)
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Admin dashboard: the latest `metrics/{date}` document as stat cards.
struct DashboardView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        DashboardContent(orgId: org.orgId)
    }
}

private struct DashboardContent: View {
    @State private var model: DashboardViewModel

    init(orgId: String) {
        _model = State(initialValue: DashboardViewModel(orgId: orgId))
    }

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
                if let metrics = model.metrics {
                    content(metrics)
                } else if !model.isLoading {
                    ContentUnavailableView {
                        Label("No metrics yet", systemImage: "chart.bar")
                    } description: {
                        Text("Metrics are computed nightly. Tap Refresh to compute today's numbers now.")
                    }
                }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .overlay {
            if model.isLoading { ProgressView() }
        }
        .navigationTitle("Dashboard")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if model.isRefreshing {
                    ProgressView()
                } else {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
        }
        .refreshable { await model.refresh() }
        .task { await model.run() }
    }

    @ViewBuilder
    private func content(_ m: DailyMetrics) -> some View {
        Text("For \(ISODate.display(m.date)) · computed \(RelativeTime.full(m.computedAt))")
            .font(.caption)
            .foregroundStyle(.secondary)

        DashboardSection(title: "Census") {
            LazyVGrid(columns: columns, spacing: 12) {
                StatCard(title: "Admitted", value: count(m.census?.admitted), systemImage: "person.fill.checkmark")
                StatCard(title: "Referrals", value: count(m.census?.referral), systemImage: "tray.full")
                StatCard(title: "Discharged today", value: count(m.census?.dischargedToday), systemImage: "arrow.right.circle")
                StatCard(title: "Deaths today", value: count(m.census?.deathsToday), systemImage: "heart")
            }
        }

        DashboardSection(title: "Level of care") {
            VStack(spacing: 0) {
                ForEach(LevelOfCare.allCases) { level in
                    let value = m.levelOfCare?[level.rawValue] ?? 0
                    HStack {
                        Text(level.label)
                        Spacer()
                        Text(count(value)).font(.body.monospacedDigit().weight(.semibold))
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 14)
                    if level != LevelOfCare.allCases.last {
                        Divider().padding(.leading, 14)
                    }
                }
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        }

        DashboardSection(title: "Alerts & deadlines") {
            LazyVGrid(columns: columns, spacing: 12) {
                StatCard(title: "Median alert ack", value: minutes(m.alerts?.medianAckMinutes), systemImage: "bell.badge",
                         detail: "\(count(m.alerts?.acked)) of \(count(m.alerts?.created)) acknowledged")
                StatCard(title: "Escalations exhausted", value: count(m.alerts?.exhausted), systemImage: "exclamationmark.octagon",
                         status: (m.alerts?.exhausted ?? 0) > 0 ? .warning : nil)
                StatCard(title: "Deadline compliance", value: percent(m.deadlines?.completedOnTime30d, of: total(m.deadlines?.completedOnTime30d, m.deadlines?.completedLate30d)),
                         systemImage: "calendar.badge.checkmark",
                         detail: "On time, last 30 days")
                StatCard(title: "Deadlines overdue", value: count(m.deadlines?.overdue), systemImage: "calendar.badge.exclamationmark",
                         detail: "\(count(m.deadlines?.dueNext7Days)) due in 7 days",
                         status: (m.deadlines?.overdue ?? 0) > 0 ? .critical : nil)
            }
        }

        DashboardSection(title: "Visits & triage") {
            LazyVGrid(columns: columns, spacing: 12) {
                StatCard(title: "Visit completion", value: percent(m.visits?.completed, of: total(m.visits?.completed, m.visits?.missed)),
                         systemImage: "house",
                         detail: "\(count(m.visits?.completed)) done · \(count(m.visits?.missed)) missed")
                StatCard(title: "Visits scheduled", value: count(m.visits?.scheduled), systemImage: "calendar",
                         detail: "\(count(m.visits?.cancelled)) cancelled")
                StatCard(title: "Triage calls", value: count(m.triage?.calls), systemImage: "phone",
                         detail: "\(count(m.triage?.emergent)) emergent")
                StatCard(title: "Median triage resolve", value: minutes(m.triage?.medianResolveMinutes), systemImage: "timer")
            }
        }

        DashboardSection(title: "Volunteers & bereavement") {
            LazyVGrid(columns: columns, spacing: 12) {
                StatCard(title: "Volunteer hours", value: hours(m.volunteers?.minutesLast30d), systemImage: "hands.sparkles",
                         detail: "Last 30 days · \(count(m.volunteers?.activeAssignments)) active assignments")
                StatCard(title: "Bereavement plans", value: count(m.bereavement?.activePlans), systemImage: "leaf")
                StatCard(title: "Contacts due", value: count(m.bereavement?.contactsDueNext7Days), systemImage: "envelope",
                         detail: "Next 7 days")
                StatCard(title: "Contacts overdue", value: count(m.bereavement?.contactsOverdue), systemImage: "envelope.badge",
                         status: (m.bereavement?.contactsOverdue ?? 0) > 0 ? .critical : nil)
            }
        }
    }

    // MARK: Formatting

    private func count(_ value: Double?) -> String {
        guard let value else { return "—" }
        return Int(value.rounded()).formatted()
    }

    private func total(_ a: Double?, _ b: Double?) -> Double? {
        guard a != nil || b != nil else { return nil }
        return (a ?? 0) + (b ?? 0)
    }

    private func percent(_ part: Double?, of whole: Double?) -> String {
        guard let part, let whole, whole > 0 else { return "—" }
        return "\(Int((part / whole * 100).rounded()))%"
    }

    private func minutes(_ value: Double?) -> String {
        guard let value else { return "—" }
        if value >= 120 { return String(format: "%.1f h", value / 60) }
        return "\(Int(value.rounded())) min"
    }

    private func hours(_ minutes: Double?) -> String {
        guard let minutes else { return "—" }
        return String(format: "%.1f h", minutes / 60)
    }
}

private struct DashboardSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content
        }
    }
}

/// A single headline number. Status color is only used with its icon and a label.
private struct StatCard: View {
    enum Status {
        case warning, critical

        var color: Color { self == .critical ? .red : .orange }
        var label: String { self == .critical ? "Needs attention" : "Review" }
    }

    let title: String
    let value: String
    let systemImage: String
    var detail: String? = nil
    var status: Status? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Text(value)
                .font(.title2.weight(.bold).monospacedDigit())
                .foregroundStyle(Color.primary)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let status {
                Label(status.label, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(status.color)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}
