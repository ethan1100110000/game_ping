import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: PingStore
    @EnvironmentObject private var deviceRegistration: DeviceRegistrationManager
    @EnvironmentObject private var settings: AppSettings
    @State private var selectedMessage: QuickMessage = .gameStarted
    @State private var serverStatus: PingServerStatus = .checking
    @State private var isShowingProfile = false
    @State private var isShowingAddFriend = false
    @State private var toast: Toast?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                AppColor.background
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        HeaderView(status: serverStatus)
                        MessagePicker(selectedMessage: $selectedMessage)

                        PartyPingButton {
                            pingParty()
                        }

                        InboxSection(pings: store.receivedPings)

                        FriendsSection(
                            selectedMessage: selectedMessage,
                            onPing: ping(friend:)
                        )

                        RecentSection(events: store.recentEvents)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
                    .padding(.bottom, 28)
                }

                if let toast {
                    ToastView(toast: toast)
                        .padding(.bottom, 18)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .navigationTitle("GamePing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        isShowingProfile = true
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("내 프로필")
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isShowingAddFriend = true
                    } label: {
                        Image(systemName: "person.badge.plus")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("친구 추가")
                }
            }
            .sheet(isPresented: $isShowingAddFriend) {
                AddFriendView()
                    .environmentObject(store)
            }
            .sheet(isPresented: $isShowingProfile) {
                ProfileView(
                    serverStatus: serverStatus,
                    deviceRegistrationState: deviceRegistration.state
                )
                    .environmentObject(store)
                    .environmentObject(deviceRegistration)
                    .environmentObject(settings)
            }
            .task {
                await reconnectToServer()
                await pollInbox()
            }
            .onChange(of: settings.serverURLString) { _, _ in
                Task {
                    await reconnectToServer()
                }
            }
            .onChange(of: settings.apiToken) { _, _ in
                Task {
                    await reconnectToServer()
                }
            }
        }
    }

    private func ping(friend: PingFriend) {
        switch store.ping(friend, message: selectedMessage) {
        case .sent(let event):
            showToast("\(event.friendName) 전송 중", systemImage: "paperplane.fill")
            Task {
                await deliver(event: event, to: friend, shouldToast: true)
            }
        case .cooledDown(let secondsLeft):
            showToast("\(secondsLeft)초 후 다시 가능", systemImage: "timer")
        }
    }

    private func pingParty() {
        let friends = store.friends
        var sentPairs: [(PingFriend, PingEvent)] = []
        var cooldowns: [Int] = []

        for friend in friends {
            switch store.ping(friend, message: selectedMessage) {
            case .sent(let event):
                sentPairs.append((friend, event))
            case .cooledDown(let secondsLeft):
                cooldowns.append(secondsLeft)
            }
        }

        if sentPairs.isEmpty {
            let seconds = cooldowns.min() ?? 1
            showToast("\(seconds)초 후 파티 호출 가능", systemImage: "timer")
            return
        }

        showToast("\(sentPairs.count)명 전송 중", systemImage: "paperplane.fill")
        Task {
            var serverCount = 0

            for pair in sentPairs {
                let delivered = await deliver(event: pair.1, to: pair.0, shouldToast: false)
                if delivered {
                    serverCount += 1
                }
            }

            await MainActor.run {
                if serverCount == sentPairs.count {
                    showToast("\(serverCount)명 서버 전송 완료", systemImage: "network")
                } else if serverCount > 0 {
                    showToast("\(serverCount)명 서버, 나머지 로컬", systemImage: "bell.badge.fill")
                } else {
                    showToast("로컬 알림 미리보기 완료", systemImage: "iphone")
                }
            }
        }
    }

    private func deliver(event: PingEvent, to friend: PingFriend, shouldToast: Bool) async -> Bool {
        let result = await PingDeliveryClient.shared.send(
            event: event,
            to: friend,
            senderName: store.profile.displayName
        )
        await NotificationManager.shared.schedulePingPreview(to: event.friendName, message: event.message)

        switch result {
        case .success(let receipt):
            await MainActor.run {
                if receipt.status == "unresolved" {
                    store.markDelivery(eventID: event.id, state: .localPreview)
                    if shouldToast {
                        showToast("\(event.friendName) 미등록, 로컬 미리보기", systemImage: "iphone")
                    }
                } else {
                    serverStatus = .online
                    store.markDelivery(eventID: event.id, state: .mockServer)
                    if shouldToast {
                        showToast("\(event.friendName) 서버 전송 완료", systemImage: "network")
                    }
                }
            }
            return receipt.status != "unresolved"
        case .failure:
            await MainActor.run {
                serverStatus = .offline
                store.markDelivery(eventID: event.id, state: .localPreview)
                if shouldToast {
                    showToast("\(event.friendName) 로컬 미리보기", systemImage: "iphone")
                }
            }
            return false
        }
    }

    private func refreshServerStatus() async {
        let status = await PingDeliveryClient.shared.checkHealth()
        await MainActor.run {
            serverStatus = status
        }
    }

    private func reconnectToServer() async {
        await refreshServerStatus()
        await deviceRegistration.register(profile: store.profile)
        await refreshInbox(shouldNotify: false)
    }

    private func pollInbox() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(6))
            await refreshInbox(shouldNotify: true)
        }
    }

    private func refreshInbox(shouldNotify: Bool) async {
        let result = await PingDeliveryClient.shared.fetchInbox(for: store.profile)

        switch result {
        case .success(let pings):
            let newPings = await MainActor.run {
                serverStatus = .online
                return store.mergeReceivedPings(pings)
            }

            guard shouldNotify, !newPings.isEmpty else { return }

            for ping in newPings {
                await NotificationManager.shared.scheduleIncomingPing(from: ping.senderName, body: ping.body)
            }

            if let latestPing = newPings.first {
                await MainActor.run {
                    showToast("\(latestPing.senderName) 호출", systemImage: "bell.badge.fill")
                }
            }
        case .failure:
            await MainActor.run {
                serverStatus = .offline
            }
        }
    }

    private func showToast(_ message: String, systemImage: String) {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            toast = Toast(message: message, systemImage: systemImage)
        }

        Task {
            try? await Task.sleep(for: .seconds(2))
            await MainActor.run {
                withAnimation(.easeInOut(duration: 0.18)) {
                    toast = nil
                }
            }
        }
    }
}

