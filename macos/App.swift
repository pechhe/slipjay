import SwiftUI
import AppKit
import UserNotifications

@MainActor final class RunnerAppModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var state = RunnerState()
    @Published var now = Date()
    private var statusTimer: Timer?
    @Published var permission = "Checking notification permission"
    @Published var error: String?
    @Published var logText = ""
    @Published var logTitle = ""
    @Published var landingFailures = UserDefaults.standard.bool(forKey: "landingFailures") {
        didSet { UserDefaults.standard.set(landingFailures, forKey: "landingFailures") }
    }
    private var logRequest = 0
    private var logWindow: NSWindow?
    private var watcher: Process?
    private var stopped = false
    private var generation = 0
    private var notificationKeys = Set(UserDefaults.standard.stringArray(forKey: "noticeKeys") ?? [])
    private var pendingKeys = Set<String>()
    private var noticeBacklog = (UserDefaults.standard.data(forKey: "pendingNotices").flatMap { try? JSONDecoder().decode(NoticeBacklog.self, from: $0) }) ?? NoticeBacklog()
    private func saveBacklog() {
        if let data = try? JSONEncoder().encode(noticeBacklog) { UserDefaults.standard.set(data, forKey: "pendingNotices") }
    }
    let cli = ProcessInfo.processInfo.environment["SLIPJAY_CLI"] ?? NSHomeDirectory() + "/.bun/bin/slipjay"
    var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = NSHomeDirectory() + "/.bun/bin:" + NSHomeDirectory() + "/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        return env
    }
    override init() {
        super.init()
        let defaults = UserDefaults.standard
        let origin = (defaults.object(forKey: "contactOrigin") as? Date) ?? Date()
        state = RunnerState(lastContact: defaults.object(forKey: "lastRunnerContact") as? Date, startedAt: origin)
        defaults.set(origin, forKey: "contactOrigin")
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in self.permission = granted ? "Notifications allowed" : "Notifications denied — enable in System Settings"; self.deliverNotices() }
        }
        statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.now = Date(); self?.deliverNotices() }
        }
        start()
    }
    func start() {
        guard !stopped else { return }
        generation += 1
        let round = generation
        if let index = CommandLine.arguments.firstIndex(of: "--fixture"), CommandLine.arguments.count > index + 1 {
            let path = CommandLine.arguments[index + 1]
            DispatchQueue.global(qos: .utility).async {
                do {
                    let data = try Data(contentsOf: URL(fileURLWithPath: path))
                    guard data.count <= 8 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
                        let text = String(line)
                        DispatchQueue.main.sync { MainActor.assumeIsolated { self.receive(text) } }
                    }
                } catch { Task { @MainActor in self.error = "Fixture could not be read" } }
            }
            return
        }
        let process = Process(), output = Pipe(), diagnostic = Pipe()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = ["watch", "--json"]
        process.environment = environment
        process.standardOutput = output; process.standardError = diagnostic
        watcher = process
        diagnostic.fileHandleForReading.readabilityHandler = { handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            // CLI diagnostics may contain private operational context; do not display raw stderr.
        }
        process.terminationHandler = { _ in
            diagnostic.fileHandleForReading.readabilityHandler = nil
            diagnostic.fileHandleForReading.closeFile()
            Task { @MainActor in
                guard self.generation == round, !self.stopped else { return }
                self.watcher = nil; self.state.connection = "disconnected"
                self.error = "Watcher stopped. Check the configured SlipJay CLI and runner connection."
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if !self.stopped { self.start() }
            }
        }
        do { try process.run() } catch {
            self.error = "Could not launch SlipJay at \(cli)"; watcher = nil
            Task { try? await Task.sleep(nanoseconds: 3_000_000_000); if !stopped { start() } }
            return
        }
        DispatchQueue.global(qos: .utility).async {
            defer { output.fileHandleForReading.closeFile() }
            var pending = Data()
            while true {
                let chunk = output.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                pending.append(chunk)
                if pending.count > 4 * 1024 * 1024 {
                    process.terminate()
                    Task { @MainActor in self.error = "Watch output exceeded its line limit" }
                    break
                }
                while let end = pending.firstIndex(of: 10) {
                    let line = String(decoding: pending[..<end], as: UTF8.self)
                    pending.removeSubrange(...end)
                    DispatchQueue.main.sync { MainActor.assumeIsolated { if self.generation == round { self.receive(line) } } }
                }
            }
        }
    }
    func receive(_ line: String) {
        do {
            let before = state.lastContact
            try state.consume(line: line, receivedAt: Date())
            if state.lastContact != before, let contact = state.lastContact {
                UserDefaults.standard.set(contact, forKey: "lastRunnerContact")
            }
            error = nil; deliverNotices()
        }
        catch { self.error = "Unsupported or malformed runner watch message" }
    }
    func stop() { statusTimer?.invalidate(); statusTimer = nil; stopped = true; generation += 1; watcher?.terminate(); watcher = nil }
    func command(_ arguments: [String], completion: @escaping @MainActor (String) -> Void) {
        let executable = cli, env = environment
        DispatchQueue.global(qos: .utility).async {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
            process.environment = env; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: deadline)
                defer { deadline.cancel(); pipe.fileHandleForReading.closeFile() }
                var data = Data()
                while true {
                    let chunk = pipe.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    if data.count + chunk.count > 4 * 1024 * 1024 { process.terminate(); break }
                    data.append(chunk)
                }
                process.waitUntilExit()
                let text = String(decoding: data, as: UTF8.self)
                Task { @MainActor in
                    if process.terminationStatus != 0 { self.error = text.isEmpty ? "SlipJay refused or failed this action; inspect the CLI runner log." : text }
                    completion(text)
                }
            } catch { Task { @MainActor in self.error = "Could not launch SlipJay" } }
        }
    }
    func openLog(_ id: String) {
        logRequest += 1
        let request = logRequest
        logTitle = id; logText = "Loading…"
        guard let arguments = ControlPolicy.logCommand(operationId: id) else { return }
        command(arguments) { if self.logRequest == request { self.logText = $0 } }
        showLogWindow("SlipJay run log — \(id)")
    }
    func showLogWindow(_ title: String) {
        if let window = logWindow { window.title = title; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 840, height: 600), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        logWindow = window
        window.title = title; window.contentView = NSHostingView(rootView: LogView(model: self)); window.isReleasedWhenClosed = false
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func deliverNotices() {
        let proposals = notices(state: state, now: Date(), landingFailures: landingFailures)
        noticeBacklog.update(proposals, accepted: notificationKeys)
        saveBacklog()
        for notice in noticeBacklog.pending where !notificationKeys.contains(notice.id) && !pendingKeys.contains(notice.id) {
            pendingKeys.insert(notice.id)
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                Task { @MainActor in
                    self.permission = (settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional)
                        ? "Notifications allowed" : "Notifications denied — enable in System Settings"
                    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                        self.pendingKeys.remove(notice.id); return
                    }
                    guard self.noticeBacklog.pending.contains(where: { $0.id == notice.id }) else {
                        self.pendingKeys.remove(notice.id); return
                    }
                    let content = UNMutableNotificationContent()
                    content.title = notice.title; content.body = notice.body; content.sound = .default
                    content.userInfo["noticeTitle"] = notice.title; content.userInfo["noticeBody"] = notice.body
                    if let id = notice.operationId { content.userInfo["operationId"] = id }
                    do {
                        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
                        self.notificationKeys.insert(notice.id)
                        self.noticeBacklog.accepted(notice.id); self.saveBacklog()
                        UserDefaults.standard.set(Array(self.notificationKeys), forKey: "noticeKeys")
                    } catch { self.error = "The OS refused a notification request" }
                    self.pendingKeys.remove(notice.id)
                }
            }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["operationId"] as? String {
            Task { @MainActor in self.openLog(id) }
        }
        else if let body = response.notification.request.content.userInfo["noticeBody"] as? String {
            let title = response.notification.request.content.userInfo["noticeTitle"] as? String ?? "SlipJay needs attention"
            Task { @MainActor in
                self.logRequest += 1; self.logText = body; self.showLogWindow(title)
            }
        }
        completionHandler()
    }
}
struct LogView: View {
    @ObservedObject var model: RunnerAppModel
    var body: some View { ScrollView { Text(model.logText).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() } }
}
struct RunnerMenu: View {
    @ObservedObject var model: RunnerAppModel
    @State private var controls = ControlPolicy()
    private var cancelling: Operation? { controls.pendingCancellation }
    func age(_ stamp: String?) -> String {
        guard let date = runnerDate(stamp) else { return "unknown" }
        return "\(max(0, Int(Date().timeIntervalSince(date))))s"
    }
    @ViewBuilder func operation(_ item: Operation) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(item.kind) · \(item.repo) · \(item.commitId.prefix(8))").font(.headline)
            Text("Outcome: \(item.status)\(item.result?["result"]?["merge"]?.string.map { " · merge " + String($0.prefix(12)) } ?? "")").font(.caption)
            if let reason = item.result?["reason"]?.string { Text(reason).font(.caption) }
            Text("\(item.submittedBy) · \(item.stage) · \(age(item.stageStartedAt))").font(.caption)
            if let deployId = item.result?["deploy"]?.string, let deploy = model.state.operations[deployId] {
                Text("Production: \(deploy.result?["deployment"]?["rollback"]?["automatic"]?.bool == true ? "rolled back" : deploy.status) · \(deploy.result?["deployment"]?["rollback"]?["reason"]?.string ?? "")").font(.caption)
            }
            if let deployId = item.result?["deploy"]?.string, let deploy = model.state.operations[deployId] {
                Text("\(deploy.result?["deployment"]?["migrations"]?["status"]?.string ?? "Migration outcome unavailable") · \(deploy.result?["reason"]?.string ?? "")").font(.caption)
            }
            Text("Timing: \(item.timing?.state ?? "unknown") · median \(item.timing?.medianMs.map { "\(Int($0 / 1000))s" } ?? "unavailable")").font(.caption)
            if let position = item.position { Text("Queue \(position) · behind \(item.waitingFor ?? "none")").font(.caption) }
            HStack {
                Button("Log") { model.openLog(item.id) }
                if item.status == "queued" { Button("Cancel…") { _ = controls.requestCancellation(item) } }
                if item.status == "running" {
                    Button("Kill") { if let arguments = ControlPolicy.killCommand(for: item) { model.command(arguments) { _ in } } }.disabled(ControlPolicy.killCommand(for: item) == nil)
                    if let reason = item.kill?.reason { Text(reason).font(.caption) }
                }
            }
        }.padding(.vertical, 5)
    }
    var body: some View {
        Group {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("SlipJay · \(model.state.connection)").font(.title3)
                    Text("Last contact: \(model.state.lastContact.map { Int(Date().timeIntervalSince($0)).description + "s ago" } ?? "unavailable")").font(.caption)
                    if let error = model.error { Text(error).foregroundColor(.red).textSelection(.enabled) }
                    if let snapshot = model.state.snapshot {
                        if let pause = snapshot.paused { Text("Paused by \(pause.by) · \(age(pause.at))") }
                        ForEach(snapshot.held, id: \.repo) { held in
                            Text("Held \(held.repo) · \(held.commitId.prefix(8)) · \(age(held.since)) · retries \(held.retries)\n\(held.reason)").foregroundColor(.red)
                        }
                        Text("Serial lane").font(.headline)
                        if snapshot.lanes.serial.isEmpty { Text("Idle") }
                        ForEach(snapshot.lanes.serial) { operation($0) }
                        Divider(); Text("Deploy lane").font(.headline)
                        if snapshot.lanes.deploy.isEmpty { Text("Idle") }
                        ForEach(snapshot.lanes.deploy) { operation($0) }
                        Divider(); Text("Last staging attempts").font(.headline)
                        ForEach(snapshot.lastStagingDeploys) { item in
                            Text("\(item.repo) · \(item.commitId.prefix(8)) · \(item.status) · \(age(item.finishedAt ?? item.submittedAt))")
                            Button("Log") { model.openLog(item.id) }
                        }
                        Text("Recent releases").font(.headline)
                        ForEach(snapshot.recentReleases) { operation($0) }
                        Text("Hourly suite: \(snapshot.lastSuite["status"]?.string ?? "unavailable")")
                        HStack {
                            Button(snapshot.paused == nil ? "Pause" : "Resume") { model.command(["runner", snapshot.paused == nil ? "pause" : "resume"]) { _ in } }
                        }
                    } else { Text("Waiting for runner snapshot") }
                    Divider()
                    Text(model.permission).font(.caption)
                    Toggle("Notify landing failures", isOn: $model.landingFailures)
                    Text("CLI: \(model.cli)").font(.caption).textSelection(.enabled)
                    Button("Quit") { model.stop(); NSApp.terminate(nil) }
                }.padding().frame(width: 480, alignment: .leading)
            }.frame(width: 480, height: 620)
        }.confirmationDialog("Cancel \(cancelling?.kind ?? "operation") in \(cancelling?.repo ?? "") (\(cancelling?.commitId.prefix(8) ?? ""))?", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { controls.dismissCancellation() } })) {
            Button("Cancel queued operation", role: .destructive) { if let item = cancelling, let arguments = controls.confirmCancellation(current: model.state.operations[item.id]) { model.command(arguments) { _ in } } }
            Button("Keep queued", role: .cancel) { controls.dismissCancellation() }
        }
    }
}
@main struct SlipJayApp: App {
    @StateObject private var model = RunnerAppModel()
    var body: some Scene {
        MenuBarExtra { RunnerMenu(model: model) } label: {
            let presentation = statusPresentation(state: model.state, now: model.now)
            Image(systemName: presentation.symbol).foregroundStyle(presentation.kind == "amber" ? Color.orange : presentation.needsAttention ? Color.red : Color.primary).help(presentation.title)
        }.menuBarExtraStyle(.window)
    }
}
