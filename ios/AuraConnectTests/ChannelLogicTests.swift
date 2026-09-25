import XCTest
@testable import AuraConnect

final class ChannelLogicTests: XCTestCase {
    func testDirectChannelIdIsOrderIndependent() {
        XCTAssertEqual(ChannelLogic.directChannelId("bob", "alice"), "dm_alice_bob")
        XCTAssertEqual(ChannelLogic.directChannelId("alice", "bob"), "dm_alice_bob")
        XCTAssertEqual(ChannelLogic.directChannelId("Zed", "amy"), "dm_Zed_amy") // byte order, like JS sort
    }

    func testUnreadWhenNewerThanLastRead() {
        let read = Date(timeIntervalSince1970: 1_000)
        let later = Date(timeIntervalSince1970: 2_000)
        XCTAssertTrue(ChannelLogic.isUnread(lastMessageAt: later, lastSenderUid: "other", lastReadAt: read, myUid: "me"))
        XCTAssertFalse(ChannelLogic.isUnread(lastMessageAt: read, lastSenderUid: "other", lastReadAt: later, myUid: "me"))
        XCTAssertFalse(ChannelLogic.isUnread(lastMessageAt: read, lastSenderUid: "other", lastReadAt: read, myUid: "me"))
    }

    func testNeverReadIsUnread() {
        XCTAssertTrue(ChannelLogic.isUnread(lastMessageAt: Date(), lastSenderUid: "other", lastReadAt: nil, myUid: "me"))
    }

    func testMyOwnLastMessageIsNotUnread() {
        XCTAssertFalse(ChannelLogic.isUnread(lastMessageAt: Date(), lastSenderUid: "me", lastReadAt: nil, myUid: "me"))
    }

    func testNoMessagesIsNotUnread() {
        XCTAssertFalse(ChannelLogic.isUnread(lastMessageAt: nil, lastSenderUid: nil, lastReadAt: nil, myUid: "me"))
    }

    func testReaders() {
        let sent = Date(timeIntervalSince1970: 1_000)
        let reads: [String: Date] = [
            "me": Date(timeIntervalSince1970: 5_000),
            "a": Date(timeIntervalSince1970: 1_000),
            "b": Date(timeIntervalSince1970: 999),
            "c": Date(timeIntervalSince1970: 3_000),
        ]
        XCTAssertEqual(ChannelLogic.readers(of: sent, senderUid: "me", reads: reads), ["a", "c"])
        XCTAssertEqual(ChannelLogic.readers(of: nil, senderUid: "me", reads: reads), [])
    }

    func testSanitizedFileName() {
        XCTAssertEqual(MessageRepository.sanitizedFileName("Wound photo (1).jpg"), "Wound_photo__1_.jpg")
        XCTAssertEqual(MessageRepository.sanitizedFileName("../../etc/passwd"), "etc_passwd")
        XCTAssertEqual(MessageRepository.sanitizedFileName(""), "file")
    }
}
