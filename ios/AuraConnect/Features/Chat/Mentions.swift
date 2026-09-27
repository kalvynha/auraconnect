import SwiftUI

/// Something that can be @mentioned: a channel member (by display name) or an on-call role
/// (by role key). `onMessageCreated` resolves both server-side.
struct MentionCandidate: Identifiable, Hashable {
    /// uid or role key.
    let id: String
    /// Inserted after "@" (display name or role key).
    let token: String
    let title: String
    let subtitle: String?
    let isRole: Bool
}

enum MentionLogic {
    /// The text after the last "@" at the end of the draft while a mention is being typed
    /// ("@" at the start or after whitespace, no newline, at most 40 characters).
    static func activeQuery(in draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex {
            let before = draft[draft.index(before: at)]
            guard before.isWhitespace else { return nil }
        }
        let query = draft[draft.index(after: at)...]
        guard query.count <= 40, !query.contains(where: { $0.isNewline }) else { return nil }
        return String(query)
    }

    /// Candidates whose token or title starts with the query (or has a word that does). Max `limit`.
    static func suggestions(for query: String, in candidates: [MentionCandidate], limit: Int = 6) -> [MentionCandidate] {
        let q = query.lowercased()
        let matches = candidates.filter { candidate in
            if q.isEmpty { return true }
            let token = candidate.token.lowercased()
            let title = candidate.title.lowercased()
            if token.hasPrefix(q) || title.hasPrefix(q) { return true }
            return title.split(separator: " ").contains { $0.hasPrefix(q) }
        }
        return Array(matches.prefix(limit))
    }

    /// Replaces the "@query" being typed at the end of the draft with "@token ".
    static func apply(_ candidate: MentionCandidate, to draft: String) -> String {
        guard activeQuery(in: draft) != nil, let at = draft.lastIndex(of: "@") else {
            return draft + "@\(candidate.token) "
        }
        return String(draft[..<at]) + "@\(candidate.token) "
    }
}

enum MentionFormatter {
    /// Highlights "@token" occurrences (longest match, case-insensitive, word boundary after).
    /// Tokens in `myTokens` (lower-cased) get extra emphasis.
    static func attributed(_ text: String, tokens: [String], myTokens: Set<String>) -> AttributedString {
        guard text.contains("@"), !tokens.isEmpty else { return AttributedString(text) }
        let sorted = tokens.filter { !$0.isEmpty }.sorted { $0.count > $1.count }
        var result = AttributedString()
        var plainStart = text.startIndex
        var index = text.startIndex
        while index < text.endIndex {
            guard text[index] == "@" else {
                index = text.index(after: index)
                continue
            }
            let atBoundary = index == text.startIndex || !text[text.index(before: index)].isLetterOrNumber
            let rest = text[text.index(after: index)...]
            var found: (token: String, end: String.Index)?
            if atBoundary {
                for token in sorted where rest.count >= token.count {
                    let candidate = rest.prefix(token.count)
                    guard candidate.lowercased() == token.lowercased() else { continue }
                    let candidateEnd = candidate.endIndex
                    if candidateEnd < text.endIndex && text[candidateEnd].isLetterOrNumber { continue }
                    found = (token: String(candidate), end: candidateEnd)
                    break
                }
            }
            guard let matched = found else {
                index = text.index(after: index)
                continue
            }
            result += AttributedString(String(text[plainStart..<index]))
            let end = matched.end
            var mention = AttributedString(String(text[index..<end]))
            // Explicit SwiftUI keys (the UIKit scope has same-named attributes).
            mention[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.body.weight(.semibold)
            if myTokens.contains(matched.token.lowercased()) {
                mention[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = Color.orange
                mention[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = Color.orange.opacity(0.18)
            } else {
                mention[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = Color.accentColor
            }
            result += mention
            index = end
            plainStart = end
        }
        result += AttributedString(String(text[plainStart...]))
        return result
    }
}

private extension Character {
    var isLetterOrNumber: Bool { isLetter || isNumber }
}

/// Suggestion list shown above the composer while typing "@…".
struct MentionSuggestionList: View {
    let suggestions: [MentionCandidate]
    let onSelect: (MentionCandidate) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(suggestions) { candidate in
                Button {
                    onSelect(candidate)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: candidate.isRole ? "person.badge.clock" : "person.crop.circle")
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(candidate.title)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Color.primary)
                            if let subtitle = candidate.subtitle?.nilIfBlank {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mention \(candidate.title)")
                if candidate.id != suggestions.last?.id {
                    Divider().padding(.leading, 44)
                }
            }
        }
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
