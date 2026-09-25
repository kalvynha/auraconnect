import SwiftUI

extension Priority {
    var color: Color {
        switch self {
        case .normal: return .secondary
        case .urgent: return .orange
        case .critical: return .red
        }
    }

    var symbol: String {
        switch self {
        case .normal: return "bubble.left"
        case .urgent: return "exclamationmark.circle.fill"
        case .critical: return "exclamationmark.triangle.fill"
        }
    }
}

extension MilestoneStatus {
    var color: Color {
        switch self {
        case .overdue: return .red
        case .dueSoon: return .orange
        case .upcoming: return .green
        }
    }

    var symbol: String {
        switch self {
        case .overdue: return "exclamationmark.octagon.fill"
        case .dueSoon: return "clock.badge.exclamationmark"
        case .upcoming: return "checkmark.circle"
        }
    }
}

extension AlertStatus {
    var color: Color {
        switch self {
        case .open: return .red
        case .acked: return .orange
        case .resolved: return .green
        }
    }
}

extension ReferralStatus {
    var color: Color {
        switch self {
        case .uploaded, .extracting: return .blue
        case .needsReview: return .orange
        case .accepted: return .green
        case .rejected: return .secondary
        case .failed: return .red
        }
    }
}

extension PatientStatus {
    var color: Color {
        switch self {
        case .referral: return .blue
        case .admitted: return .green
        case .discharged: return .secondary
        case .deceased: return .purple
        }
    }
}

/// Small capsule label ("Urgent", "Needs review", …).
struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: Capsule())
            .accessibilityLabel(text)
    }
}

/// Priority badge; renders nothing for normal priority unless `showNormal`.
struct PriorityBadge: View {
    let priority: Priority
    var showNormal = false

    var body: some View {
        if priority != .normal || showNormal {
            Label(priority.label, systemImage: priority.symbol)
                .font(.caption.weight(.bold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(priority == .normal ? Color.secondary : Color.white)
                .background(priority == .normal ? Color.secondary.opacity(0.15) : priority.color, in: Capsule())
                .accessibilityLabel("\(priority.label) priority")
        }
    }
}

/// Initials avatar.
struct AvatarView: View {
    let initials: String
    var size: CGFloat = 36

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(width: size, height: size)
            .background(Color.accentColor.opacity(0.15), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Inline error message used at the top of forms and lists.
struct ErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Label/value row that hides itself when the value is blank.
struct InfoRow: View {
    let label: String
    let value: String?

    var body: some View {
        if let value = value?.nilIfBlank {
            LabeledContent(label) {
                Text(value)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
            }
        }
    }
}

/// Text field row for forms with an optional low-confidence highlight (referral review).
struct FormTextField: View {
    let title: String
    @Binding var text: String
    var confidence: Double? = nil
    var keyboard: UIKeyboardType = .default
    var capitalization: TextInputAutocapitalization = .words

    private var isLow: Bool { ConfidenceLookup.isLow(confidence) }

    var body: some View {
        HStack(spacing: 8) {
            TextField(title, text: $text, prompt: Text(title))
                .keyboardType(keyboard)
                .textInputAutocapitalization(capitalization)
                .autocorrectionDisabled()
            if isLow {
                LowConfidenceIcon(confidence: confidence)
            }
        }
        .listRowBackground(isLow ? Color.orange.opacity(0.15) : nil)
    }
}

struct LowConfidenceIcon: View {
    let confidence: Double?

    var body: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
            .accessibilityLabel("Low confidence \(Int(((confidence ?? 0) * 100).rounded())) percent, please verify")
    }
}

extension View {
    /// Highlights a form row when the extraction confidence is below the threshold.
    func lowConfidenceHighlight(_ confidence: Double?) -> some View {
        listRowBackground(ConfidenceLookup.isLow(confidence) ? Color.orange.opacity(0.15) : nil)
    }
}
