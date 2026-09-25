import XCTest
@testable import AuraConnect

final class ModelTests: XCTestCase {
    func testPushDataParsing() {
        let message = PushData(userInfo: ["type": "message", "orgId": "o1", "channelId": "c1", "priority": "urgent"])
        XCTAssertEqual(message, PushData(type: .message, orgId: "o1", channelId: "c1", priority: .urgent))

        // Urgent/critical messages arrive as an alert push that also carries the channel.
        let alert = PushData(userInfo: ["type": "alert", "orgId": "o1", "alertId": "a1", "channelId": "c1", "priority": "critical"])
        XCTAssertEqual(alert?.alertId, "a1")
        XCTAssertEqual(alert?.channelId, "c1")
        XCTAssertEqual(alert?.priority, .critical)

        XCTAssertNil(PushData(userInfo: ["type": "message", "orgId": "o1"]))
        XCTAssertNil(PushData(userInfo: ["type": "bogus", "orgId": "o1", "channelId": "c1"]))
        XCTAssertEqual(PushData(userInfo: ["type": "alert", "alertId": "a1", "priority": "weird"])?.priority, .normal)
    }

    func testTolerantEnumDecoding() throws {
        let json = #"{"a": "urgent", "b": "not-a-priority"}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode([String: Priority].self, from: json)
        XCTAssertEqual(decoded["a"], .urgent)
        XCTAssertEqual(decoded["b"], .normal)
        XCTAssertEqual(try JSONDecoder().decode([CodeStatus].self, from: #"["DNR/DNI","???"]"#.data(using: .utf8)!), [.dnrDni, .unknown])
    }

    func testPatientInputDecodesPartialDocument() throws {
        let json = #"{"firstName": "Ada", "sex": "female", "allergies": ["PCN"], "primaryDiagnosis": {"code": null}}"#.data(using: .utf8)!
        let input = try JSONDecoder().decode(PatientInput.self, from: json)
        XCTAssertEqual(input.firstName, "Ada")
        XCTAssertEqual(input.lastName, "")
        XCTAssertEqual(input.sex, .female)
        XCTAssertEqual(input.codeStatus, .unknown)
        XCTAssertEqual(input.allergies, ["PCN"])
        XCTAssertEqual(input.primaryDiagnosis?.description, "")
        XCTAssertTrue(input.secondaryDiagnoses.isEmpty)
        XCTAssertFalse(input.hasRequiredNames)
    }

    func testPatientInputDictionaryUsesNulls() {
        var input = PatientInput()
        input.firstName = "  Ada "
        input.lastName = "Lovelace"
        input.phone = "   "
        input.allergies = ["PCN", " "]
        input.medications = [Medication(name: "Morphine", dose: "5 mg"), Medication(name: "")]
        input.caregiver = Caregiver()
        let dict = input.dictionary
        XCTAssertEqual(dict["firstName"] as? String, "Ada")
        XCTAssertTrue(dict["phone"] is NSNull)
        XCTAssertTrue(dict["dob"] is NSNull)
        XCTAssertTrue(dict["caregiver"] is NSNull)
        XCTAssertTrue(dict["primaryDiagnosis"] is NSNull)
        XCTAssertEqual(dict["allergies"] as? [String], ["PCN"])
        XCTAssertEqual((dict["medications"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(dict["codeStatus"] as? String, "Unknown")
        let address = dict["address"] as? [String: Any]
        XCTAssertTrue(address?["line1"] is NSNull)
    }

    func testConfidenceLookup() {
        let map: [String: Double] = ["patient.dob": 0.4, "patient.address.city": 0.6, "patient.address.zip": 0.9, "patient.lastName": 0.95]
        XCTAssertEqual(ConfidenceLookup.confidence(for: "patient.dob", in: map), 0.4)
        XCTAssertEqual(ConfidenceLookup.confidence(for: "patient.address", in: map), 0.6)
        XCTAssertNil(ConfidenceLookup.confidence(for: "patient.firstName", in: map))
        XCTAssertNil(ConfidenceLookup.confidence(for: "patient.add", in: map))
        XCTAssertTrue(ConfidenceLookup.isLow(0.69))
        XCTAssertFalse(ConfidenceLookup.isLow(0.7))
        XCTAssertFalse(ConfidenceLookup.isLow(nil))
    }

    func testConsentsRequired() {
        XCTAssertFalse(Consents().requiredComplete)
        XCTAssertFalse(Consents(electionStatement: true).requiredComplete)
        XCTAssertTrue(Consents(electionStatement: true, hipaaNotice: true).requiredComplete)
    }
}
