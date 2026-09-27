import XCTest
@testable import AuraConnect

final class MessagingV4Tests: XCTestCase {
    func testTemplateMarker() {
        XCTAssertEqual(MessageTemplate.marker(for: "sbar"), "[[tpl:sbar]]")
        XCTAssertEqual(MessageTemplate.strippingMarker("[[tpl:sbar]]Hello"), "Hello")
        XCTAssertEqual(MessageTemplate.strippingMarker("Hello [[tpl:x]]"), "Hello [[tpl:x]]")
    }

    func testTemplateFillerUsesFieldsAndBuiltIns() {
        let context = TemplateContext(patient: nil, myName: "Ana RN", myDiscipline: .rn)
        let filled = TemplateFiller.fill("{{ me }} ({{myDiscipline}}): {{s}} for {{patient}}",
                                         fieldValues: ["s": "Pain 8/10"], context: context)
        // No patient in context: {{patient}} is left for the sender to notice.
        XCTAssertEqual(filled, "Ana RN (RN): Pain 8/10 for {{patient}}")
    }

    func testMissingRequiredFields() {
        let template = MessageTemplate(title: "SBAR", category: .escalation, body: "{{s}} {{b}}",
                                       fields: [TemplateField(key: "s", label: "S", required: true),
                                                TemplateField(key: "b", label: "B", required: false)])
        XCTAssertEqual(TemplateFiller.missingRequired(template, values: ["s": "  "]).map { $0.key }, ["s"])
        XCTAssertTrue(TemplateFiller.missingRequired(template, values: ["s": "x"]).isEmpty)
    }

    func testMentionQueryAndApply() {
        XCTAssertEqual(MentionLogic.activeQuery(in: "Hi @Ja"), "Ja")
        XCTAssertNil(MentionLogic.activeQuery(in: "mail me@example"))
        let jane = MentionCandidate(id: "u1", token: "Jane Doe", title: "Jane Doe", subtitle: nil, isRole: false)
        XCTAssertEqual(MentionLogic.suggestions(for: "do", in: [jane]).count, 1)
        XCTAssertEqual(MentionLogic.apply(jane, to: "Hi @Ja"), "Hi @Jane Doe ")
    }

    func testMentionFormatterKeepsText() {
        let text = "Ping @jane doe and @oncall-rn-north, not @janet"
        let attributed = MentionFormatter.attributed(text, tokens: ["Jane Doe", "oncall-rn-north"], myTokens: ["jane doe"])
        XCTAssertEqual(String(attributed.characters), text)
    }

    func testTemplateDecodingIsLenient() throws {
        let json = #"{"title": "Fall", "category": "nope", "fields": [{"key": "k", "kind": "choice", "options": ["a"]}], "defaultPriority": "urgent"}"#
        let template = try JSONDecoder().decode(MessageTemplate.self, from: Data(json.utf8))
        XCTAssertEqual(template.category, .logistics)
        XCTAssertEqual(template.defaultPriority, .urgent)
        XCTAssertEqual(template.fields.first?.kind, .choice)
        XCTAssertTrue(template.active)
        XCTAssertEqual(template.fields.first?.dictionary["options"] as? [String], ["a"])
    }

    func testChannelPrefsDecoding() throws {
        let prefs = try JSONDecoder().decode(ChannelPrefs.self, from: Data(#"{"mode": "urgent_only"}"#.utf8))
        XCTAssertEqual(prefs.mode, .urgentOnly)
        XCTAssertFalse(prefs.isMuted())
    }
}
