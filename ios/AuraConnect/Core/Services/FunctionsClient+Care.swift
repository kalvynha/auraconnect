import Foundation

/// v2 care-workflow callables (docs/DATA_MODEL.md "v2"). Payload conventions:
/// - fields typed `field?: T` in types.ts are **omitted** when nil (the server's zod schemas
///   reject `null` for them);
/// - fields typed `field?: T | null` are sent as `NSNull()` to clear them.
extension FunctionsClient {
    /// `IdResponse` from create-style callables.
    private func createdId(in response: [String: Any], from name: String) throws -> String {
        guard let value = response["id"] as? String, !value.isEmpty else {
            throw FunctionsClientError.badResponse(name)
        }
        return value
    }

    // MARK: Milestones

    /// Marks milestone `key` (`{kind}:{dueDate}`) complete. Clinical roles only.
    func completeMilestone(orgId: String, patientId: String, key: String, note: String?) async throws {
        var payload: [String: Any] = ["orgId": orgId, "patientId": patientId, "key": key]
        if let note = note?.nilIfBlank { payload["note"] = note }
        _ = try await call("completeMilestone", payload)
    }

    func reopenMilestone(orgId: String, patientId: String, key: String) async throws {
        _ = try await call("reopenMilestone", ["orgId": orgId, "patientId": patientId, "key": key])
    }

    // MARK: Lifecycle

    func changeLevelOfCare(orgId: String, patientId: String, levelOfCare: LevelOfCare,
                           effectiveDate: String, reason: String) async throws {
        _ = try await call("changeLevelOfCare", [
            "orgId": orgId,
            "patientId": patientId,
            "levelOfCare": levelOfCare.rawValue,
            "effectiveDate": effectiveDate,
            "reason": reason.trimmed,
        ])
    }

    /// `f2fDate` is required by the server when the period has `f2fRequired`.
    func recordRecertification(orgId: String, patientId: String, periodNumber: Int,
                               certifyingPhysician: String, certificationDate: String,
                               f2fDate: String?, f2fBy: String?) async throws {
        var payload: [String: Any] = [
            "orgId": orgId,
            "patientId": patientId,
            "periodNumber": periodNumber,
            "certifyingPhysician": certifyingPhysician.trimmed,
            "certificationDate": certificationDate,
        ]
        if let f2fDate = f2fDate?.nilIfBlank { payload["f2fDate"] = f2fDate }
        if let f2fBy = f2fBy?.nilIfBlank { payload["f2fBy"] = f2fBy }
        _ = try await call("recordRecertification", payload)
    }

    func dischargePatient(orgId: String, patientId: String, dischargeDate: String,
                          reason: DischargeReason, notes: String?) async throws {
        var payload: [String: Any] = [
            "orgId": orgId,
            "patientId": patientId,
            "dischargeDate": dischargeDate,
            "reason": reason.rawValue,
        ]
        if let notes = notes?.nilIfBlank { payload["notes"] = notes }
        _ = try await call("dischargePatient", payload)
    }

    /// `time` is local `HH:mm` in the org time zone.
    func recordDeath(orgId: String, patientId: String, date: String, time: String?,
                     pronouncedBy: String?, location: String?, notes: String?,
                     bereavementRisk: BereavementRisk, bereavementAssigneeUid: String?) async throws {
        var payload: [String: Any] = [
            "orgId": orgId,
            "patientId": patientId,
            "date": date,
            "bereavementRisk": bereavementRisk.rawValue,
        ]
        if let time = time?.nilIfBlank { payload["time"] = time }
        if let pronouncedBy = pronouncedBy?.nilIfBlank { payload["pronouncedBy"] = pronouncedBy }
        if let location = location?.nilIfBlank { payload["location"] = location }
        if let notes = notes?.nilIfBlank { payload["notes"] = notes }
        if let uid = bereavementAssigneeUid?.nilIfBlank { payload["bereavementAssigneeUid"] = uid }
        _ = try await call("recordDeath", payload)
    }

    // MARK: Visits

    func setVisitFrequencies(orgId: String, patientId: String, frequencies: [VisitFrequency]) async throws {
        _ = try await call("setVisitFrequencies", [
            "orgId": orgId,
            "patientId": patientId,
            "frequencies": frequencies.map { $0.dictionary },
        ])
    }

