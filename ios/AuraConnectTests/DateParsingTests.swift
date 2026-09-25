import XCTest
@testable import AuraConnect

final class DateParsingTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }

    func testParsesValidDate() throws {
        let date = try XCTUnwrap(ISODate.parse("2026-03-05", calendar: calendar))
        let components = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 3)
        XCTAssertEqual(components.day, 5)
        XCTAssertEqual(components.hour, 0)
    }

    func testRejectsMalformedDates() {
        XCTAssertNil(ISODate.parse(nil, calendar: calendar))
        XCTAssertNil(ISODate.parse("", calendar: calendar))
        XCTAssertNil(ISODate.parse("2026-3-5", calendar: calendar))
        XCTAssertNil(ISODate.parse("2026/03/05", calendar: calendar))
        XCTAssertNil(ISODate.parse("2026-13-01", calendar: calendar))
        XCTAssertNil(ISODate.parse("2025-02-30", calendar: calendar))
        XCTAssertNil(ISODate.parse("abcd-ef-gh", calendar: calendar))
    }

    func testLeapDay() {
        XCTAssertNotNil(ISODate.parse("2028-02-29", calendar: calendar))
        XCTAssertNil(ISODate.parse("2027-02-29", calendar: calendar))
    }

    func testRoundTrip() throws {
        let date = try XCTUnwrap(ISODate.parse("2026-12-31", calendar: calendar))
        XCTAssertEqual(ISODate.string(from: date, calendar: calendar), "2026-12-31")
    }

    func testStringUsesLocalCalendarDay() throws {
        // 2026-01-01 03:00 UTC is still Dec 31 in New York.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let instant = try XCTUnwrap(utc.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 3)))
        XCTAssertEqual(ISODate.string(from: instant, calendar: calendar), "2025-12-31")
        XCTAssertEqual(ISODate.string(from: instant, calendar: utc), "2026-01-01")
    }

    func testDaysFrom() throws {
        let today = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 1, hour: 15)))
        XCTAssertEqual(ISODate.daysFrom(today, to: "2026-03-01", calendar: calendar), 0)
        XCTAssertEqual(ISODate.daysFrom(today, to: "2026-03-06", calendar: calendar), 5)
        XCTAssertEqual(ISODate.daysFrom(today, to: "2026-02-27", calendar: calendar), -2)
        XCTAssertNil(ISODate.daysFrom(today, to: "not a date", calendar: calendar))
    }

    func testAge() throws {
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 15)))
        XCTAssertEqual(ISODate.age(fromDOB: "1940-06-15", now: now, calendar: calendar), 86)
        XCTAssertEqual(ISODate.age(fromDOB: "1940-06-16", now: now, calendar: calendar), 85)
        XCTAssertNil(ISODate.age(fromDOB: nil, now: now, calendar: calendar))
    }
}
