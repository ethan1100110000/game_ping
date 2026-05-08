import SwiftUI

enum AppColor {
    static let background = Color(red: 0.96, green: 0.97, blue: 0.97)
    static let ink = Color(red: 0.08, green: 0.09, blue: 0.10)
    static let muted = Color(red: 0.43, green: 0.46, blue: 0.49)
    static let line = Color(red: 0.84, green: 0.86, blue: 0.87)
    static let surface = Color.white
    static let green = Color(red: 0.08, green: 0.52, blue: 0.36)
    static let coral = Color(red: 0.87, green: 0.25, blue: 0.22)
    static let amber = Color(red: 0.91, green: 0.61, blue: 0.13)
    static let violet = Color(red: 0.42, green: 0.31, blue: 0.72)
}

extension FriendTheme {
    var displayName: String {
        switch self {
        case .mint:
            return "민트"
        case .coral:
            return "코랄"
        case .amber:
            return "앰버"
        case .violet:
            return "바이올렛"
        case .graphite:
            return "그래파이트"
        }
    }

    var color: Color {
        switch self {
        case .mint:
            return Color(red: 0.09, green: 0.63, blue: 0.48)
        case .coral:
            return AppColor.coral
        case .amber:
            return AppColor.amber
        case .violet:
            return AppColor.violet
        case .graphite:
            return Color(red: 0.22, green: 0.24, blue: 0.26)
        }
    }
}

extension Date {
    var pingTimeString: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: self)
    }
}
