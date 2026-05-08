import Foundation
import UserNotifications

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    private let center = UNUserNotificationCenter.current()

    private override init() {
        super.init()
        center.delegate = self
    }

    func requestAuthorization() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return false
        }
    }

    func schedulePingPreview(to friendName: String, message: QuickMessage) async {
        let allowed = await requestAuthorization()
        guard allowed else { return }

        let content = UNMutableNotificationContent()
        content.title = "\(friendName) 호출"
        content.body = message.notificationBody
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)
        try? await center.add(request)
    }

    func scheduleIncomingPing(from senderName: String, body: String) async {
        let allowed = await requestAuthorization()
        guard allowed else { return }

        let content = UNMutableNotificationContent()
        content.title = "\(senderName) 호출"
        content.body = body
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)
        try? await center.add(request)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
