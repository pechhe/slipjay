import Foundation

struct StatusPresentation {
    let kind: String
    let symbol: String
    let title: String
    var needsAttention: Bool { kind == "needsAttention" }
}

struct Notice: Equatable, Codable {
    let id: String
    let title: String
    let body: String
    let operationId: String?
    var occurredAt: Date? = nil
}

struct NoticeHistory {
    private(set) var ids: [String]
    init(_ restored: [String]) {
        var seen = Set<String>()
        ids = Array(restored.reversed().filter { seen.insert($0).inserted }.prefix(2048).reversed())
    }
    func contains(_ id: String) -> Bool { ids.contains(id) }
    mutating func record(_ id: String) {
        ids.removeAll { $0 == id }
        ids.append(id)
        ids = Array(ids.suffix(2048))
    }
}

struct NoticeBacklog: Codable {
    private(set) var events: [String: Notice] = [:]
    private(set) var conditions: [String: Notice] = [:]
    mutating func update(_ proposals: [Notice], accepted: Set<String>, now: Date = Date()) {
        conditions = [:]
        for notice in proposals where !accepted.contains(notice.id) {
            if notice.id.hasPrefix("event:") { events[notice.id] = notice }
            else { conditions[notice.id] = notice }
        }
        events = events.filter { !accepted.contains($0.key) }
        prune(now: now)
    }
    mutating func prune(now: Date) {
        // Undated pending events from older app versions cannot prove freshness.
        events = events.filter { _, notice in
            guard let occurredAt = notice.occurredAt else { return false }
            return now.timeIntervalSince(occurredAt) < 24 * 60 * 60
        }
    }
    mutating func accepted(_ id: String) { events.removeValue(forKey: id); conditions.removeValue(forKey: id) }
    var pending: [Notice] { Array(events.values) + Array(conditions.values) }
}

func runnerDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = format.date(from: text) { return date }
    format.formatOptions = [.withInternetDateTime]
    return format.date(from: text)
}

func elapsedTime(_ interval: TimeInterval) -> String {
    let seconds = max(0, Int(interval))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
}

func relativeAge(_ date: Date?, now: Date) -> String {
    guard let date else { return "unavailable" }
    let interval = now.timeIntervalSince(date)
    return interval < 5 ? "just now" : "\(elapsedTime(interval)) ago"
}

func operationReference(_ operation: Operation) -> String {
    if operation.kind == "landing" {
        guard let change = operation.changeId, !change.isEmpty else { return "change unavailable" }
        return "change \(change.prefix(12))"
    }
    return String(operation.commitId.prefix(12))
}

func operationStatusText(_ operation: Operation) -> String {
    if operation.status == "queued" { return "Queued" }
    if operation.status == "running" { return "Running" }
    if operation.kind == "deploy", operation.result?["deployment"]?["rollback"]?["automatic"]?.bool == true { return "Rolled back" }
    return operation.status.capitalized
}

extension Snapshot {
    var displayedReleases: [Operation] {
        Array(recentReleases.filter { RunnerContract.terminalEventTypes.contains($0.status) }.prefix(3))
    }
    var displayedProductionDeploys: [Operation] {
        Array((recentProductionDeploys ?? []).filter { RunnerContract.terminalEventTypes.contains($0.status) }.prefix(3))
    }
}

func staleSnapshotNotice(state: RunnerState, now: Date) -> String? {
    guard state.snapshot != nil else { return nil }
    if state.connection == "disconnected" { return "Disconnected · showing last known runner state" }
    if state.connection != "connected" { return "Reconnecting · showing last known runner state" }
    if now.timeIntervalSince(state.lastContact ?? state.startedAt) >= 60 { return "No recent contact · showing last known runner state" }
    return nil
}

