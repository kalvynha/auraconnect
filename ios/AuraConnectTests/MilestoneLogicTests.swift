import XCTest
@testable import AuraConnect

final class MilestoneLogicTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func day(_ string: String) -> Date {
        ISODate.parse(string, calendar: calendar)!.addingTimeInterval(10 * 3600) // mid-morning
    }

    func testStatusClassification() {
        let today = day("2026-03-10")
        XCTAssertEqual(MilestoneLogic.status(dueDate: "2026-03-09", today: today, leadDays: 3, calendar: calendar), .overdue)
        XCTAssertEqual(MilestoneLogic.status(dueDate: "2026-03-10", today: today, leadDays: 3, calendar: calendar), .dueSoon)
        XCTAssertEqual(MilestoneLogic.status(dueDate: "2026-03-13", today: today, leadDays: 3, calendar: calendar), .dueSoon)
        XCTAssertEqual(MilestoneLogic.status(dueDate: "2026-03-14", today: today, leadDays: 3, calendar: calendar), .upcoming)
        XCTAssertEqual(MilestoneLogic.status(dueDate: "2026-03-10", today: today, leadDays: 0, calendar: calendar), .dueSoon)
        XCTAssertEqual(MilestoneLogic.status(dueDate: "garbage", today: today, leadDays: 3, calendar: calendar), .upcoming)
    }

    private func sampleMilestones() -> Milestones {
        // Admission 2026-01-01; periods 1 & 2 are 90 days, period 3 is 60 days with F2F.
        Milestones(
            noeDueDate: "2026-01-06",
            benefitPeriods: [
                BenefitPeriod(number: 1, start: "2026-01-01", end: "2026-03-31", lengthDays: 90, f2fRequired: false),
                BenefitPeriod(number: 2, start: "2026-04-01", end: "2026-06-29", lengthDays: 90, f2fRequired: false),
                BenefitPeriod(number: 3, start: "2026-06-30", end: "2026-08-28", lengthDays: 60, f2fRequired: true,
                              f2fWindowStart: "2026-05-31", f2fDueBy: "2026-06-29"),
            ],
            hopeAdmissionDue: "2026-01-05",
            hopeHuv1Window: DateWindow(start: "2026-01-06", end: "2026-01-15"),
            hopeHuv2Window: DateWindow(start: "2026-01-16", end: "2026-01-30")
        )
    }

    func testItemsIncludeAllMilestonesSortedByDueDate() {
        let items = MilestoneLogic.items(for: sampleMilestones(), today: day("2026-01-03"), leadDays: 3, calendar: calendar)
        // Same due date (2026-06-29): "Benefit period 2 ends" sorts before "Face-to-face for period 3".
        XCTAssertEqual(items.map(\.kind), [.hopeAdmission, .noe, .hopeHuv1, .hopeHuv2, .recert, .recert, .f2f, .recert])
        XCTAssertEqual(items.map(\.dueDate), items.map(\.dueDate).sorted())
        let noe = items.first { $0.kind == .noe }
        XCTAssertEqual(noe?.status, .dueSoon)
        let f2f = items.first { $0.kind == .f2f }
        XCTAssertEqual(f2f?.windowStart, "2026-05-31")
        XCTAssertEqual(f2f?.dueDate, "2026-06-29")
        XCTAssertEqual(Set(items.map(\.id)).count, items.count, "ids must be unique")
    }

    func testOverdueAndPastPeriodCutoff() {
        let items = MilestoneLogic.items(for: sampleMilestones(), today: day("2026-07-15"), leadDays: 7, calendar: calendar)
        // S1: an unfiled recert stays visible (overdue) however old it is.
        XCTAssertEqual(items.first { $0.id == "recert-1:2026-03-31" }?.status, .overdue)
        XCTAssertTrue(items.contains { $0.id == "recert-2:2026-06-29" })
        // Once filed, a period that ended > 30 days ago is dropped.
        let filed = MilestoneLogic.items(for: sampleMilestones(), today: day("2026-07-15"), leadDays: 7,
                                         completedKeys: ["recert:2026-03-31"], calendar: calendar)
        XCTAssertFalse(filed.contains { $0.id == "recert-1:2026-03-31" })
        XCTAssertTrue(filed.contains { $0.id == "recert-2:2026-06-29" })
        XCTAssertEqual(items.first { $0.kind == .noe }?.status, .overdue)
        XCTAssertEqual(items.first { $0.id == "recert-3:2026-08-28" }?.status, .upcoming)
    }

    func testLeadDaysPerKind() {
        XCTAssertEqual(MilestoneLogic.leadDays(for: .recert, byKind: nil, fallback: 3), 15)
        XCTAssertEqual(MilestoneLogic.leadDays(for: .f2f, byKind: nil, fallback: 3), 30)
        XCTAssertEqual(MilestoneLogic.leadDays(for: .hopeHuv1, byKind: nil, fallback: 3), 2)
        XCTAssertEqual(MilestoneLogic.leadDays(for: .noe, byKind: ["noe": 5], fallback: 3), 5)
        // 2026-03-20: recert (03-31) is 11 days out → due soon with the 15-day recert default.
        let items = MilestoneLogic.items(for: sampleMilestones(), today: day("2026-03-20"), leadDays: 3, calendar: calendar)
        XCTAssertEqual(items.first { $0.id == "recert-1:2026-03-31" }?.status, .dueSoon)
    }

    func testCompletionOnTimeUsesEffectiveDate() {
        let late = MilestoneCompletion(completedAt: day("2026-01-02"), completedBy: "u", note: nil, effectiveDate: "2026-01-08")
        XCTAssertFalse(MilestoneCompletionLogic.isOnTime(late, dueDate: "2026-01-06", timeZoneId: "UTC"))
        let onTime = MilestoneCompletion(completedAt: day("2026-01-09"), completedBy: "u", note: nil, effectiveDate: "2026-01-05")
        XCTAssertTrue(MilestoneCompletionLogic.isOnTime(onTime, dueDate: "2026-01-06", timeZoneId: "UTC"))
    }

    func testCurrentBenefitPeriod() {
        let milestones = sampleMilestones()
        XCTAssertEqual(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-01-01"), calendar: calendar)?.number, 1)
        XCTAssertEqual(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-04-01"), calendar: calendar)?.number, 2)
        XCTAssertEqual(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-08-28"), calendar: calendar)?.number, 3)
        XCTAssertNil(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-09-01"), calendar: calendar))
    }
}
