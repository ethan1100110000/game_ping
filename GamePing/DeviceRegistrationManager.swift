import Foundation
import UIKit

@MainActor
final class DeviceRegistrationManager: ObservableObject {
    static let shared = DeviceRegistrationManager()

    @Published private(set) var state: DeviceRegistrationState = .idle

    private var apnsToken: String?
    private var lastProfile: UserProfile?

    private init() {}

    func setAPNSToken(_ data: Data) {
        apnsToken = data.map { String(format: "%02x", $0) }.joined()

        if let lastProfile {
            Task {
                await register(profile: lastProfile)
            }
        }
    }

    func markRemoteRegistrationFailed() {
        if apnsToken == nil {
            state = .simulatorFallback
        }
    }

    func register(profile: UserProfile) async {
        lastProfile = profile
        state = .registering

        _ = await NotificationManager.shared.requestAuthorization()
        UIApplication.shared.registerForRemoteNotifications()

        let pushToken = apnsToken ?? "SIMULATOR-\(profile.id.uuidString)"
        let result = await PingDeliveryClient.shared.registerDevice(
            profile: profile,
            pushToken: pushToken
        )

        switch result {
        case .success:
            state = apnsToken == nil ? .simulatorFallback : .registered
        case .failure:
            state = .offline
        }
    }
}

enum DeviceRegistrationState: Equatable {
    case idle
    case registering
    case registered
    case simulatorFallback
    case offline

    var label: String {
        switch self {
        case .idle:
            return "기기 등록 대기"
        case .registering:
            return "기기 등록 중"
        case .registered:
            return "푸시 기기 등록됨"
        case .simulatorFallback:
            return "시뮬레이터 등록됨"
        case .offline:
            return "기기 등록 실패"
        }
    }
}
