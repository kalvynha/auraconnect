import SwiftUI

// Colors, symbols and small shared views for the v2 care workflows
// (visits, tasks, bereavement, documents, timeline, volunteers).

extension VisitStatus {
    var color: Color {
        switch self {
        case .scheduled: return .blue
        case .completed: return .green
        case .missed: return .red
        case .cancelled: return .secondary
        }
    }
}

extension TaskStatus {
    var color: Color {
        switch self {
        case .open: return .blue
        case .done: return .green
        case .cancelled: return .secondary
        }
    }
}

extension BereavementContactStatus {
    var color: Color {
        switch self {
        case .pending: return .blue
        case .done: return .green
        case .skipped: return .secondary
        }
    }
}

extension BereavementContactType {
    var symbol: String {
        switch self {
        case .call: return "phone"
        case .letter: return "envelope"
        case .visit: return "house"
        case .mailing: return "mail.stack"
        }
    }
}

extension BereavementRisk {
    var color: Color {
        switch self {
        case .low: return .green
        case .moderate: return .orange
        case .high: return .red
        }
    }
}

extension PatientEventType {
    var symbol: String {
        switch self {
        case .admission: return "person.badge.plus"
        case .levelOfCareChange: return "arrow.left.arrow.right"
        case .recertification: return "checkmark.seal"
        case .discharge: return "figure.walk.departure"
        case .death: return "leaf"
        case .other: return "circle"
        }
    }

    var color: Color {
        switch self {
        case .admission: return .green
        case .levelOfCareChange: return .orange
        case .recertification: return .blue
        case .discharge: return .secondary
        case .death: return .purple
        case .other: return .secondary
        }
    }
}

extension DocumentCategory {
    var symbol: String {
        switch self {
        case .consent: return "signature"
        case .polst: return "cross.case"
        case .order: return "list.clipboard"
        case .referral: return "doc.viewfinder"
        case .planOfCare: return "heart.text.square"
        case .other: return "doc"
        }
    }
}

extension DueBucket {
    var color: Color {
        switch self {
        case .overdue: return .red
        case .today: return .orange
        default: return .primary
        }
    }
}

/// Picker over org members with a "none" option. Selection is a member uid or nil.
struct CareMemberPicker: View {
    let title: String
    @Binding var selection: String?
    let members: [Member]
    var noneLabel: String = "Unassigned"

    var body: some View {
        Picker(title, selection: $selection) {
            Text(noneLabel).tag(String?.none)
            ForEach(members, id: \.memberUid) { member in
                Text(member.subtitle.isEmpty ? member.name : "\(member.name) (\(member.subtitle))")
                    .tag(String?.some(member.memberUid))
            }
        }
    }
}

/// A "Save"-style toolbar button that shows a spinner while `isWorking`.
struct CareSubmitButton: View {
    let title: String
    let isWorking: Bool
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        if isWorking {
            ProgressView()
        } else {
            Button(title, action: action)
                .bold()
                .disabled(!isEnabled)
        }
    }
}
