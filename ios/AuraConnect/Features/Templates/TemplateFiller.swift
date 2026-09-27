import Foundation

/// Channel context used to fill a template's built-in placeholders locally:
/// `{{patient}}`, `{{patientFirst}}`, `{{codeStatus}}`, `{{caregiver}}`, `{{caregiverPhone}}`,
/// `{{me}}`, `{{myDiscipline}}`, `{{time}}`, `{{date}}`.
struct TemplateContext {
    /// Set in patient channels.
    var patient: Patient?
    var myName: String
    var myDiscipline: Discipline?
    var now: Date = Date()

    var isPatientChannel: Bool { patient != nil }

    /// Built-in values; placeholders without a value (e.g. `{{patient}}` outside a patient channel)
    /// are left in the text so the sender notices them.
    var builtIns: [String: String] {
        var values: [String: String] = [
            "me": myName,
            "time": now.formatted(date: .omitted, time: .shortened),
            "date": now.formatted(date: .abbreviated, time: .omitted),
        ]
        if let discipline = myDiscipline { values["myDiscipline"] = discipline.label }
        if let patient {
            let first = patient.firstName?.nilIfBlank
            let full = [first, patient.lastName?.nilIfBlank].compactMap { $0 }.joined(separator: " ")
            if !full.isEmpty { values["patient"] = full }
            if let first { values["patientFirst"] = first }
            values["codeStatus"] = (patient.codeStatus ?? .unknown).label
            if let caregiver = patient.caregiver, let name = caregiver.name.nilIfBlank {
                if let relationship = caregiver.relationship?.nilIfBlank {
                    values["caregiver"] = "\(name) (\(relationship))"
                } else {
                    values["caregiver"] = name
                }
            }
            if let phone = patient.caregiver?.phone?.nilIfBlank { values["caregiverPhone"] = phone }
        }
        return values
    }
}

enum TemplateFiller {
    /// Replaces `{{key}}` (whitespace inside the braces allowed) with `fieldValues[key]`, then the
    /// built-ins. Unknown keys and blank values are left as written.
    static func fill(_ body: String, fieldValues: [String: String] = [:], context: TemplateContext) -> String {
        var values = context.builtIns
        for (key, value) in fieldValues {
            if let value = value.nilIfBlank { values[key] = value }
        }
        return replacePlaceholders(in: body, values: values)
    }

    static func replacePlaceholders(in body: String, values: [String: String]) -> String {
        guard body.contains("{{"),
              let regex = try? NSRegularExpression(pattern: #"\{\{\s*([A-Za-z0-9_]+)\s*\}\}"#) else { return body }
        let ns = body as NSString
        var result = ""
        var cursor = 0
        for match in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let key = ns.substring(with: match.range(at: 1))
            result += values[key] ?? ns.substring(with: match.range)
            cursor = match.range.location + match.range.length
        }
        result += ns.substring(from: cursor)
        return result
    }

    /// Fields whose required value is still blank.
    static func missingRequired(_ template: MessageTemplate, values: [String: String]) -> [TemplateField] {
        template.fields.filter { $0.required && (values[$0.key]?.nilIfBlank == nil) }
    }
}
