import Foundation
import FirebaseFirestore

/// v4 self-updates on `orgs/{orgId}/members/{uid}`: `status`, `outOfOffice` and
/// `notificationSettings` (added to the self-update allowlist, shape-validated by the rules).
/// Each write replaces the whole field with the exact types.ts shape (explicit nulls).
struct MemberSelfRepository {
    let orgId: String

    /// Conservative client-side caps (the rules validate the shape).
    static let maxStatusTextLength = 100
    static let maxOutOfOfficeNoteLength = 500

    private func memberRef(_ uid: String) -> DocumentReference {
        FirebaseService.orgRef(orgId).collection("members").document(uid)
    }

    /// Sets `status` to `{state, text, until}`, or clears it (`null`) when `status` is nil.
    func setStatus(uid: String, status: MemberStatus?) async throws {
        let value: Any
        if let status, let state = status.state {
            let text = status.text?.nilIfBlank.map { String($0.prefix(Self.maxStatusTextLength)) }
            value = [
                "state": state.rawValue,
                "text": orNull(text),
                "until": orNull(status.until.map { Timestamp(date: $0) }),
            ] as [String: Any]
        } else {
            value = NSNull()
        }
        try await memberRef(uid).updateData(["status": value])
    }

    /// Sets `outOfOffice` to `{until, delegateUid, note}`, or clears it (`null`).
    func setOutOfOffice(uid: String, until: Date?, delegateUid: String?, note: String?) async throws {
        let value: Any
        if let until {
            let trimmedNote = note?.nilIfBlank.map { String($0.prefix(Self.maxOutOfOfficeNoteLength)) }
            value = [
                "until": Timestamp(date: until),
                "delegateUid": orNull(delegateUid?.nilIfBlank),
                "note": orNull(trimmedNote),
            ] as [String: Any]
        } else {
            value = NSNull()
        }
        try await memberRef(uid).updateData(["outOfOffice": value])
    }

    /// Sets `notificationSettings` to `{quietHours: {start, end} | null, offShiftQuiet}`.
    func setNotificationSettings(uid: String, settings: NotificationSettings) async throws {
        let quiet: Any
        if let hours = settings.quietHours {
            quiet = ["start": hours.start, "end": hours.end] as [String: Any]
        } else {
            quiet = NSNull()
        }
        try await memberRef(uid).updateData([
            "notificationSettings": [
                "quietHours": quiet,
                "offShiftQuiet": settings.offShiftQuiet,
            ] as [String: Any],
        ])
    }
}

/// "HH:mm" <-> Date (today, local calendar) for `DatePicker(.hourAndMinute)`.
enum QuietTime {
    static func parse(_ value: String?, calendar: Calendar = .current, now: Date = Date()) -> Date? {
        guard let value else { return nil }
        let parts = value.split(separator: ":")
        guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: now)
    }

    static func string(from date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}
