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

            if org.role.canManageReferrals {
                Section("Intake") {
                    NavigationLink(value: Route.referrals) {
                        Label("Referrals", systemImage: "doc.viewfinder")
                    }
                }
            }

            if org.role == .admin {
                Section("Organization") {
                    NavigationLink(value: Route.members) {
                        Label("Members", systemImage: "person.2")
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
