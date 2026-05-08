import Foundation

struct UserProfile: Codable, Equatable {
    var id: UUID
    var displayName: String
    var inviteCode: String

    static func makeDefault() -> UserProfile {
        UserProfile(
            id: UUID(),
            displayName: "나",
            inviteCode: makeInviteCode()
        )
    }

    private static func makeInviteCode() -> String {
        let raw = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        return "GP-\(raw.prefix(6).uppercased())"
    }
}

struct PingFriend: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var handle: String
    var theme: FriendTheme
    var lastPingAt: Date?

    init(id: UUID = UUID(), name: String, handle: String, theme: FriendTheme, lastPingAt: Date? = nil) {
        self.id = id
        self.name = name
        self.handle = handle
        self.theme = theme
        self.lastPingAt = lastPingAt
    }
}

enum FriendTheme: String, CaseIterable, Codable, Identifiable {
    case mint
    case coral
    case amber
    case violet
    case graphite

    var id: String { rawValue }
}

enum QuickMessage: String, CaseIterable, Identifiable, Codable {
    case gameStarted = "게임 시작"
    case joinLobby = "로비 와"
    case joinDiscord = "디코 와"
    case oneMore = "한 판 더"

    var id: String { rawValue }

    var notificationBody: String {
        switch self {
        case .gameStarted:
            return "게임 시작했어. 들어와!"
        case .joinLobby:
            return "로비에서 기다리는 중."
        case .joinDiscord:
            return "디스코드로 와줘."
        case .oneMore:
            return "한 판 더 가자."
        }
    }
}

struct PingEvent: Identifiable, Codable, Equatable {
    var id: UUID
    var friendName: String
    var message: QuickMessage
    var sentAt: Date
    var deliveryState: PingDeliveryState?

    init(
        id: UUID = UUID(),
        friendName: String,
        message: QuickMessage,
        sentAt: Date = Date(),
        deliveryState: PingDeliveryState? = .pending
    ) {
        self.id = id
        self.friendName = friendName
        self.message = message
        self.sentAt = sentAt
        self.deliveryState = deliveryState
    }
}

struct ReceivedPing: Identifiable, Codable, Equatable {
    var id: String
    var senderName: String
    var messageText: String
    var body: String
    var receivedAt: Date

    var displayMessage: String {
        QuickMessage(rawValue: messageText)?.rawValue ?? messageText
    }
}

enum PingResult: Equatable {
    case sent(PingEvent)
    case cooledDown(secondsLeft: Int)
}

enum PingDeliveryState: String, Codable, Equatable {
    case pending
    case mockServer
    case localPreview
    case failed
}
