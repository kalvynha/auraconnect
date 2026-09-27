import Foundation

/// Builds tap-to-call and tap-to-navigate URLs for phone numbers and addresses.
enum ContactLinks {
    /// `tel:` URL for a free-form phone number ("(555) 123-4567 ext 2" → `tel:5551234567,2`).
    /// Returns nil when the value has too few digits to dial.
    static func phone(_ number: String?) -> URL? {
        guard let number = number?.nilIfBlank else { return nil }
        var dialable = ""
        var sawExtension = false
        let lower = number.lowercased()
        for (index, character) in lower.enumerated() {
            if character.isASCII && character.isNumber {
                dialable.append(character)
            } else if character == "+" && dialable.isEmpty {
                dialable.append(character)
            } else if !sawExtension && (character == "x" || character == ",") && index > 0 && !dialable.isEmpty {
                // "x123", "ext 123" or ", 123": pause, then dial the extension.
                sawExtension = true
                dialable.append(",")
            }
        }
        while dialable.hasSuffix(",") { dialable.removeLast() }
        let digitCount = dialable.filter { $0.isNumber }.count
        guard digitCount >= 3 else { return nil }
        return URL(string: "tel:\(dialable)")
    }

    /// Apple Maps search URL (`maps://?q=…`) for a free-form address; newlines become commas.
    static func maps(_ address: String?) -> URL? {
        guard let address = address?.nilIfBlank else { return nil }
        let oneLine = address
            .components(separatedBy: .newlines)
            .compactMap { $0.nilIfBlank }
            .joined(separator: ", ")
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#/")
        guard let encoded = oneLine.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "maps://?q=\(encoded)")
    }
}

extension Address {
    /// Apple Maps URL for this address, or nil when it is empty.
    var mapsURL: URL? { isEmpty ? nil : ContactLinks.maps(formatted) }
}
