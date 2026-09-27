import Foundation
import Observation

/// Resolves patient ids to display names ("Last, First") for lists whose documents only carry
/// a `patientId` (alerts). Names are fetched once per id per session and kept in memory only.
@MainActor
@Observable
final class PatientNameCache {
    let orgId: String
    private(set) var names: [String: String] = [:]
    @ObservationIgnored private var requested: Set<String> = []

    init(orgId: String) {
        self.orgId = orgId
    }

    func name(for patientId: String?) -> String? {
        guard let patientId = patientId?.nilIfBlank else { return nil }
        return names[patientId]
    }

    /// Seeds names from patients already loaded elsewhere (avoids extra reads).
    func remember(_ patients: [Patient]) {
        for patient in patients {
            guard let id = patient.id else { continue }
            names[id] = patient.sortName
            requested.insert(id)
        }
    }

    /// Fetches names for ids not seen yet. Failures are ignored (the row just shows no name).
    func load(_ patientIds: [String]) async {
        let missing = Array(Set(patientIds.compactMap { $0.nilIfBlank }).subtracting(requested))
        guard !missing.isEmpty else { return }
        requested.formUnion(missing)
        let repository = PatientRepository(orgId: orgId)
        for id in missing {
            if Task.isCancelled {
                requested.remove(id)
                continue
            }
            do {
                if let patient = try await repository.fetchPatient(id: id) {
                    names[id] = patient.sortName
                }
            } catch {
                // Allow a later retry (e.g. once back online).
                requested.remove(id)
            }
        }
    }
}
