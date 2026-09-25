import Foundation
import FirebaseFirestore

struct ScheduleRepository {
    let orgId: String

    func onCallRoles() -> AsyncThrowingStream<[OnCallRole], Error> {
        FirebaseService.orgRef(orgId).collection("onCallRoles").decodedStream(OnCallRole.self)
    }

    /// Shifts that have not ended as of `now` (current and upcoming). Filtered client-side
    /// for "on call now" (`start <= now < end`) and "my shifts" (single-field index only).
    func currentAndUpcomingShifts(from now: Date) -> AsyncThrowingStream<[Shift], Error> {
        FirebaseService.orgRef(orgId).collection("shifts")
            .whereField("end", isGreaterThanOrEqualTo: Timestamp(date: now))
            .order(by: "end")
            .limit(to: 500)
            .decodedStream(Shift.self)
    }
}
