import Foundation

/// Helpers for contract calendar dates (`YYYY-MM-DD` strings). These never carry a time
/// zone: they are interpreted as local calendar days so they don't shift across zones.
enum ISODate {
    /// Parses `YYYY-MM-DD` into local midnight of that day. Returns nil for malformed input.
    static func parse(_ string: String?, calendar: Calendar = .current) -> Date? {
        guard let string = string?.trimmed, string.count == 10 else { return nil }
        let parts = string.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day) else {
            return nil
        }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        guard let date = calendar.date(from: components) else { return nil }
        // Reject rollovers such as 2025-02-30.
        let check = calendar.dateComponents([.year, .month, .day], from: date)
        guard check.year == year, check.month == month, check.day == day else { return nil }
        return date
    }

    /// Formats the local calendar day of `date` as `YYYY-MM-DD`.
    static func string(from date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Whole calendar days from `from` (its local day) to `isoDate`. Negative when in the past.
    static func daysFrom(_ from: Date, to isoDate: String, calendar: Calendar = .current) -> Int? {
        guard let target = parse(isoDate, calendar: calendar) else { return nil }
        let start = calendar.startOfDay(for: from)
        return calendar.dateComponents([.day], from: start, to: target).day
    }

    /// "Mar 5, 2026" for display; falls back to the raw string when it can't be parsed.
    static func display(_ string: String?, calendar: Calendar = .current) -> String {
        guard let string, let date = parse(string, calendar: calendar) else { return string ?? "—" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    /// Age in whole years at `now`.
    static func age(fromDOB dob: String?, now: Date = Date(), calendar: Calendar = .current) -> Int? {
        guard let birth = parse(dob, calendar: calendar) else { return nil }
        return calendar.dateComponents([.year], from: birth, to: now).year
    }
}

enum RelativeTime {
    /// Compact timestamp for lists: time today, "Yesterday", weekday this week, else a short date.
    static func short(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return "" }
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday"
        }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day,
           days < 7, days > 0 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }

    /// Full timestamp for detail screens.
    static func full(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