private struct HeaderView: View {
    var status: PingServerStatus

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text("원터치 호출")
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .foregroundStyle(AppColor.ink)

                HStack(spacing: 6) {
                    Circle()
                        .fill(status == .online ? AppColor.green : AppColor.amber)
                        .frame(width: 7, height: 7)
                    Text(status.label)
                        .font(.system(.caption, design: .rounded, weight: .semibold))
                        .foregroundStyle(status == .online ? AppColor.green : AppColor.muted)
                }
            }

            Spacer()

            Image(systemName: "gamecontroller.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(AppColor.ink)
                .frame(width: 48, height: 48)
                .background(AppColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(AppColor.line, lineWidth: 1)
                )
        }
    }
}

private struct MessagePicker: View {
    @Binding var selectedMessage: QuickMessage

    var body: some View {
        Picker("메시지", selection: $selectedMessage) {
            ForEach(QuickMessage.allCases) { message in
                Text(message.rawValue)
                    .tag(message)
            }
        }
        .pickerStyle(.segmented)
    }
}

private struct PartyPingButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "megaphone.fill")
                    .font(.system(size: 18, weight: .bold))
                Text("파티 호출")
                    .font(.system(.headline, design: .rounded, weight: .bold))
                Spacer()
                Image(systemName: "arrow.up.forward")
                    .font(.system(size: 16, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .frame(height: 58)
            .background(AppColor.green)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct FriendsSection: View {
    @EnvironmentObject private var store: PingStore
    var selectedMessage: QuickMessage
    var onPing: (PingFriend) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(title: "친구", systemImage: "person.2.fill")

            LazyVStack(spacing: 10) {
                ForEach(store.friends) { friend in
                    FriendRow(
                        friend: friend,
                        action: { onPing(friend) }
                    )
                }
                .onDelete(perform: store.deleteFriends)
            }
        }
    }
}

