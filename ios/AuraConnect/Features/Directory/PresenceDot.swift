import SwiftUI

extension PresenceState {
    var color: Color {
        switch self {
        case .available: return .green
        case .inVisit: return .blue
        case .busy: return .red
        case .off: return .gray
        }
    }

    var symbol: String {
        switch self {
        case .available: return "checkmark.circle.fill"
        case .inVisit: return "house.fill"
        case .busy: return "minus.circle.fill"
        case .off: return "moon.fill"
        }
    }
}

/// Small colored presence dot (v4 `member.status.state`). A nil state (no status set, or it
/// expired) draws a hollow gray ring. Reusable anywhere a member is shown:
///
///     PresenceDot(state: member.presence())
///     PresenceDot(member: org.members[uid])
struct PresenceDot: View {
    let state: PresenceState?
    var size: CGFloat = 10
    /// Adds a ring in the background color so the dot reads on top of an avatar.
    var outlined = false

    init(state: PresenceState?, size: CGFloat = 10, outlined: Bool = false) {
        self.state = state
        self.size = size
        self.outlined = outlined
    }

    /// Uses the member's current (unexpired) status.
    init(member: Member?, now: Date = Date(), size: CGFloat = 10, outlined: Bool = false) {
        self.init(state: member?.presence(at: now), size: size, outlined: outlined)
    }

    var body: some View {
        Group {
            if let state {
                Circle().fill(state.color)
            } else {
                Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: max(1, size / 6))
            }
        }
        .frame(width: size, height: size)
        .overlay {
            if outlined {
                Circle().strokeBorder(Color(uiColor: .systemBackground), lineWidth: max(1.5, size / 5))
                    .frame(width: size + size / 2.5, height: size + size / 2.5)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(state?.label ?? "No status")
    }
}

/// Initials avatar with a presence dot in the bottom-right corner.
struct PresenceAvatar: View {
    let member: Member?
    var size: CGFloat = 36
    var now: Date = Date()

    var body: some View {
        AvatarView(initials: member?.initials ?? "?", size: size)
            .overlay(alignment: .bottomTrailing) {
                PresenceDot(member: member, now: now, size: max(8, size * 0.28), outlined: true)
            }
    }
}
