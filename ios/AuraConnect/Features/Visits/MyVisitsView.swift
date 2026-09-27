import SwiftUI
import Observation

@MainActor
@Observable
final class MyVisitsViewModel {
    enum Span: String, CaseIterable, Identifiable {
        case today = "Today"
        case week = "Next 7 days"
        var id: String { rawValue }

        var days: Int { self == .today ? 1 : 7 }
    }

    let orgId: String
    let uid: String
    var range: Span = .today
    private(set) var visits: [Visit] = []
    private(set) var isLoading = true
    var completing: Visit?
    var cancelling: Visit?
    var errorMessage: String?

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    /// Streams visits for the selected range that are assigned to me. Restart when `range` changes.
    func run() async {
        isLoading = true
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: Date())
        let end = calendar.date(byAdding: .day, value: range.days, to: start) ?? start.addingTimeInterval(86_400)
        do {
            for try await list in VisitRepository(orgId: orgId).visits(from: start, to: end) {
                visits = list.filter { $0.assignedUid == uid }
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Visits grouped by calendar day, in time order.
    var days: [VisitDay] {
        let calendar = Calendar.current
        let groups = Dictionary(grouping: visits) { visit in
            calendar.startOfDay(for: visit.scheduledStart ?? .distantPast)
        }
        return groups.keys.sorted().map { day in
            let items = (groups[day] ?? []).sorted { ($0.scheduledStart ?? .distantPast) < ($1.scheduledStart ?? .distantPast) }
            return VisitDay(day: day, visits: items)
        }
    }
}

struct VisitDay: Identifiable {
    let day: Date
    let visits: [Visit]
    var id: Date { day }

    var title: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "Today" }
        if calendar.isDateInTomorrow(day) { return "Tomorrow" }
        return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

/// "My Visits": visits assigned to me today or this week, with complete / cancel.
struct MyVisitsView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        MyVisitsContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct MyVisitsContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: MyVisitsViewModel

    init(orgId: String, uid: String) {
        _model = State(initialValue: MyVisitsViewModel(orgId: orgId, uid: uid))
    }

    private var canAct: Bool { org.role.canManageCare }

    var body: some View {
        @Bindable var model = model
        let days = model.days
        List {
            Section {
                Picker("Range", selection: $model.range) {
                    ForEach(MyVisitsViewModel.Span.allCases) { range in
                        Text(range.rawValue).tag(range)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            ForEach(days) { day in
                Section(day.title) {
                    ForEach(day.visits) { visit in
                        row(visit)
                    }
                }
            }
        }
        .overlay {
            if model.isLoading && model.visits.isEmpty {
                ProgressView()
            } else if model.visits.isEmpty {
                ContentUnavailableView("No visits",
                                       systemImage: "calendar.badge.clock",
                                       description: Text(model.range == .today
                                                         ? "You have no visits scheduled today."
                                                         : "You have no visits in the next 7 days."))
            }
        }
        .navigationTitle("My Visits")
        .sheet(item: $model.completing) { visit in
            CompleteVisitView(visit: visit)
                .environment(org)
        }
        .sheet(item: $model.cancelling) { visit in
            CancelVisitView(visit: visit)
                .environment(org)
        }
        .task(id: model.range) { await model.run() }
    }

    @ViewBuilder
    private func row(_ visit: Visit) -> some View {
        let actionable = canAct && visit.visitStatus == .scheduled
        Group {
            if let patientId = visit.patientId?.nilIfBlank {
                NavigationLink(value: Route.patient(patientId)) {
                    VisitRow(visit: visit, showPatient: true)
                }
            } else {
                VisitRow(visit: visit, showPatient: true)
            }
        }
        .swipeActions(edge: .leading) {
            if actionable {
                Button {
                    model.completing = visit
                } label: {
                    Label("Complete", systemImage: "checkmark")
                }
                .tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            if actionable {
                Button {
                    model.cancelling = visit
                } label: {
                    Label("Cancel", systemImage: "xmark")
                }
                .tint(.red)
            }
        }
        .contextMenu {
            if actionable {
                Button {
                    model.completing = visit
                } label: {
                    Label("Complete visit", systemImage: "checkmark.circle")
                }
                Button(role: .destructive) {
                    model.cancelling = visit
                } label: {
                    Label("Cancel visit", systemImage: "xmark.circle")
                }
            }
        }
    }
}