func statusPresentation(state: RunnerState, now: Date) -> StatusPresentation {
    let silence = now.timeIntervalSince(state.lastContact ?? state.startedAt)
    guard let snapshot = state.snapshot else {
        return !state.isReconnecting(at: now) && silence >= 300
            ? StatusPresentation(kind: "needsAttention", symbol: "wifi.exclamationmark", title: "Runner unreachable")
            : StatusPresentation(kind: "idle", symbol: "arrow.triangle.2.circlepath", title: "Connecting to runner")
    }
    let running = (snapshot.lanes.serial + snapshot.lanes.deploy).filter { $0.status == "running" }
    if !state.isReconnecting(at: now) && (silence >= 300 || (!running.isEmpty && silence >= 60)) {
        return StatusPresentation(kind: "needsAttention", symbol: "wifi.exclamationmark", title: "Runner contact lost")
    }
    if !snapshot.held.isEmpty {
        return StatusPresentation(kind: "needsAttention", symbol: "exclamationmark.triangle.fill", title: "Integration needs attention")
    }
    if running.contains(where: { $0.timing?.state == "red" }) {
        return StatusPresentation(kind: "needsAttention", symbol: "exclamationmark.triangle.fill", title: "Command exceeded its deadline")
    }
    if running.contains(where: { $0.timing?.state == "amber" }) {
        return StatusPresentation(kind: "amber", symbol: "exclamationmark.triangle", title: "Stage taking longer than usual")
    }
    if snapshot.paused != nil {
        return StatusPresentation(kind: "paused", symbol: "pause.circle.fill", title: "Runner paused")
    }
    let latestRelease = snapshot.recentReleases.first
    let deploymentID = latestRelease?.result?["deploy"]?.string
    let deploymentFailed = deploymentID.flatMap { state.operations[$0]?.status } == "failed"
    if latestRelease?.status == "failed" || deploymentFailed {
        return StatusPresentation(kind: "needsAttention", symbol: "exclamationmark.circle.fill", title: "Last release failed")
    }
    // A retry clears a failure only after it successfully deploys. Each repository
    // keeps its own latest completed Production result, independent of releases.
    var productionRepos = Set<String>()
    for deploy in snapshot.recentProductionDeploys ?? [] where deploy.status == "failed" || deploy.status == "deployed" {
        if productionRepos.insert(deploy.repo).inserted && deploy.status == "failed" {
            return StatusPresentation(kind: "needsAttention", symbol: "exclamationmark.circle.fill", title: "Production deploy failed")
        }
    }
    if running.contains(where: { $0.kind == "release" || ($0.kind == "deploy" && $0.environment == "production") }) {
        return StatusPresentation(kind: "release", symbol: "shippingbox.fill", title: "Release in progress")
    }
    if !running.isEmpty {
        return StatusPresentation(kind: "working", symbol: "gearshape.2.fill", title: "Runner working")
    }
    return StatusPresentation(kind: "idle", symbol: "checkmark.circle", title: "Runner idle")
}

