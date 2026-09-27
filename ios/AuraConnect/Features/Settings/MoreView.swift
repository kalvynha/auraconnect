import SwiftUI

struct MoreView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    AvatarView(initials: org.me?.initials ?? "?", size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(org.me?.name ?? org.myName).font(.headline)
                        Text([org.role.label, org.org?.name].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Care") {
                NavigationLink(value: Route.myTasks) {
                    Label("My Tasks", systemImage: "checklist")
                }
                NavigationLink(value: Route.myVisits) {
                    Label("My Visits", systemImage: "calendar.badge.clock")
                }
                NavigationLink(value: Route.bereavement) {
                    Label("Bereavement", systemImage: "heart.circle")
                }
                NavigationLink(value: Route.volunteers) {
                    Label("Volunteering", systemImage: "hands.sparkles")
                }
            }

            if org.role.canManageReferrals {
                Section("Intake") {
                    NavigationLink(value: Route.referrals) {
                        Label("Referrals", systemImage: "doc.viewfinder")
                    }
                }
            }

            Section("Coordination") {
                NavigationLink(value: Route.onCallSchedule) {
                    Label("On-call schedule", systemImage: "calendar")
                }
                NavigationLink(value: Route.triage) {
                    Label("Triage calls", systemImage: "phone.arrow.down.left")
                }
                NavigationLink(value: Route.idgMeetings) {
                    Label("IDG meetings", systemImage: "person.3")
                }
                NavigationLink(value: Route.handoff) {
                    Label("Shift handoff", systemImage: "arrow.left.arrow.right.square")
                }
            }

            if org.role == .admin {
                Section("Organization") {
                    NavigationLink(value: Route.members) {
                        Label("Members", systemImage: "person.2")
                    }
                    NavigationLink(value: Route.dashboard) {
                        Label("Dashboard", systemImage: "chart.bar.xaxis")
                    }
                }
            }

            Section {
                NavigationLink(value: Route.settings) {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
        .navigationTitle("More")
    }
}