private struct FriendRow: View {
    var friend: PingFriend
    var action: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            rowBody(secondsLeft: secondsLeft(at: context.date))
        }
    }

    private func secondsLeft(at date: Date) -> Int {
        guard let lastPingAt = friend.lastPingAt else { return 0 }
        let elapsed = date.timeIntervalSince(lastPingAt)
        return max(0, Int(ceil(30 - elapsed)))
    }

    private func rowBody(secondsLeft: Int) -> some View {
        let ready = secondsLeft == 0

        return HStack(spacing: 12) {
            Text(String(friend.name.prefix(1)))
                .font(.system(.headline, design: .rounded, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(friend.theme.color)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(friend.name)
                    .font(.system(.body, design: .rounded, weight: .semibold))
                    .foregroundStyle(AppColor.ink)
                    .lineLimit(1)

                Text(friend.handle)
                    .font(.system(.caption, design: .rounded))
                    .foregroundStyle(AppColor.muted)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Button(action: action) {
                HStack(spacing: 6) {
                    Image(systemName: ready ? "bell.and.waves.left.and.right.fill" : "timer")
                    Text(ready ? "호출" : "\(secondsLeft)s")
                        .monospacedDigit()
                }
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(ready ? .white : AppColor.muted)
                .frame(width: 88, height: 38)
                .background(ready ? friend.theme.color : Color(red: 0.90, green: 0.91, blue: 0.92))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!ready)
        }
        .padding(12)
        .background(AppColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(AppColor.line, lineWidth: 1)
        )
    }
}

private struct InboxSection: View {
    var pings: [ReceivedPing]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(title: "받은 호출", systemImage: "bell.badge.fill")

            if pings.isEmpty {
                EmptyInboxView()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(pings.prefix(3))) { ping in
                        HStack(spacing: 10) {
                            Image(systemName: "bell.circle.fill")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(AppColor.green)

                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(ping.senderName)
                                        .font(.system(.subheadline, design: .rounded, weight: .bold))
                                        .foregroundStyle(AppColor.ink)
                                        .lineLimit(1)

                                    Text(ping.displayMessage)
                                        .font(.system(.caption, design: .rounded, weight: .semibold))
                                        .foregroundStyle(AppColor.green)
                                        .lineLimit(1)
                                }

                                Text(ping.body)
                                    .font(.system(.caption, design: .rounded))
                                    .foregroundStyle(AppColor.muted)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 8)

                            Text(ping.receivedAt.pingTimeString)
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(AppColor.muted)
                                .monospacedDigit()
                        }
                        .padding(.vertical, 10)

                        if ping.id != pings.prefix(3).last?.id {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(AppColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(AppColor.line, lineWidth: 1)
                )
            }
        }
    }
}

private struct EmptyInboxView: View {
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "bell.slash.circle")
                .foregroundStyle(AppColor.muted)
            Text("새 호출 없음")
                .font(.system(.subheadline, design: .rounded, weight: .semibold))
                .foregroundStyle(AppColor.muted)
            Spacer()
        }
        .padding(12)
        .background(AppColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(AppColor.line, lineWidth: 1)
        )
    }
}

private struct RecentSection: View {
    var events: [PingEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(title: "최근 호출", systemImage: "clock.fill")

            if events.isEmpty {
                EmptyRecentView()
            } else {
                VStack(spacing: 0) {
                    ForEach(events.prefix(4)) { event in
                        HStack {
                            DeliveryStateIcon(state: event.deliveryState)
                            Text(event.friendName)
                            .font(.system(.subheadline, design: .rounded, weight: .semibold))
                            Text(event.message.rawValue)
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(AppColor.muted)
                            Spacer()
                            Text(event.sentAt.pingTimeString)
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(AppColor.muted)
                                .monospacedDigit()
                        }
                        .padding(.vertical, 10)

                        if event.id != events.prefix(4).last?.id {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(AppColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(AppColor.line, lineWidth: 1)
                )
            }
        }
    }
}

private struct DeliveryStateIcon: View {
    var state: PingDeliveryState?

    var body: some View {
        Image(systemName: systemImage)
            .foregroundStyle(color)
    }

    private var systemImage: String {
        switch state {
        case .pending:
            return "paperplane.circle.fill"
        case .mockServer:
            return "network"
        case .localPreview, .none:
            return "iphone.circle.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    private var color: Color {
        switch state {
        case .pending:
            return AppColor.muted
        case .mockServer:
            return AppColor.green
        case .localPreview, .none:
            return AppColor.amber
        case .failed:
            return AppColor.coral
        }
    }
}

private struct EmptyRecentView: View {
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
                .foregroundStyle(AppColor.amber)
            Text("대기 중")
                .font(.system(.subheadline, design: .rounded, weight: .semibold))
                .foregroundStyle(AppColor.muted)
            Spacer()
        }
        .padding(12)
        .background(AppColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(AppColor.line, lineWidth: 1)
        )
    }
}

private struct SectionTitle: View {
    var title: String
    var systemImage: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: systemImage)
            Text(title)
        }
        .font(.system(.subheadline, design: .rounded, weight: .bold))
        .foregroundStyle(AppColor.ink)
    }
}

private struct AddFriendView: View {
    @EnvironmentObject private var store: PingStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var handle = ""
    @State private var inviteCode = ""
    @State private var isResolvingInvite = false
    @State private var inviteStatus: String?
    @State private var theme: FriendTheme = .mint