// Events use durable operation/sequence identities. Time-based conditions use their
// stable occurrence identity, so retry snapshots and app restarts cannot repeat them.
func notices(state: RunnerState, now: Date, landingFailures: Bool) -> [Notice] {
    var result: [Notice] = []
    if let stored = state.lastEvent {
        let event = stored.event
        let operation = state.operations[stored.operationId]
        let short = String((operation?.commitId ?? "").prefix(12))
        let repo = operation?.repo ?? "Runner"
        let context = "\(repo) \(short)".trimmingCharacters(in: .whitespaces)
        func add(_ kind: String, _ title: String, _ body: String) {
            result.append(Notice(id: "event:\(stored.operationId):\(stored.seq):\(kind)", title: title,
                                 body: String(body.prefix(600)), operationId: stored.operationId, occurredAt: runnerDate(stored.at)))
        }
        switch stored.type {
        case "stage" where operation?.kind == "release" && event["stage"]?.string == "verifying":
            add("verifying", "Release verification started", context)
        case "released":
            add("published", "Release published", "\(context) · merge \(String((event["result"]?["merge"]?.string ?? "unknown").prefix(12)))")
        case "deployed" where event["record"]?["environment"]?.string == "production":
            let commit = event["record"]?["commitId"]?.string ?? short
            let linked = state.operations.values.filter { $0.kind == "release" && $0.result?["deploy"]?.string == stored.operationId }
            let merges = Set(linked.compactMap { $0.result?["result"]?["merge"]?.string }).sorted()
            let candidates = Set(linked.compactMap { $0.result?["result"]?["candidate"]?.string }).sorted()
            let mergeText = merges.isEmpty ? String(commit.prefix(12)) : merges.map { String($0.prefix(12)) }.joined(separator: ", ")
            let candidateText = candidates.isEmpty ? "unavailable" : candidates.map { String($0.prefix(12)) }.joined(separator: ", ")
            add("deployed", "Production deployed", "\(repo)\nMerge: \(mergeText)\nCandidates shipped: \(candidateText)")
        case "failed":
            let reason = event["reason"]?.string ?? "See the run log for details."
            if operation?.kind == "release" {
                let command = event["command"]?.string.map { "\nCommand: \($0)" } ?? ""
                add("failed", "Release failed", "\(context)\n\(reason)\(command)")
            } else if operation?.kind == "deploy" && operation?.environment == "production" {
                let deployment = event["deployment"]
                let rollback = deployment?["rollback"]
                let title = rollback?["automatic"]?.bool == true ? "Production rolled back" : "Production deploy failed"
                let migration = deployment?["migrations"]?["status"]?.string ?? "not recorded"
                add("deploy-failed", title, "\(context)\n\(reason)\nMigrations: \(migration)")
            } else if operation?.kind == "landing" && landingFailures {
                add("landing-failed", "Landing failed", "\(context)\n\(reason)")
            }
        default: break
        }
    }
    let silence = now.timeIntervalSince(state.lastContact ?? state.startedAt)
    if !state.isReconnecting(at: now) && silence >= 300 {
        let since = state.lastContact ?? state.startedAt
        result.append(Notice(id: "unreachable:\(since.timeIntervalSince1970)", title: "Runner unreachable",
                             body: "No successful runner contact for five minutes.", operationId: nil))
    }
    guard let snapshot = state.snapshot else { return result }
    for hold in snapshot.held {
        result.append(Notice(id: "held:\(hold.repo):\(hold.commitId):\(hold.since)", title: "Integration needs attention",
                             body: "\(hold.repo) \(String(hold.commitId.prefix(12)))\n\(hold.reason)", operationId: nil))
    }
    let operations = snapshot.lanes.serial + snapshot.lanes.deploy
    for operation in operations where operation.status == "running" {
        let occurrence = operation.stageStartedAt ?? operation.submittedAt
        if operation.timing?.state == "red" {
            result.append(Notice(id: "deadline:\(operation.id):\(occurrence):\(operation.timing?.commandDeadlineAt ?? "unknown")",
                                 title: "Command exceeded its deadline", body: "\(operation.repo) · \(operation.stage)", operationId: operation.id))
        }
        if !state.isReconnecting(at: now) && silence >= 60 {
            result.append(Notice(id: "silent:\(operation.id):\((state.lastContact ?? state.startedAt).timeIntervalSince1970)",
                                 title: "Runner contact lost during work", body: "\(operation.repo) · \(operation.stage). Execution status is unknown.", operationId: operation.id))
        }
    }
    if let pause = snapshot.paused, let since = runnerDate(pause.at), now.timeIntervalSince(since) >= 3600,
       operations.contains(where: { $0.status == "queued" }) {
        result.append(Notice(id: "pause:\(pause.at)", title: "Runner has been paused for an hour",
                             body: "Work is queued. Paused by \(pause.by).", operationId: nil))
    }
    return result
}
