import Foundation

@MainActor
final class PingStore: ObservableObject {
    @Published private(set) var profile: UserProfile = .makeDefault()
    @Published private(set) var friends: [PingFriend] = []
    @Published private(set) var recentEvents: [PingEvent] = []
    @Published private(set) var receivedPings: [ReceivedPing] = []

    private let profileKey = "gameping.profile"
    private let friendsKey = "gameping.friends"
    private let eventsKey = "gameping.events"
    private let receivedPingsKey = "gameping.receivedPings"
    private let cooldown: TimeInterval = 5

    init() {
        load()
    }

    func ping(_ friend: PingFriend, message: QuickMessage) -> PingResult {
        guard let index = friends.firstIndex(where: { $0.id == friend.id }) else {
            return .cooledDown(secondsLeft: 1)
        }

        if let lastPingAt = friends[index].lastPingAt {
            let elapsed = Date().timeIntervalSince(lastPingAt)
            if elapsed < cooldown {
                return .cooledDown(secondsLeft: Int(ceil(cooldown - elapsed)))
            }
        }

        friends[index].lastPingAt = Date()
        let event = PingEvent(friendName: friends[index].name, message: message)
        recentEvents.insert(event, at: 0)
        recentEvents = Array(recentEvents.prefix(10))
        save()
        return .sent(event)
    }

    func pingAll(message: QuickMessage) -> [PingResult] {
        friends.map { ping($0, message: message) }
    }

    func secondsUntilReady(for friend: PingFriend) -> Int {
        guard let lastPingAt = friend.lastPingAt else { return 0 }
        let elapsed = Date().timeIntervalSince(lastPingAt)
        return max(0, Int(ceil(cooldown - elapsed)))
    }

    func updateProfile(displayName: String) {
        let cleanName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return }

        profile.displayName = cleanName
        save()
    }

    func addFriend(name: String, handle: String, theme: FriendTheme) {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanHandle = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return }

        friends.append(
            PingFriend(
                name: cleanName,
                handle: cleanHandle.isEmpty ? "@unknown" : cleanHandle,
                theme: theme
            )
        )
        save()
    }

    @discardableResult
    func addResolvedFriend(_ friend: PingFriend) -> Bool {
        guard friend.id != profile.id else { return false }
        guard friends.contains(where: { $0.id == friend.id || $0.handle.uppercased() == friend.handle.uppercased() }) == false else {
            return false
        }

        let theme = FriendTheme.allCases[friends.count % FriendTheme.allCases.count]
        friends.append(
            PingFriend(
                id: friend.id,
                name: friend.name,
                handle: friend.handle,
                theme: theme
            )
        )
        save()
        return true
    }

    @discardableResult
    func addFriendFromInviteCode(_ code: String) -> Bool {
        let compactCode = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
            .uppercased()

        guard !compactCode.isEmpty else { return false }

        let normalizedCode = compactCode.hasPrefix("GP-") ? compactCode : "GP-\(compactCode)"
        guard normalizedCode.count >= 6 else { return false }
        guard friends.contains(where: { $0.handle.uppercased() == normalizedCode }) == false else {
            return false
        }

        let suffix = normalizedCode.split(separator: "-").last.map(String.init) ?? "NEW"
        let theme = FriendTheme.allCases[friends.count % FriendTheme.allCases.count]
        friends.append(
            PingFriend(
                name: "친구 \(suffix.prefix(3))",
                handle: normalizedCode,
                theme: theme
            )
        )
        save()
        return true
    }

    func deleteFriends(at offsets: IndexSet) {
        friends.remove(atOffsets: offsets)
        save()
    }

    func markDelivery(eventID: UUID, state: PingDeliveryState) {
        guard let index = recentEvents.firstIndex(where: { $0.id == eventID }) else { return }
        recentEvents[index].deliveryState = state
        save()
    }

    func mergeReceivedPings(_ incomingPings: [ReceivedPing]) -> [ReceivedPing] {
        let existingIDs = Set(receivedPings.map(\.id))
        let newPings = incomingPings.filter { existingIDs.contains($0.id) == false }

        guard !newPings.isEmpty else { return [] }

        receivedPings = Array((newPings + receivedPings)
            .sorted { $0.receivedAt > $1.receivedAt }
            .prefix(20))
        save()
        return newPings
    }

    private func load() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        if let profileData = UserDefaults.standard.data(forKey: profileKey),
           let savedProfile = try? decoder.decode(UserProfile.self, from: profileData) {
            profile = savedProfile
        }

        if let friendData = UserDefaults.standard.data(forKey: friendsKey),
           let savedFriends = try? decoder.decode([PingFriend].self, from: friendData) {
            friends = savedFriends
        } else {
            friends = [
                PingFriend(name: "민준", handle: "@minjun", theme: .mint),
                PingFriend(name: "서연", handle: "@seoyeon", theme: .coral),
                PingFriend(name: "지훈", handle: "@jihoon", theme: .amber)
            ]
        }

        if let eventData = UserDefaults.standard.data(forKey: eventsKey),
           let savedEvents = try? decoder.decode([PingEvent].self, from: eventData) {
            recentEvents = savedEvents
        }

        if let receivedData = UserDefaults.standard.data(forKey: receivedPingsKey),
           let savedReceived = try? decoder.decode([ReceivedPing].self, from: receivedData) {
            receivedPings = savedReceived
        }
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        if let profileData = try? encoder.encode(profile) {
            UserDefaults.standard.set(profileData, forKey: profileKey)
        }

        if let friendData = try? encoder.encode(friends) {
            UserDefaults.standard.set(friendData, forKey: friendsKey)
        }

        if let eventData = try? encoder.encode(recentEvents) {
            UserDefaults.standard.set(eventData, forKey: eventsKey)
        }

        if let receivedData = try? encoder.encode(receivedPings) {
            UserDefaults.standard.set(receivedData, forKey: receivedPingsKey)
        }
    }
}
