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
}

struct NoticeBacklog: Codable {
    private(set) var events: [String: Notice] = [:]
    private(set) var conditions: [String: Notice] = [:]
    mutating func update(_ proposals: [Notice], accepted: Set<String>) {
        conditions = [:]
        for notice in proposals where !accepted.contains(notice.id) {
            if notice.id.hasPrefix("event:") { events[notice.id] = notice }
            else { conditions[notice.id] = notice }
        }
        events = events.filter { !accepted.contains($0.key) }
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

func statusPresentation(state: RunnerState, now: Date) -> StatusPresentation {
    let silence = now.timeIntervalSince(state.lastContact ?? state.startedAt)
    guard let snapshot = state.snapshot else {
        return silence >= 300
            ? StatusPresentation(kind: "needsAttention", symbol: "wifi.exclamationmark", title: "Runner unreachable")
            : StatusPresentation(kind: "idle", symbol: "arrow.triangle.2.circlepath", title: "Connecting to runner")
    }
    let running = (snapshot.lanes.serial + snapshot.lanes.deploy).filter { $0.status == "running" }
    if silence >= 300 || (!running.isEmpty && silence >= 60) {
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
                                 body: String(body.prefix(600)), operationId: stored.operationId))
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
        // Reserved fixture cases: no producer is claimed until the upstream Tickets land.
        case "coalesced", "release_coalesced":
            add("coalesced", "Release combined with a newer candidate", "\(context)\n\(event["by"]?.string ?? event["candidate"]?.string ?? "See run log")")
        case "fallback", "release_fallback":
            add("fallback", "Release resubmitted as fallback", context)
        case "suite_failed":
            add("suite-failed", "Hourly suite failed", event["reason"]?.string ?? "See run log")
        default: break
        }
    }
    let silence = now.timeIntervalSince(state.lastContact ?? state.startedAt)
    if silence >= 300 {
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
        if silence >= 60 {
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