    var body: some View {
        NavigationStack {
            Form {
                Section("초대 코드") {
                    TextField("GP-ABC123", text: $inviteCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()

                    Button {
                        resolveInvite()
                    } label: {
                        Label(isResolvingInvite ? "찾는 중" : "코드로 추가", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isResolvingInvite)

                    if let inviteStatus {
                        Text(inviteStatus)
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(AppColor.muted)
                    }
                }

                Section("직접 추가") {
                    TextField("이름", text: $name)
                    TextField("@handle", text: $handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("색상") {
                    Picker("색상", selection: $theme) {
                        ForEach(FriendTheme.allCases) { theme in
                            HStack {
                                Circle()
                                    .fill(theme.color)
                                    .frame(width: 12, height: 12)
                                Text(theme.displayName)
                            }
                            .tag(theme)
                        }
                    }
                    .pickerStyle(.inline)
                }
            }
            .navigationTitle("친구 추가")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("추가") {
                        store.addFriend(name: name, handle: handle, theme: theme)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func resolveInvite() {
        isResolvingInvite = true
        inviteStatus = nil

        Task {
            let result = await PingDeliveryClient.shared.resolveFriend(inviteCode: inviteCode)

            await MainActor.run {
                isResolvingInvite = false

                switch result {
                case .success(let friend):
                    if store.addResolvedFriend(friend) {
                        dismiss()
                    } else {
                        inviteStatus = "이미 추가됐거나 내 코드야."
                    }
                case .failure:
                    if store.addFriendFromInviteCode(inviteCode) {
                        dismiss()
                    } else {
                        inviteStatus = "코드를 확인해줘."
                    }
                }
            }
        }
    }
}

private struct ProfileView: View {
    @EnvironmentObject private var store: PingStore
    @EnvironmentObject private var deviceRegistration: DeviceRegistrationManager
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var serverURLString = ""
    @State private var apiToken = ""
    @State private var connectionTestStatus: String?
    @State private var isTestingConnection = false
    var serverStatus: PingServerStatus
    var deviceRegistrationState: DeviceRegistrationState

    var body: some View {
        NavigationStack {
            Form {
                Section("내 정보") {
                    TextField("표시 이름", text: $displayName)

                    HStack {
                        Text("초대 코드")
                        Spacer()
                        Text(store.profile.inviteCode)
                            .font(.system(.body, design: .monospaced, weight: .bold))
                            .foregroundStyle(AppColor.ink)
                    }

                    ShareLink(item: "GamePing 초대 코드: \(store.profile.inviteCode)") {
                        Label("코드 공유", systemImage: "square.and.arrow.up")
                    }
                }

                Section("서버") {
                    TextField("서버 URL", text: $serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    SecureField("API 토큰", text: $apiToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button {
                        testConnection()
                    } label: {
                        Label(isTestingConnection ? "확인 중" : "연결 확인", systemImage: "network")
                    }
                    .disabled(isTestingConnection)

                    Button {
                        serverURLString = AppSettings.defaultServerURL
                    } label: {
                        Label("localhost로 변경", systemImage: "arrow.counterclockwise")
                    }

                    if let connectionTestStatus {
                        Text(connectionTestStatus)
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(AppColor.muted)
                    }

                    HStack {
                        Circle()
                            .fill(serverStatus == .online ? AppColor.green : AppColor.amber)
                            .frame(width: 8, height: 8)
                        Text(serverStatus.label)
                        Spacer()
                    }

                    HStack {
                        Image(systemName: "iphone.gen3")
                        Text(deviceRegistrationState.label)
                        Spacer()
                    }
                }
            }
            .navigationTitle("프로필")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                displayName = store.profile.displayName
                serverURLString = settings.serverURLString
                apiToken = settings.apiToken
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") {
                        settings.update(serverURLString: serverURLString, apiToken: apiToken)
                        store.updateProfile(displayName: displayName)
                        Task {
                            await deviceRegistration.register(profile: store.profile)
                        }
                        dismiss()
                    }
                    .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func testConnection() {
        isTestingConnection = true
        connectionTestStatus = nil
        settings.update(serverURLString: serverURLString, apiToken: apiToken)

        Task {
            let status = await PingDeliveryClient.shared.checkHealth()
            await MainActor.run {
                isTestingConnection = false
                connectionTestStatus = status == .online ? "연결 성공" : "연결 실패"
            }
        }
    }
}

private struct Toast: Equatable {
    var message: String
    var systemImage: String
}

private struct ToastView: View {
    var toast: Toast

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: toast.systemImage)
            Text(toast.message)
                .lineLimit(1)
        }
        .font(.system(.subheadline, design: .rounded, weight: .bold))
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(AppColor.ink)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: .black.opacity(0.14), radius: 14, y: 8)
    }
}
