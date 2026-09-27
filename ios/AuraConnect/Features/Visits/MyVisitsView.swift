import SwiftUI
import Observation

@MainActor
@Observable
final class MyVisitsViewModel {
    enum Span: String, CaseIterable, Identifiable {
        case today = "Today"
        case week = "Next 7 days"
        case missed = "Missed"
        var id: String { rawValue }

        /// `[start, end)` for the `assignedUid` + `scheduledStart` query.
        func bounds(now: Date, calendar: Calendar = .current) -> (start: Date, end: Date) {
            let today = calendar.startOfDay(for: now)
            switch self {
            case .today:
                return (today, calendar.date(byAdding: .day, value: 1, to: today) ?? today.addingTimeInterval(86_400))
            case .week:
                return (today, calendar.date(byAdding: .day, value: 7, to: today) ?? today.addingTimeInterval(7 * 86_400))
            case .missed:
                // Missed visits from the last 7 days that still need (late) documentation.
                return (calendar.date(byAdding: .day, value: -7, to: today) ?? today.addingTimeInterval(-7 * 86_400), now)
            }
        }
    }

    let orgId: String
    let uid: String
    var range: Span = .today
    private(set) var visits: [Visit] = []
    private(set) var isLoading = true
    var completing: Visit?
    var cancelling: Visit?
    var rescheduling: Visit?
    var errorMessage: String?

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    /// Streams visits for the selected range that are assigned to me (server-side `assignedUid`
    /// filter). Restart when `range` changes.
    func run() async {
        isLoading = true
        let span = range
        let bounds = span.bounds(now: Date())
        do {
            for try await list in VisitRepository(orgId: orgId).visits(assignedTo: uid, from: bounds.start, to: bounds.end) {
                visits = span == .missed ? list.filter { $0.visitStatus == .missed } : list
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

/// "My Visits": visits assigned to me today, this week, or missed in the last week, with
/// complete (including late documentation of missed visits) / cancel.
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

    /// v3 (V4): these are my own visits, so the assignee rules apply (Aide/LPN viewers included).
    private func canComplete(_ visit: Visit) -> Bool { org.canComplete(visit: visit) }

    private var emptyDescription: String {
        switch model.range {
        case .today: return "You have no visits scheduled today."
        case .week: return "You have no visits in the next 7 days."
        case .missed: return "You have no missed visits in the last 7 days."
        }
    }

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
                ContentUnavailableView(model.range == .missed ? "No missed visits" : "No visits",
                                       systemImage: "calendar.badge.clock",
                                       description: Text(emptyDescription))
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
        .sheet(item: $model.rescheduling) { visit in
            RescheduleVisitView(visit: visit)
                .environment(org)
        }
        .task(id: model.range) { await model.run() }
    }

    @ViewBuilder
    private func row(_ visit: Visit) -> some View {
        let completable = canComplete(visit)
        let cancellable = org.canCancel(visit: visit)
        let reschedulable = org.canReschedule(visit: visit)
        Group {
            if let visitId = visit.id {
                NavigationLink(value: Route.visit(visitId)) {
                    VisitRow(visit: visit, showPatient: true)
                }
            } else if let patientId = visit.patientId?.nilIfBlank {
                NavigationLink(value: Route.patient(patientId)) {
                    VisitRow(visit: visit, showPatient: true)
                }
            } else {
                VisitRow(visit: visit, showPatient: true)
            }
        }
        .swipeActions(edge: .leading) {
            if completable {
                Button {
                    model.completing = visit
                } label: {
                    Label(visit.visitStatus == .missed ? "Document" : "Complete", systemImage: "checkmark")
                }
                .tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            if reschedulable {
                Button {
                    model.rescheduling = visit
                } label: {
                    Label("Reschedule", systemImage: "calendar.badge.clock")
                }
                .tint(.blue)
            }
            if cancellable {
                Button {
                    model.cancelling = visit
                } label: {
                    Label("Cancel", systemImage: "xmark")
                }
                .tint(.red)
            }
        }
        .contextMenu {
            if completable {
                Button {
                    model.completing = visit
                } label: {
                    Label(visit.visitStatus == .missed ? "Document missed visit" : "Complete visit",
                          systemImage: "checkmark.circle")
                }
            }
            if reschedulable {
                Button {
                    model.rescheduling = visit
                } label: {
                    Label("Reschedule", systemImage: "calendar.badge.clock")
                }
            }
            if cancellable {
                Button(role: .destructive) {
                    model.cancelling = visit
                } label: {
                    Label("Cancel visit", systemImage: "xmark.circle")
                }
            }
        }
    }
}
