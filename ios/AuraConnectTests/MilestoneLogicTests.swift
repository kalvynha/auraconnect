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
        // Period 1 ended > 30 days ago and is dropped; period 2 ended 16 days ago and is kept.
        XCTAssertFalse(items.contains { $0.id == "recert-1:2026-03-31" })
        XCTAssertTrue(items.contains { $0.id == "recert-2:2026-06-29" })
        XCTAssertEqual(items.first { $0.kind == .noe }?.status, .overdue)
        XCTAssertEqual(items.first { $0.id == "recert-3:2026-08-28" }?.status, .upcoming)
    }

    func testCurrentBenefitPeriod() {
        let milestones = sampleMilestones()
        XCTAssertEqual(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-01-01"), calendar: calendar)?.number, 1)
        XCTAssertEqual(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-04-01"), calendar: calendar)?.number, 2)
        XCTAssertEqual(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-08-28"), calendar: calendar)?.number, 3)
        XCTAssertNil(MilestoneLogic.currentBenefitPeriod(in: milestones, today: day("2026-09-01"), calendar: calendar))
    }
}