    /// Returns the new visit id.
    func scheduleVisit(orgId: String, patientId: String, discipline: Discipline, assignedUid: String?,
                       start: Date, end: Date, note: String?) async throws -> String {
        var payload: [String: Any] = [
            "orgId": orgId,
            "patientId": patientId,
            "discipline": discipline.rawValue,
            "assignedUid": orNull(assignedUid?.nilIfBlank),
            "start": ISOInstant.string(from: start),
            "end": ISOInstant.string(from: end),
        ]
        if let note = note?.nilIfBlank { payload["note"] = note }
        let response = try await call("scheduleVisit", payload)
        return try createdId(in: response, from: "scheduleVisit")
    }

    /// Full edit of a scheduled visit: nil `assignedUid` / `note` clear those fields.
    func updateVisit(orgId: String, visitId: String, assignedUid: String?, start: Date, end: Date,
                     note: String?) async throws {
        _ = try await call("updateVisit", [
            "orgId": orgId,
            "visitId": visitId,
            "assignedUid": orNull(assignedUid?.nilIfBlank),
            "start": ISOInstant.string(from: start),
            "end": ISOInstant.string(from: end),
            "note": blankToNull(note),
        ])
    }

    func completeVisit(orgId: String, visitId: String, note: String?) async throws {
        var payload: [String: Any] = ["orgId": orgId, "visitId": visitId]
        if let note = note?.nilIfBlank { payload["note"] = note }
        _ = try await call("completeVisit", payload)
    }

    func cancelVisit(orgId: String, visitId: String, reason: String) async throws {
        _ = try await call("cancelVisit", ["orgId": orgId, "visitId": visitId, "reason": reason.trimmed])
    }

    // MARK: Tasks

    /// Returns the new task id.
    func createTask(orgId: String, title: String, description: String?, patientId: String?,
                    assigneeUid: String?, discipline: Discipline?, dueDate: String?,
                    priority: Priority) async throws -> String {
        var payload: [String: Any] = [
            "orgId": orgId,
            "title": title.trimmed,
            "priority": priority.rawValue,
        ]
        if let description = description?.nilIfBlank { payload["description"] = description }
        if let patientId = patientId?.nilIfBlank { payload["patientId"] = patientId }
        if let assigneeUid = assigneeUid?.nilIfBlank { payload["assigneeUid"] = assigneeUid }
        if let discipline { payload["discipline"] = discipline.rawValue }
        if let dueDate = dueDate?.nilIfBlank { payload["dueDate"] = dueDate }
        let response = try await call("createTask", payload)
        return try createdId(in: response, from: "createTask")
    }

    /// Full edit of a task's editable fields: nil `description` / `assigneeUid` / `dueDate` clear them.
    func updateTask(orgId: String, taskId: String, title: String, description: String?,
                    assigneeUid: String?, dueDate: String?, priority: Priority) async throws {
        _ = try await call("updateTask", [
            "orgId": orgId,
            "taskId": taskId,
            "title": title.trimmed,
            "description": blankToNull(description),
            "assigneeUid": orNull(assigneeUid?.nilIfBlank),
            "dueDate": orNull(dueDate?.nilIfBlank),
            "priority": priority.rawValue,
        ])
    }

    /// Changes only the status (`done` sets `completedAt`/`completedBy` server-side).
    func updateTaskStatus(orgId: String, taskId: String, status: TaskStatus) async throws {
        _ = try await call("updateTask", ["orgId": orgId, "taskId": taskId, "status": status.rawValue])
    }

    /// Changes only the assignee (e.g. "Assign to me" on an unassigned task).
    func updateTaskAssignee(orgId: String, taskId: String, assigneeUid: String?) async throws {
        _ = try await call("updateTask", [
            "orgId": orgId,
            "taskId": taskId,
            "assigneeUid": orNull(assigneeUid?.nilIfBlank),
        ])
    }

    // MARK: Bereavement

    func updateBereavementContact(orgId: String, planId: String, contactId: String,
                                  status: BereavementContactStatus, note: String?) async throws {
        var payload: [String: Any] = [
            "orgId": orgId,
            "planId": planId,
            "contactId": contactId,
            "status": status.rawValue,
        ]
        if let note = note?.nilIfBlank { payload["note"] = note }
        _ = try await call("updateBereavementContact", payload)
    }

    /// Sends every editable field; a nil `assignedUid` unassigns the plan.
    func updateBereavementPlan(orgId: String, planId: String, assignedUid: String?,
                               riskLevel: BereavementRisk, status: BereavementPlanStatus) async throws {
        _ = try await call("updateBereavementPlan", [
            "orgId": orgId,
            "planId": planId,
            "assignedUid": orNull(assignedUid?.nilIfBlank),
            "riskLevel": riskLevel.rawValue,
            "status": status.rawValue,
        ])
    }
}
