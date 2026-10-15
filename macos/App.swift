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
    private var wakeObserver: NSObjectProtocol?
    private var stopped = false
    private var generation = 0
    private var notificationKeys = NoticeHistory(UserDefaults.standard.stringArray(forKey: "noticeKeys") ?? [])
    private var pendingKeys = Set<String>()
    private var noticeBacklog = (UserDefaults.standard.data(forKey: "pendingNotices").flatMap { try? JSONDecoder().decode(NoticeBacklog.self, from: $0) }) ?? NoticeBacklog()
    private func saveBacklog() {
        if let data = try? JSONEncoder().encode(noticeBacklog) { UserDefaults.standard.set(data, forKey: "pendingNotices") }
    }
    let cli = ProcessInfo.processInfo.environment["SLIPJAY_CLI"] ?? NSHomeDirectory() + "/.bun/bin/slipjay"
    var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = NSHomeDirectory() + "/.bun/bin:" + NSHomeDirectory() + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        return env
    }
    override init() {
        super.init()
        let defaults = UserDefaults.standard
        defaults.set(notificationKeys.ids, forKey: "noticeKeys")
        state = RunnerState(lastContact: defaults.object(forKey: "lastRunnerContact") as? Date, cursor: defaults.object(forKey: "watchCursor") as? Int)
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.wake() }
        }
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
        guard !stopped, watcher == nil else { return }
        state.connection = "connecting"
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
                        DispatchQueue.main.sync { MainActor.assumeIsolated { if self.generation == round, !self.stopped { self.receive(text) } } }
                    }
                } catch { Task { @MainActor in
                    if self.generation == round, !self.stopped { self.error = "Fixture could not be read" }
                } }
            }
            return
        }
        let process = Process(), output = Pipe(), diagnostic = Pipe()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = ["watch", "--json"]
        var watchEnvironment = environment
        watchEnvironment.removeValue(forKey: "SLIPJAY_WATCH_CURSOR")
        if let cursor = UserDefaults.standard.object(forKey: "watchCursor") as? Int {
            watchEnvironment["SLIPJAY_WATCH_CURSOR"] = String(cursor)
        }
        process.environment = watchEnvironment
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
                if !self.stopped, self.generation == round { self.start() }
            }
        }
        do { try process.run() } catch {
            diagnostic.fileHandleForReading.readabilityHandler = nil
            diagnostic.fileHandleForReading.closeFile()
            output.fileHandleForReading.closeFile()
            self.error = "Could not launch SlipJay at \(cli)"; watcher = nil
            Task { try? await Task.sleep(nanoseconds: 3_000_000_000); if !stopped, generation == round { start() } }
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
                    Task { @MainActor in
                        if self.generation == round, !self.stopped { self.error = "Watch output exceeded its line limit" }
                    }
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
            // Persist notification proposals before acknowledging their event cursor.
            if state.connection == "connected" {
                UserDefaults.standard.set(state.cursor, forKey: "watchCursor")
            }
        }
        catch { self.error = "Unsupported or malformed runner watch message" }
    }
    func wake() {
        guard !stopped else { return }
        now = Date()
        state.reconnect(now: now)
        generation += 1
        let previous = watcher
        watcher = nil
        if previous?.isRunning == true { previous?.terminate() }
        deliverNotices()
        start()
    }
    func stop() {
        if let observer = wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer); wakeObserver = nil }
        statusTimer?.invalidate(); statusTimer = nil; stopped = true; generation += 1; watcher?.terminate(); watcher = nil }
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
                    if process.terminationStatus != 0 { self.error = ControlPolicy.commandError(arguments: arguments, output: text) }
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
        noticeBacklog.update(proposals, accepted: Set(notificationKeys.ids))
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
                    self.noticeBacklog.prune(now: Date()); self.saveBacklog()
                    guard self.noticeBacklog.pending.contains(where: { $0.id == notice.id }) else {
                        self.pendingKeys.remove(notice.id); return
                    }
                    let content = UNMutableNotificationContent()
                    content.title = notice.title; content.body = notice.body; content.sound = .default
                    content.userInfo["noticeTitle"] = notice.title; content.userInfo["noticeBody"] = notice.body
                    if let id = notice.operationId { content.userInfo["operationId"] = id }
                    do {
                        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
                        self.notificationKeys.record(notice.id)
                        self.noticeBacklog.accepted(notice.id); self.saveBacklog()
                        UserDefaults.standard.set(self.notificationKeys.ids, forKey: "noticeKeys")
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
    private var killing: Operation? { controls.pendingKill }
    func age(_ stamp: String?) -> String {
        relativeAge(runnerDate(stamp), now: model.now)
    }
    @ViewBuilder func deploymentDetails(_ item: Operation) -> some View {
        let record = item.result?["deployment"] ?? item.result?["record"]
        if let rollback = record?["rollback"]?["reason"]?.string { Text("Rollback: \(rollback)").font(.caption) }
        if let migration = record?["migrations"]?["status"]?.string { Text("Migrations: \(migration)").font(.caption) }
    }
    @ViewBuilder func operation(_ item: Operation) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(item.kind) · \(item.repo) · \(operationReference(item))").font(.headline)
            Text("\(operationStatusText(item))\(item.result?["result"]?["merge"]?.string.map { " · merge " + String($0.prefix(12)) } ?? "")").font(.caption)
            if let reason = item.result?["reason"]?.string { Text(reason).font(.caption) }
            Text("\(item.submittedBy) · \(item.stage) · \(age(item.stageStartedAt ?? item.submittedAt))").font(.caption)
            if let deployId = item.result?["deploy"]?.string, let deploy = model.state.operations[deployId] {
                Text("Production: \(operationStatusText(deploy))").font(.caption)
                if let reason = deploy.result?["reason"]?.string { Text(reason).font(.caption) }
                deploymentDetails(deploy)
            }
            if item.kind == "deploy" && item.environment == "production" {
                deploymentDetails(item)
            }
            Text("Timing: \(item.timing?.state ?? "unknown") · median \(item.timing?.medianMs.map { elapsedTime($0 / 1000) } ?? "unavailable")").font(.caption)
            if let position = item.position { Text("Queue \(position) · behind \(item.waitingFor ?? "none")").font(.caption) }
            HStack {
                Button("Log") { model.openLog(item.id) }
                if item.status == "queued" { Button("Cancel…") { _ = controls.requestCancellation(item) } }
                if item.status == "running" {
                    Button("Kill…") { _ = controls.requestKill(item) }.disabled(ControlPolicy.killCommand(for: item) == nil)
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
                    Text("Last contact: \(relativeAge(model.state.lastContact, now: model.now))").font(.caption)
                    if let error = model.error { Text(error).foregroundColor(.red).textSelection(.enabled) }
                    if let refusal = controls.refusal { Text(refusal).foregroundColor(.red) }
                    if let snapshot = model.state.snapshot {
                        let stale = staleSnapshotNotice(state: model.state, now: model.now)
                        if let stale { Text(stale).font(.caption).foregroundColor(.orange) }
                        if let pause = snapshot.paused { Text("Paused by \(pause.by) · \(age(pause.at))") }
                        ForEach(snapshot.held, id: \.repo) { held in
                            Text("Held \(held.repo) · \(held.commitId.prefix(8)) · \(age(held.since)) · retries \(held.retries)\n\(held.reason)").foregroundColor(.red)
                        }
                        Text(stale == nil ? "Landings, releases and resets" : "Landings, releases and resets · last known").font(.headline)
                        if snapshot.lanes.serial.isEmpty { Text(stale == nil ? "Idle" : "Last known: idle") }
                        ForEach(snapshot.lanes.serial) { operation($0) }
                        Divider(); Text(stale == nil ? "Deploy lane" : "Deploy lane · last known").font(.headline)
                        if snapshot.lanes.deploy.isEmpty { Text(stale == nil ? "Idle" : "Last known: idle") }
                        ForEach(snapshot.lanes.deploy) { operation($0) }
                        Divider(); Text("Last staging attempts").font(.headline)
                        ForEach(snapshot.lastStagingDeploys) { item in
                            Text("\(item.repo) · \(item.commitId.prefix(8)) · \(item.status) · \(age(item.finishedAt ?? item.submittedAt))")
                            Button("Log") { model.openLog(item.id) }
                        }
                        Text("Recent Production deploys").font(.headline)
                        if snapshot.displayedProductionDeploys.isEmpty { Text("No recent Production deploys") }
                        ForEach(snapshot.displayedProductionDeploys) { operation($0) }
                        Text("Recent releases").font(.headline)
                        ForEach(snapshot.displayedReleases) { operation($0) }
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
            .confirmationDialog("Kill \(killing?.kind ?? "operation") in \(killing?.repo ?? "") (\(killing.map(operationReference) ?? ""))?", isPresented: Binding(get: { killing != nil }, set: { if !$0 { controls.dismissKill() } }), presenting: killing) { item in
                Button("Kill \(item.kind)", role: .destructive) { if let arguments = controls.confirmKill(current: model.state.operations[item.id]) { model.command(arguments) { _ in } } }
                Button("Keep running", role: .cancel) { controls.dismissKill() }
            } message: { item in Text(ControlPolicy.killConsequence(item)) }
        }.confirmationDialog("Cancel \(cancelling?.kind ?? "operation") in \(cancelling?.repo ?? "") (\(cancelling.map(operationReference) ?? ""))?", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { controls.dismissCancellation() } })) {
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
