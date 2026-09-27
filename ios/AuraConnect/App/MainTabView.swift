import SwiftUI

/// The signed-in, org-scoped app: five tabs, each with its own NavigationStack.
struct MainTabView: View {
    @Environment(Router.self) private var router
    @State private var org: OrgStore
    @State private var alerts: AlertsStore
    @State private var patientNames: PatientNameCache

    init(context: OrgContext) {
        _org = State(initialValue: OrgStore(context: context))
        _alerts = State(initialValue: AlertsStore(context: context))
        _patientNames = State(initialValue: PatientNameCache(orgId: context.orgId))
    }

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            NavigationStack(path: $router.todayPath) {
                TodayView()
                    .appRouteDestinations()
            }
            .tabItem { Label("Today", systemImage: "sun.max") }
            .tag(AppTab.today)

            NavigationStack(path: $router.inboxPath) {
                InboxView()
                    .appRouteDestinations()
            }
            .tabItem { Label("Inbox", systemImage: "bubble.left.and.bubble.right") }
            .tag(AppTab.inbox)

            NavigationStack(path: $router.patientsPath) {
                PatientListView()
                    .appRouteDestinations()
            }
            .tabItem { Label("Patients", systemImage: "person.text.rectangle") }
            .tag(AppTab.patients)

            NavigationStack(path: $router.alertsPath) {
                AlertsView()
                    .appRouteDestinations()
            }
            .tabItem { Label("Alerts", systemImage: "bell.badge") }
            .badge(alerts.openCount)
            .tag(AppTab.alerts)

            NavigationStack(path: $router.morePath) {
                MoreView()
                    .appRouteDestinations()
            }
            .tabItem { Label("More", systemImage: "ellipsis.circle") }
            .tag(AppTab.more)
        }
        .environment(org)
        .environment(alerts)
        .environment(patientNames)
        .task { await org.runMembers() }
        .task { await org.runOrg() }
        .task { await alerts.run() }
        .task {
            await PushTokenRegistrar.requestAuthorizationAndRegister()
        }
        .onChange(of: org.membersLoaded) { _, loaded in
            if loaded {
                PushTokenRegistrar.shared.attach(orgId: org.orgId, uid: org.uid, existingTokens: org.me?.fcmTokens)
            }
        }
        .onChange(of: router.pendingPush) { _, _ in
            router.consumePendingPush(orgId: org.orgId)
        }
        .onAppear {
            router.consumePendingPush(orgId: org.orgId)
        }
    }
}

extension View {
    /// Registers every `Route` destination; apply to the root view of each NavigationStack.
    func appRouteDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            RouteDestinationView(route: route)
        }
    }
}

struct RouteDestinationView: View {
    let route: Route

    var body: some View {
        switch route {
        case .channel(let id):
            ChatView(channelId: id)
        case .patient(let id):
            PatientDetailView(patientId: id)
        case .alert(let id):
            AlertDetailView(alertId: id)
        case .referral(let id):
            ReferralDetailView(referralId: id)
        case .referrals:
            ReferralsListView()
        case .members:
            MembersView()
        case .settings:
            SettingsView()
        case .messageThread(let channelId, let messageId):
            ThreadView(channelId: channelId, messageId: messageId)
        case .messageSearch:
            MessageSearchView()
        case .handoff:
            HandoffView()
        case .triage:
            TriageListView()
        case .triageCall(let id):
            TriageCallDetailView(callId: id)
        case .idgMeetings:
            IdgMeetingsView()
        case .idgMeeting(let id):
            IdgMeetingDetailView(meetingId: id)
        case .dashboard:
            DashboardView()
        case .myTasks:
            MyTasksView()
        case .myVisits:
            MyVisitsView()
        case .bereavement:
            BereavementListView()
        case .bereavementPlan(let id):
            BereavementPlanDetailView(planId: id)
        case .volunteers:
            VolunteerView()
        case .visit(let id):
            VisitDetailView(visitId: id)
        case .onCallSchedule:
            ScheduleView()
        }
    }
}
