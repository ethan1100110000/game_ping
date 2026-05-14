import Foundation

struct PingDeliveryPayload: Codable, Equatable {
    var senderName: String
    var friendID: String
    var friendName: String
    var friendHandle: String
    var clientPingID: String
    var message: String
    var notificationBody: String
    var sentAt: Date
}

struct PingDeliveryReceipt: Codable, Equatable {
    var ok: Bool
    var id: String
    var status: String
    var receivedAt: String
}

struct DeviceRegistrationPayload: Codable, Equatable {
    var userID: String
    var userName: String
    var inviteCode: String
    var pushToken: String
    var platform: String
    var appVersion: String
}

struct DeviceRegistrationReceipt: Codable, Equatable {
    var ok: Bool
    var status: String
}

struct FriendResolutionResponse: Codable, Equatable {
    var ok: Bool
    var friend: ResolvedFriend
}

struct InboxResponse: Codable, Equatable {
    var ok: Bool
    var pings: [InboxPingPayload]
}

struct InboxPingPayload: Codable, Equatable {
    var id: String
    var status: String
    var receivedAt: String
    var senderName: String
    var message: String
    var body: String
}

struct ResolvedFriend: Codable, Equatable {
    var userID: String
    var userName: String
    var inviteCode: String
    var hasPushToken: Bool
}

struct PingServerHealth: Codable, Equatable {
    var ok: Bool
    var service: String
    var pings: Int
    var devices: Int?
    var apnsConfigured: Bool?
}

enum PingServerStatus: Equatable {
    case checking
    case online
    case offline

    var label: String {
        switch self {
        case .checking:
            return "확인 중"
        case .online:
            return "서버 연결됨"
        case .offline:
            return "로컬 미리보기"
        }
    }
}

enum PingDeliveryError: Error, LocalizedError, Equatable {
    case badResponse
    case serverStatus(Int)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .badResponse:
            return "서버 응답을 읽지 못했어."
        case .serverStatus(let status):
            return "서버가 \(status)를 반환했어."
        case .transport(let message):
            return message
        }
    }
}

final class PingDeliveryClient {
    static let shared = PingDeliveryClient()

    private init() {}

    func send(
        event: PingEvent,
        to friend: PingFriend,
        senderName: String
    ) async -> Result<PingDeliveryReceipt, PingDeliveryError> {
        let payload = PingDeliveryPayload(
            senderName: senderName,
            friendID: friend.id.uuidString,
            friendName: friend.name,
            friendHandle: friend.handle,
            clientPingID: event.id.uuidString,
            message: event.message.rawValue,
            notificationBody: event.message.notificationBody,
            sentAt: event.sentAt
        )

        do {
            guard let url = makeURL(path: "/pings") else {
                return .failure(.badResponse)
            }

            var request = makeRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.httpBody = try makeEncoder().encode(payload)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.badResponse)
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                return .failure(.serverStatus(httpResponse.statusCode))
            }

            let receipt = try JSONDecoder().decode(PingDeliveryReceipt.self, from: data)
            return .success(receipt)
        } catch let error as PingDeliveryError {
            return .failure(error)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
    }

    func checkHealth() async -> PingServerStatus {
        do {
            guard let url = makeURL(path: "/health") else {
                return .offline
            }

            var request = makeRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = 8

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return .offline
            }

            let health = try JSONDecoder().decode(PingServerHealth.self, from: data)
            return health.ok ? .online : .offline
        } catch {
            return .offline
        }
    }

    func registerDevice(
        profile: UserProfile,
        pushToken: String
    ) async -> Result<DeviceRegistrationReceipt, PingDeliveryError> {
        let payload = DeviceRegistrationPayload(
            userID: profile.id.uuidString,
            userName: profile.displayName,
            inviteCode: profile.inviteCode,
            pushToken: pushToken,
            platform: "ios",
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        )

        do {
            guard let url = makeURL(path: "/devices") else {
                return .failure(.badResponse)
            }

            var request = makeRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.httpBody = try JSONEncoder().encode(payload)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.badResponse)
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                return .failure(.serverStatus(httpResponse.statusCode))
            }

            let receipt = try JSONDecoder().decode(DeviceRegistrationReceipt.self, from: data)
            return .success(receipt)
        } catch let error as PingDeliveryError {
            return .failure(error)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
    }

    func resolveFriend(inviteCode: String) async -> Result<PingFriend, PingDeliveryError> {
        let normalizedCode = normalizeInviteCode(inviteCode)
        guard let encodedCode = normalizedCode.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = makeURL(path: "/invites/\(encodedCode)") else {
            return .failure(.badResponse)
        }

        do {
            var request = makeRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = 12

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.badResponse)
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                return .failure(.serverStatus(httpResponse.statusCode))
            }

            let resolved = try JSONDecoder().decode(FriendResolutionResponse.self, from: data).friend
            let id = UUID(uuidString: resolved.userID) ?? UUID()
            return .success(
                PingFriend(
                    id: id,
                    name: resolved.userName,
                    handle: resolved.inviteCode,
                    theme: .mint
                )
            )
        } catch let error as PingDeliveryError {
            return .failure(error)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
    }

    func fetchInbox(for profile: UserProfile) async -> Result<[ReceivedPing], PingDeliveryError> {
        guard let encodedID = profile.id.uuidString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = makeURL(path: "/inbox/\(encodedID)") else {
            return .failure(.badResponse)
        }

        do {
            var request = makeRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = 12

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.badResponse)
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                return .failure(.serverStatus(httpResponse.statusCode))
            }

            let payload = try JSONDecoder().decode(InboxResponse.self, from: data)
            return .success(payload.pings.map { ping in
                ReceivedPing(
                    id: ping.id,
                    senderName: ping.senderName,
                    messageText: ping.message,
                    body: ping.body,
                    receivedAt: parseServerDate(ping.receivedAt)
                )
            })
        } catch let error as PingDeliveryError {
            return .failure(error)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
    }

    private func normalizeInviteCode(_ code: String) -> String {
        let compact = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
            .uppercased()

        return compact.hasPrefix("GP-") ? compact : "GP-\(compact)"
    }

    private func makeURL(path: String) -> URL? {
        let base = AppSettings.persistedServerURLString()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(base)\(path)")
    }

    private func makeRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ios", forHTTPHeaderField: "X-GamePing-Client")

        let token = AppSettings.persistedAPIToken()
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        return request
    }

    private func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private func parseServerDate(_ value: String) -> Date {
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        if let date = fractionalFormatter.date(from: value) {
            return date
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value) ?? Date()
    }
}
