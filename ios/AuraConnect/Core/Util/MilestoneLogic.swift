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

    /// v3 (V1) default reminder lead days per kind (mirrors `DEADLINE_LEAD_DAYS_DEFAULTS`).
    static let defaultLeadDaysByKind: [MilestoneKind: Int] = [
        .noe: 3, .recert: 15, .f2f: 30, .hopeAdmission: 2, .hopeHuv1: 2, .hopeHuv2: 2,
    ]

    /// Lead days for `kind`: the org's per-kind setting, else the kind default, else `fallback`.
    static func leadDays(for kind: MilestoneKind, byKind: [String: Int]?, fallback: Int) -> Int {
        max(0, byKind?[kind.rawValue] ?? defaultLeadDaysByKind[kind] ?? fallback)
    }

    /// Flattens `Milestones` into a list sorted by due date.
    ///
    /// v3 (S1): overdue milestones are never dropped for age. A benefit period that ended more than
    /// `pastPeriodCutoffDays` ago is omitted only when all of its milestones are in `completedKeys`
    /// (server keys `{kind}:{dueDate}`); an unfiled recert or F2F stays visible as overdue.
    static func items(
        for milestones: Milestones,
        today: Date,
        leadDays: Int,
        leadDaysByKind: [String: Int]? = nil,
        completedKeys: Set<String> = [],
        pastPeriodCutoffDays: Int = 30,
        calendar: Calendar = .current
    ) -> [MilestoneItem] {
        var items: [MilestoneItem] = []

        func add(_ kind: MilestoneKind, _ title: String, due: String?, windowStart: String? = nil, key: String) {
            guard let due = due?.nilIfBlank else { return }
            let lead = Self.leadDays(for: kind, byKind: leadDaysByKind, fallback: leadDays)
            items.append(MilestoneItem(
                id: "\(key):\(due)",
                kind: kind,
                title: title,
                dueDate: due,
                windowStart: windowStart,
                status: status(dueDate: due, today: today, leadDays: lead, calendar: calendar)
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
                let recertDone = completedKeys.contains("recert:\(period.end)")
                let f2fDone = !period.f2fRequired || (period.f2fDueBy.map { completedKeys.contains("f2f:\($0)") } ?? true)
                if recertDone && f2fDone { continue }
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
