import SwiftUI

/// How a survivor prefers to be contacted (`BereavementSurvivor.preferredContact`).
enum SurvivorPreferredContact: String, Codable, CaseIterable, Identifiable, Hashable {
    case phone, mail, email

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .phone)
    }

    var label: String {
        switch self {
        case .phone: return "Phone"
        case .mail: return "Mail"
        case .email: return "Email"
        }
    }
}

/// One family member followed by a bereavement plan (`BereavementPlan.survivors`, v3 C1).
/// Edited on the web console (`updateBereavementPlan`); read-only on iOS.
struct BereavementSurvivor: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var relationship: String?
    var phone: String?
    var email: String?
    var address: Address?
    var preferredContact: SurvivorPreferredContact
    var doNotContact: Bool
    var isPrimary: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, relationship, phone, email, address, preferredContact, doNotContact, isPrimary
    }

    init(id: String, name: String, relationship: String? = nil, phone: String? = nil, email: String? = nil,
         address: Address? = nil, preferredContact: SurvivorPreferredContact = .phone,
         doNotContact: Bool = false, isPrimary: Bool = false) {
        self.id = id
        self.name = name
        self.relationship = relationship
        self.phone = phone
        self.email = email
        self.address = address
        self.preferredContact = preferredContact
        self.doNotContact = doNotContact
        self.isPrimary = isPrimary
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id) ?? UUID().uuidString
        name = c.lenient(.name) ?? "Family member"
        relationship = c.lenient(.relationship)
        phone = c.lenient(.phone)
        email = c.lenient(.email)
        address = c.lenient(.address)
        preferredContact = c.lenient(.preferredContact) ?? .phone
        doNotContact = c.lenient(.doNotContact) ?? false
        isPrimary = c.lenient(.isPrimary) ?? false
    }
}

extension BereavementPlan {
    /// Survivors, falling back to the pre-v3 `primaryContact`.
    var survivorList: [BereavementSurvivor] {
        if let survivors { return survivors }
        guard let contact = primaryContact, !contact.isEmpty else { return [] }
        return [BereavementSurvivor(id: "primary", name: contact.name, relationship: contact.relationship,
                                    phone: contact.phone, isPrimary: true)]
    }
}

/// One contact in a bulk update.
struct BereavementContactRef: Hashable {
    let planId: String
    let contactId: String
}

extension FunctionsClient {
    /// `updateBereavementContacts`: at most 200 contacts per call, one transaction per plan on the
    /// server. Sends larger selections in chunks. Returns (updated, failed) counts.
    func updateBereavementContacts(orgId: String, items: [BereavementContactRef],
                                   status: BereavementContactStatus, note: String?) async throws -> (updated: Int, failed: Int) {
        var updated = 0
        var failed = 0
        var start = 0
        while start < items.count {
            let end = min(start + 200, items.count)
            var payload: [String: Any] = [
                "orgId": orgId,
                "status": status.rawValue,
                "items": items[start..<end].map { ["planId": $0.planId, "contactId": $0.contactId] },
            ]
            if let note = note?.nilIfBlank { payload["note"] = note }
            let response = try await call("updateBereavementContacts", payload)
            updated += (response["updated"] as? Int) ?? 0
            failed += (response["failed"] as? [Any])?.count ?? 0
            start = end
        }
        return (updated, failed)
    }
}

/// Read-only survivor list for the plan detail screen.
struct BereavementSurvivorsSection: View {
    let survivors: [BereavementSurvivor]

    var body: some View {
        Section {
            if survivors.isEmpty {
                Text("No survivors recorded.").foregroundStyle(.secondary)
            }
            ForEach(survivors) { survivor in
                BereavementSurvivorRow(survivor: survivor)
            }
        } header: {
            Text("Survivors")
        } footer: {
            Text("Edit survivors and mailing addresses in the web console.")
        }
    }
}

struct BereavementSurvivorRow: View {
    let survivor: BereavementSurvivor

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(survivor.name).font(.headline)
                if let relationship = survivor.relationship?.nilIfBlank {
                    Text("(\(relationship))").foregroundStyle(.secondary)
                }
                Spacer()
                if survivor.doNotContact {
                    StatusPill(text: "Do not contact", color: .red)
                } else if survivor.isPrimary {
                    StatusPill(text: "Primary", color: .blue)
                }
            }
            if !survivor.doNotContact {
                Text("Prefers \(survivor.preferredContact.label.lowercased())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let phone = survivor.phone?.nilIfBlank {
                    if let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                        Link(phone, destination: url).font(.subheadline)
                    } else {
                        Text(phone).font(.subheadline)
                    }
                }
                if let email = survivor.email?.nilIfBlank {
                    Text(email).font(.subheadline).foregroundStyle(.secondary)
                }
                if let address = survivor.address, !address.isEmpty {
                    Text(address.formatted).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
