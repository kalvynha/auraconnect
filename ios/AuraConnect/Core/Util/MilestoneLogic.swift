import Foundation

enum MilestoneStatus: Hashable {
    case overdue
    case dueSoon
    case upcoming

    var label: String {
        switch self {
        case .overdue: return "Overdue"
        case .dueSoon: return "Due soon"
        case .upcoming: return "On track"
        }
    }
}

struct MilestoneItem: Identifiable, Hashable {
    var id: String
    var kind: MilestoneKind
    var title: String
    /// `YYYY-MM-DD` the milestone must be completed by.
    var dueDate: String
    /// Optional window start for windowed milestones (HOPE HUVs, F2F).
    var windowStart: String?
    var status: MilestoneStatus
}

/// Client-side classification of the server-computed hospice milestones
/// (rules live in `functions/src/domain/milestones.ts`).
enum MilestoneLogic {
    /// Overdue if the due day has passed, due soon if within `leadDays` (inclusive), else upcoming.
    static func status(dueDate: String, today: Date, leadDays: Int, calendar: Calendar = .current) -> MilestoneStatus {
        guard let days = ISODate.daysFrom(today, to: dueDate, calendar: calendar) else { return .upcoming }
        if days < 0 { return .overdue }
        if days <= leadDays { return .dueSoon }
        return .upcoming
    }

    /// Flattens `Milestones` into a list sorted by due date. Benefit periods that ended more than
    /// `pastPeriodCutoffDays` ago are omitted (they are historical, not actionable).
    static func items(
        for milestones: Milestones,
        today: Date,
        leadDays: Int,
        pastPeriodCutoffDays: Int = 30,
        calendar: Calendar = .current
    ) -> [MilestoneItem] {
        var items: [MilestoneItem] = []

        func add(_ kind: MilestoneKind, _ title: String, due: String?, windowStart: String? = nil, key: String) {
            guard let due = due?.nilIfBlank else { return }
            items.append(MilestoneItem(
                id: "\(key):\(due)",
                kind: kind,
                title: title,
                dueDate: due,
                windowStart: windowStart,
                status: status(dueDate: due, today: today, leadDays: leadDays, calendar: calendar)
            ))
        }

        add(.noe, "Notice of Election", due: milestones.noeDueDate, key: "noe")
        add(.hopeAdmission, "HOPE admission assessment", due: milestones.hopeAdmissionDue, key: "hope_admission")
        add(.hopeHuv1, "HOPE Update Visit 1", due: milestones.hopeHuv1Window?.end,
            windowStart: milestones.hopeHuv1Window?.start, key: "hope_huv1")
        add(.hopeHuv2, "HOPE Update Visit 2", due: milestones.hopeHuv2Window?.end,
            windowStart: milestones.hopeHuv2Window?.start, key: "hope_huv2")

        for period in milestones.benefitPeriods {
            if let days = ISODate.daysFrom(today, to: period.end, calendar: calendar), days < -pastPeriodCutoffDays {
                continue
            }
            add(.recert, "Benefit period \(period.number) ends (recert)", due: period.end, key: "recert-\(period.number)")
            if period.f2fRequired {
                add(.f2f, "Face-to-face for period \(period.number)", due: period.f2fDueBy,
                    windowStart: period.f2fWindowStart, key: "f2f-\(period.number)")
            }
        }

        return items.sorted { lhs, rhs in
            if lhs.dueDate != rhs.dueDate { return lhs.dueDate < rhs.dueDate }
            return lhs.title < rhs.title
        }
    }

    /// The benefit period containing `today`, if any.
    static func currentBenefitPeriod(in milestones: Milestones, today: Date, calendar: Calendar = .current) -> BenefitPeriod? {
        milestones.benefitPeriods.first { period in
            guard let toStart = ISODate.daysFrom(today, to: period.start, calendar: calendar),
                  let toEnd = ISODate.daysFrom(today, to: period.end, calendar: calendar) else { return false }
            return toStart <= 0 && toEnd >= 0
        }
    }
}
