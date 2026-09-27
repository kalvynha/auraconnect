import Foundation
import FirebaseFirestore

/// Message templates: org templates (`messageTemplates`, readable by staff, admin-managed via
/// `saveTemplate`) and my personal templates (`members/{uid}/templates`, owner-only).
/// Clients never write these collections directly; changes go through the callables.
struct TemplateRepository {
    let orgId: String

    private var orgTemplates: CollectionReference {
        FirebaseService.orgRef(orgId).collection("messageTemplates")
    }

    private func personalTemplates(uid: String) -> CollectionReference {
        FirebaseService.orgRef(orgId).collection("members").document(uid).collection("templates")
    }

    /// Org templates (all of them; callers filter `active`).
    func orgTemplateStream() -> AsyncThrowingStream<[MessageTemplate], Error> {
        Self.stream(orgTemplates.limit(to: 500), scope: .org)
    }

    func personalTemplateStream(uid: String) -> AsyncThrowingStream<[MessageTemplate], Error> {
        Self.stream(personalTemplates(uid: uid).limit(to: 200), scope: .personal)
    }

    /// Sets each template's `id` and `scope` from its document path. Documents that fail to
    /// decode are skipped.
    private static func stream(_ query: Query, scope: TemplateScope) -> AsyncThrowingStream<[MessageTemplate], Error> {
        AsyncThrowingStream { continuation in
            let registration = query.addSnapshotListener { snapshot, error in
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                guard let snapshot else { return }
                var items: [MessageTemplate] = []
                items.reserveCapacity(snapshot.documents.count)
                for document in snapshot.documents {
                    do {
                        var template = try document.data(as: MessageTemplate.self)
                        template.id = document.documentID
                        template.scope = scope
                        items.append(template)
                    } catch {
                        #if DEBUG
                        print("[Firestore] Skipping \(document.reference.path): \(error)")
                        #endif
                    }
                }
                continuation.yield(items)
            }
            continuation.onTermination = { _ in
                registration.remove()
            }
        }
    }

    /// Active templates sorted by category, then `order`, then title.
    static func sorted(_ templates: [MessageTemplate]) -> [MessageTemplate] {
        templates.filter { $0.active }.sorted {
            if $0.category != $1.category { return $0.category.sortIndex < $1.category.sortIndex }
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }
}
