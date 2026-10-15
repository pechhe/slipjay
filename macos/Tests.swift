import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

@main
struct ModelTests {
    static func main() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        var state = RunnerState(now: now)
        let fixture = CommandLine.arguments.dropFirst().first ?? "macos/fixtures/lifecycle.jsonl"
        let lines = try String(contentsOfFile: fixture, encoding: .utf8).split(separator: "\n").map(String.init)
        for (index, line) in lines.enumerated() {
            try state.consume(line: line, receivedAt: now.addingTimeInterval(Double(index)))
        }
        expect(state.snapshot?.runner == "fixture-runner", "snapshot decoded")
        expect(state.snapshot?.lanes.serial.first?.timing?.samples == 0, "runner timing retained")
        expect(state.operations["release-1"]?.kind == "release", "terminal release identity retained")
        expect(state.operations["release-1"]?.status == "released", "terminal result retained")
        expect(state.connection == "connected", "connection decoded")
        expect(state.lastContact == now.addingTimeInterval(Double(lines.count - 1)), "contact uses receipt rather than payload time")
        expect(state.lastEvent == nil, "heartbeat and connection clear stale events")
        expect(state.operations["release-1"]?.result?["result"]?["candidate"]?.string == "approved-candidate", "real singular release candidate decoded")
        for terminal in RunnerContract.terminalEventTypes {
            let id = terminal == "released" ? "release-1" : "terminal-\(terminal)"
            expect(state.operations[id]?.status == terminal, "every canonical terminal closes its operation: \(terminal)")
            expect(state.operations[id]?.finishedAt != nil, "every terminal keeps its event date")
        }
        let lastContact = state.lastContact
        state.consume(.connection(state: "disconnected", cursor: state.cursor), receivedAt: now.addingTimeInterval(500))
        expect(state.lastContact == lastContact, "connection state does not fabricate contact")
        let event = StoredEvent(seq: state.cursor + 1, operationId: "release-1", at: "old", event: .object(["type": .string("failed"), "reason": .string("fixture")]))
        state.consume(.event(event), receivedAt: now)
        expect(state.lastEvent?.seq == event.seq, "new event admitted")
        state.consume(.event(event), receivedAt: now)
        expect(state.lastEvent == nil, "replayed event not admitted twice")
        try state.consume(line: "{\"version\":1,\"type\":\"future-envelope\"}", receivedAt: now)
        expect(state.lastEvent == nil, "unknown envelope tolerated")
        let future = StoredEvent(seq: state.cursor + 1, operationId: "release-1", at: "old", event: .object(["type": .string("future-kind"), "extra": .array([.bool(true)])]))
        let roundtrip = try JSONDecoder().decode(WatchEnvelope.self, from: JSONEncoder().encode(WatchEnvelope.event(future)))
        expect(roundtrip == .event(future), "future event payload roundtrip")
        var rejected = false
        do { try state.consume(line: "{\"version\":2,\"type\":\"future\"}", receivedAt: now) } catch { rejected = true }
        expect(rejected, "unsupported protocol version rejected")
        var cached = RunnerState(now: now)
        cached.consume(.snapshot(try runningReleaseSnapshot(lines: lines)), receivedAt: now)
        for seq in 1...300 {
            cached.consume(.event(StoredEvent(seq: seq, operationId: "cache-\(seq)", at: "fixture", event: .object(["type": .string("submitted"), "repo": .string("fixture"), "commitId": .string("commit")]))), receivedAt: now)
        }
        expect(cached.operations.count == 257, "cache retains snapshot identity plus newest 256")
        expect(cached.operations["release-1"] != nil && cached.operations["cache-300"] != nil && cached.operations["cache-1"] == nil, "cache eviction preserves current and newest")
        var completedSnapshot = cached.snapshot!
        completedSnapshot.recentProductionDeploys = [Operation(id: "production", kind: "deploy", repo: "fixture", commitId: "merge", submittedBy: "owner", status: "failed", stage: "deploying", submittedAt: "fixture", lastSeq: 400, environment: "production")]
        cached.consume(.snapshot(completedSnapshot), receivedAt: now)
        expect(cached.operations["production"]?.status == "failed", "restart snapshot carries terminal production outcome")
        try deployedNoticeTests(now: now)
        try backlogTests(now: now)
        noticeHistoryTests()
        try controlTests(now: now)
        try policyTests(now: now)
        try presentationTests(now: now)
        try watchRestartTests(now: now)
        try reconnectTests(now: now)
        print("Runner model and policy tests passed")
    }
}

func presentationTests(now: Date) throws {
    let lines = try String(contentsOfFile: "macos/fixtures/lifecycle.jsonl", encoding: .utf8).split(separator: "\n").map(String.init)
    var state = RunnerState(now: now)
    try state.consume(line: lines[0], receivedAt: now)
    state.consume(.connection(state: "connected", cursor: 0), receivedAt: now)
    var snapshot = state.snapshot!
    var failed = Operation(id: "failed-production", kind: "deploy", repo: "fixture/app", commitId: "failed-commit", submittedBy: "owner", status: "failed", stage: "deploying", submittedAt: "2026-10-15T00:00:00Z", lastSeq: 1, environment: "production")
    snapshot.recentProductionDeploys = [failed]
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).title == "Production deploy failed", "a standalone Production failure needs attention without any release")
    var retry = failed; retry.id = "retry"; retry.status = "running"
    snapshot.recentProductionDeploys = [retry, failed]
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).needsAttention, "a running retry does not erase the previous Production failure")
    retry.status = "deployed"
    snapshot.recentProductionDeploys = [retry, failed]
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(!statusPresentation(state: state, now: now).needsAttention, "a successful retry clears that repository's earlier failure")
    retry.repo = "fixture/other"
    snapshot.recentProductionDeploys = [retry, failed]
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).needsAttention, "another repository's successful deploy does not hide the failure")
    snapshot.recentReleases = (0..<10).map { index in
        var release = failed; release.id = "release-\(index)"; release.kind = "release"; release.status = "released"; return release
    }
    snapshot.recentProductionDeploys = (0..<10).map { index in
        var deploy = failed; deploy.id = "deploy-\(index)"; return deploy
    }
    expect(snapshot.displayedReleases.map(\.id) == ["release-0", "release-1", "release-2"], "menu shows only the latest three releases in runner order")
    expect(snapshot.displayedProductionDeploys.map(\.id) == ["deploy-0", "deploy-1", "deploy-2"], "menu includes the latest three Production deploys")
    expect(snapshot.recentReleases.count == 10, "menu limits do not discard runner history")
    var active = failed; active.id = "active"; active.status = "running"
    snapshot.recentReleases.insert(active, at: 0)
    snapshot.recentProductionDeploys?.insert(active, at: 0)
    expect(snapshot.displayedReleases.first?.id == "release-0" && snapshot.displayedProductionDeploys.first?.id == "deploy-0", "recent outcomes do not duplicate active lane entries")
    var landing = failed; landing.kind = "landing"; landing.changeId = String(repeating: "z", count: 32)
    expect(operationReference(landing) == "change zzzzzzzzzzzz", "landings display their stable change identifier")
    landing.changeId = nil
    expect(operationReference(landing) == "change unavailable", "missing change identity is explicit")
    expect(operationReference(failed) == "failed-commi", "deploys retain their commit identity")
    landing.status = "queued"
    expect(operationStatusText(landing) == "Queued", "queued work has a queue state rather than an outcome")
    landing.status = "running"
    expect(operationStatusText(landing) == "Running", "running work has no terminal outcome")
    failed.result = .object(["deployment": .object(["rollback": .object(["automatic": .bool(true)])])])
    expect(operationStatusText(failed) == "Rolled back", "a failed Production attempt retains the automatic rollback outcome")
    for (seconds, expected) in [(5.0, "5s ago"), (60, "1m ago"), (3600, "1h ago"), (86400, "1d ago")] {
        expect(relativeAge(now.addingTimeInterval(-seconds), now: now) == expected, "ages use readable units at boundaries")
    }
    expect(relativeAge(now.addingTimeInterval(60), now: now) == "just now", "future timestamps do not print negative ages")
    expect(relativeAge(nil, now: now) == "unavailable", "missing timestamp is explicit")
    expect(staleSnapshotNotice(state: state, now: now) == nil, "connected fresh snapshots have no stale marker")
    expect(staleSnapshotNotice(state: state, now: now.addingTimeInterval(60))?.hasPrefix("No recent contact") == true, "quiet stale connections mark cached state")
    state.consume(.connection(state: "disconnected", cursor: 0), receivedAt: now)
    expect(staleSnapshotNotice(state: state, now: now)?.hasPrefix("Disconnected") == true, "disconnected lanes are marked as last known")
    state.consume(.connection(state: "connecting", cursor: 0), receivedAt: now)
    expect(staleSnapshotNotice(state: state, now: now)?.hasPrefix("Reconnecting") == true, "reconnection keeps cached lanes explicitly stale")
}

func noticeHistoryTests() {
    let accepted = (0..<2050).map { "notice-\($0)" }
    var history = NoticeHistory(accepted)
    expect(history.ids == Array(accepted.suffix(2048)), "restore keeps latest 2048 accepted identities")
    history.record("newly-accepted")
    expect(history.ids.count == 2048 && history.ids.first == "notice-3" && history.ids.last == "newly-accepted", "successful delivery evicts oldest accepted identity")
    history.record("notice-100")
    expect(history.ids.count == 2048 && history.ids.first == "notice-3" && history.ids.last == "notice-100", "repeat acceptance refreshes order without evicting another identity")
    expect(!history.contains("notice-2") && history.contains("newly-accepted"), "dedup membership follows retained identities")
    expect(NoticeHistory(["first", "second", "first"]).ids == ["second", "first"], "restored duplicate identities keep their latest acceptance")
}

func watchRestartTests(now: Date) throws {
    // This fixture is checked against watchRunner + the authenticated runner handler in TS.
    let data = try Data(contentsOf: URL(fileURLWithPath: "macos/fixtures/watch-restart.json"))
    let sessions = try JSONDecoder().decode([[WatchEnvelope]].self, from: data)
    var state = RunnerState(now: now)
    var backlog = NoticeBacklog()
    var accepted = Set<String>()
    func consume(_ session: [WatchEnvelope]) {
        for envelope in session {
            state.consume(envelope, receivedAt: now)
            backlog.update(notices(state: state, now: now, landingFailures: false), accepted: accepted, now: now)
        }
    }
    consume(sessions[0])
    expect(backlog.pending.isEmpty, "first install starts at the snapshot without historical verification notices")
    expect(state.cursor == state.snapshot?.seq, "first connected snapshot establishes persisted baseline")
    let savedCursor = state.cursor
    state = RunnerState(now: now, cursor: savedCursor)
    consume(sessions[1])
    expect(backlog.pending.map(\.title) == ["Release failed"], "restart catches release failure while app was stopped")
    expect(backlog.pending[0].body.contains("fixture/repo"), "replayed notice has real snapshot operation context")
    // A restart before OS acceptance retains the queued notice alongside the applied cursor.
    backlog = try JSONDecoder().decode(NoticeBacklog.self, from: JSONEncoder().encode(backlog))
    state = RunnerState(now: now, cursor: state.cursor)
    consume(sessions[2])
    expect(backlog.pending.count == 1, "no replay required to deliver a persisted pending notice")
    for notice in backlog.pending { accepted.insert(notice.id); backlog.accepted(notice.id) }
    consume(sessions[1])
    expect(backlog.pending.isEmpty, "repeated replay cannot notify an accepted event twice")
    state = RunnerState(now: now, cursor: state.cursor)
    consume(sessions[3])
    expect(state.cursor == state.snapshot?.seq, "409 resets a cursor ahead of the replaced log")
    expect(Set(backlog.pending.map(\.title)) == Set(["Release verification started", "Release failed"]), "new events notify after resync to a replaced log")
    expect(backlog.pending.allSatisfy { $0.operationId == "replacement" }, "resync notifications refer to the new log")
}

func policyTests(now: Date) throws {
    let fixture = try String(contentsOfFile: "macos/fixtures/lifecycle.jsonl", encoding: .utf8).split(separator: "\n").map(String.init)
    var state = RunnerState(now: now)
    try state.consume(line: fixture[0], receivedAt: now)
    expect(statusPresentation(state: state, now: now).kind == "idle", "idle presentation")
    state.consume(.snapshot(try runningReleaseSnapshot(lines: fixture)), receivedAt: now)
    var snapshot = state.snapshot!
    var operation = snapshot.lanes.serial[0]
    operation.kind = "landing"
    snapshot.lanes.serial = [operation]
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).kind == "working", "working presentation")
    snapshot.lanes.serial[0].timing!.state = "amber"
    state.consume(.snapshot(snapshot), receivedAt: now)
    let amber = statusPresentation(state: state, now: now)
    expect(amber.kind == "amber" && amber.symbol == "exclamationmark.triangle", "amber runner assessment renders warning")
    snapshot.lanes.serial[0].timing!.state = "red"
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).needsAttention, "stuck presentation")
    snapshot.lanes.serial[0].timing!.state = "normal"
    snapshot.held = [Held(repo: "repo", commitId: "held", since: "2026-10-14T00:00:00Z", reason: "push refused", retries: 0)]
    state.consume(.snapshot(snapshot), receivedAt: now)
    let heldID = notices(state: state, now: now, landingFailures: false).first!.id
    snapshot.held[0].retries = 2
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(notices(state: state, now: now, landingFailures: false).first!.id == heldID, "hold retry preserves occurrence")
    snapshot.held = []
    snapshot.paused = Pause(by: "owner", at: "1970-01-01T00:00:00Z")
    snapshot.lanes.serial[0].status = "queued"
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).kind == "paused", "paused presentation")
    expect(notices(state: state, now: Date(timeIntervalSince1970: 4000), landingFailures: false).contains { $0.id.hasPrefix("pause:") }, "queued pause after hour")
    expect(statusPresentation(state: state, now: now.addingTimeInterval(301)).needsAttention, "unreachable presentation")
    expect(notices(state: state, now: now.addingTimeInterval(301), landingFailures: false).contains { $0.id.hasPrefix("unreachable:") }, "unreachable notice")
    state.consume(.heartbeat(at: "old", seq: 0), receivedAt: now.addingTimeInterval(302))
    expect(statusPresentation(state: state, now: now.addingTimeInterval(302)).kind == "paused", "contact recovers")
    snapshot.paused = nil
    operation.kind = "release"; operation.status = "running"
    snapshot.lanes.serial = [operation]
    state.consume(.snapshot(snapshot), receivedAt: now)
    expect(statusPresentation(state: state, now: now).kind == "release", "release presentation")
    operation.stage = "publishing"; operation.kill = Kill(allowed: false, reason: "past verification")
    expect(operation.kill?.allowed == false && operation.kill?.reason != nil, "unsafe kill disabled with reason")
    var delivered = Set<String>()
    state = RunnerState(now: now)
    let eventLines = try String(contentsOfFile: "macos/fixtures/notification-events.jsonl", encoding: .utf8).split(separator: "\n").map(String.init)
    var titles: [String] = []
    var deliveredNotices: [String: Notice] = [:]
    for line in eventLines {
        try state.consume(line: line, receivedAt: now)
        for notice in notices(state: state, now: now, landingFailures: false) where delivered.insert(notice.id).inserted {
            titles.append(notice.title); deliveredNotices[notice.title] = notice
        }
    }
    expect(titles == ["Release verification started", "Release failed", "Release published", "Production deployed", "Production rolled back"], "notices decode the real runner ledger contract")
    expect(deliveredNotices["Release failed"]?.operationId == "release-failure", "failed release keeps its own operation")
    expect(deliveredNotices["Production deployed"]?.body == "fixture/repo\nMerge: release-merg\nCandidates shipped: approved-can", "deployed notice keeps the approved candidate and release merge")
    expect(deliveredNotices["Production rolled back"]?.operationId == "rollback" && deliveredNotices["Production rolled back"]?.body.contains("Migrations: applied") == true, "rollback notice keeps its failed operation and migration outcome")
    expect(notices(state: state, now: now, landingFailures: false).isEmpty, "superseding a landing does not claim a release shipped")
    for (index, kind) in ["coalesced", "release_coalesced", "fallback", "release_fallback", "suite_failed"].enumerated() {
        state.consume(.event(StoredEvent(seq: 50 + index, operationId: "release", at: "fixture", event: .object(["type": .string(kind)]))), receivedAt: now)
        expect(notices(state: state, now: now, landingFailures: false).isEmpty, "unbuilt producers do not trigger notices")
    }
    let deliveredBeforeReplay = delivered
    for line in eventLines { try state.consume(line: line, receivedAt: now); for notice in notices(state: state, now: now, landingFailures: false) { delivered.insert(notice.id) } }
    expect(delivered == deliveredBeforeReplay, "reconnect dedup")
    var restarted = RunnerState(now: now)
    for line in eventLines { try restarted.consume(line: line, receivedAt: now); for notice in notices(state: restarted, now: now, landingFailures: false) { delivered.insert(notice.id) } }
    expect(delivered == deliveredBeforeReplay, "persisted notification ids dedup restart")
    let landing = StoredEvent(seq: 100, operationId: "landing", at: "fixture", event: .object(["type": .string("submitted"), "repo": .string("repo"), "commitId": .string("change")]))
    state.consume(.event(landing), receivedAt: now)
    state.consume(.event(StoredEvent(seq: 101, operationId: "landing", at: "fixture", event: .object(["type": .string("failed"), "reason": .string("fixture")] ))), receivedAt: now)
    expect(notices(state: state, now: now, landingFailures: false).isEmpty, "landing failures off by default")
    expect(notices(state: state, now: now, landingFailures: true).count == 1, "landing failures opt in")
}

func controlTests(now: Date) throws {
    var operation = Operation(id: "queued-operation", kind: "landing", repo: "fixture", commitId: "candidate", submittedBy: "owner", status: "queued", stage: "queued", submittedAt: "fixture", lastSeq: 1)
    var control = ControlPolicy()
    expect(control.confirmCancellation(current: operation) == nil, "cancel cannot execute without confirmation request")
    expect(control.requestCancellation(operation), "queued operation opens confirmation")
    expect(control.pendingCancellation?.id == operation.id, "confirmation names the intended operation")
    expect(control.confirmCancellation(current: operation) == ["cancel", "queued-operation"], "confirmed cancel maps exact CLI argv")
    expect(control.pendingCancellation == nil, "confirmation clears after dispatch")
    control.requestCancellation(operation)
    control.dismissCancellation()
    expect(control.confirmCancellation(current: operation) == nil, "dismissed cancel emits no command")
    control.requestCancellation(operation)
    operation.status = "running"; operation.stage = "verifying"
    expect(control.confirmCancellation(current: operation) == nil, "started operation refuses stale confirmation")
    expect(!control.requestCancellation(operation), "running operation cannot open cancel confirmation")
    expect(control.refusal == "Not cancelled: the landing already started. Kill it instead while it verifies.", "a cancel that lost the race says it already started")
    expect(ControlPolicy.commandError(arguments: ["cancel", "queued-operation"], output: #"{"operation":{"id":"queued-operation","kind":"release","status":"running"}}"#)
        == "Not cancelled: the release already started. Kill it instead while it verifies.", "the runner's 409 for a started operation is not shown as raw JSON")
    expect(ControlPolicy.commandError(arguments: ["runner", "kill", "x"], output: "[runner r] not killed") == "[runner r] not killed", "other failures keep the CLI's line")
    operation.kill = Kill(allowed: true, reason: nil)
    expect(ControlPolicy.killCommand(for: operation) == ["runner", "kill", "queued-operation"], "safe running stage maps kill CLI naming the operation")
    expect(control.confirmKill(current: operation) == nil, "kill cannot execute without confirmation request")
    expect(control.requestKill(operation), "killable operation opens kill confirmation")
    expect(control.pendingKill?.id == operation.id, "kill confirmation names the intended operation")
    expect(control.confirmKill(current: operation) == ["runner", "kill", "queued-operation"], "confirmed kill names the exact operation")
    expect(control.pendingKill == nil, "kill confirmation clears after dispatch")
    control.requestKill(operation)
    var successor = operation; successor.id = "next-operation"
    expect(control.confirmKill(current: successor) == nil, "a kill confirmed for one operation never reaches another")
    control.requestKill(operation)
    control.dismissKill()
    expect(control.confirmKill(current: operation) == nil, "dismissed kill emits no command")
    control.requestKill(operation)
    operation.stage = "publishing"; operation.kill = Kill(allowed: false, reason: "past verification")
    expect(control.confirmKill(current: operation) == nil, "a kill confirmed before verification ended sends nothing after")
    expect(control.refusal == "landing can no longer be killed: past verification", "the stale kill says why")
    expect(ControlPolicy.killCommand(for: operation) == nil, "unsafe kill emits no command")
    expect(!control.requestKill(operation), "unsafe kill opens no confirmation")
    operation.status = "queued"; operation.kill = Kill(allowed: true, reason: nil)
    expect(ControlPolicy.killCommand(for: operation) == nil, "queued operation never emits kill")
    let notice = Notice(id: "fixture", title: "Release", body: "fixture", operationId: "release-log-id")
    expect(ControlPolicy.logCommand(operationId: notice.operationId) == ["runner", "log", "release-log-id"], "notification click maps intended log argv")
    expect(ControlPolicy.logCommand(operationId: nil) == nil && ControlPolicy.logCommand(operationId: "runner") == nil, "notifications without valid operation do not invent logs")
}

func backlogTests(now: Date) throws {
    let notice = Notice(id: "event:release:1:published", title: "Published", body: "fixture", operationId: "release", occurredAt: now)
    let condition = Notice(id: "held:fixture:commit:time", title: "Held", body: "fixture", operationId: nil)
    var backlog = NoticeBacklog()
    backlog.update([notice, condition], accepted: [], now: now)
    expect(backlog.pending.count == 2, "event and current condition proposed")
    backlog.update([], accepted: [], now: now)
    expect(backlog.pending == [notice], "denied or failed delivery retains event, obsolete condition removed")
    backlog = try JSONDecoder().decode(NoticeBacklog.self, from: JSONEncoder().encode(backlog))
    expect(backlog.pending == [notice], "undelivered event survives restart")
    backlog.accepted(notice.id)
    expect(backlog.pending.isEmpty, "successful OS acceptance clears event")
    backlog.update([notice], accepted: [notice.id], now: now)
    expect(backlog.pending.isEmpty, "accepted identity stays deduplicated")
    backlog.update([notice], accepted: [], now: now)
    backlog.prune(now: now.addingTimeInterval(86_399))
    expect(backlog.pending == [notice], "denied event remains deliverable just before 24 hours")
    backlog = try JSONDecoder().decode(NoticeBacklog.self, from: JSONEncoder().encode(backlog))
    backlog.prune(now: now.addingTimeInterval(86_400))
    expect(backlog.pending.isEmpty, "permission granted at 24 hours cannot deliver an expired event after restart")
    backlog.update([notice, condition], accepted: [], now: now.addingTimeInterval(86_401))
    expect(backlog.pending == [condition], "stale replay is rejected while current conditions remain")
    let undated = Notice(id: "event:legacy:1:published", title: "Published", body: "old", operationId: "legacy")
    backlog.update([undated], accepted: [], now: now)
    expect(backlog.pending.isEmpty, "undated old pending events are never presented as fresh")
    let legacy = #"{"events":{"event:legacy:1:published":{"id":"event:legacy:1:published","title":"Published","body":"old","operationId":"legacy"}},"conditions":{}}"#
    backlog = try JSONDecoder().decode(NoticeBacklog.self, from: Data(legacy.utf8))
    backlog.prune(now: now)
    expect(backlog.pending.isEmpty, "compatible legacy persisted state discards undated events")
    let contact = now.addingTimeInterval(-400)
    let original = RunnerState(now: now, lastContact: contact)
    let restored = RunnerState(now: now.addingTimeInterval(10), lastContact: contact)
    let first = notices(state: original, now: now.addingTimeInterval(70), landingFailures: false).first { $0.id.hasPrefix("unreachable:") }!
    let again = notices(state: restored, now: now.addingTimeInterval(70), landingFailures: false).first { $0.id.hasPrefix("unreachable:") }!
    expect(first.id == again.id, "unreachable occurrence survives restart")
    var reconnected = restored
    reconnected.consume(.heartbeat(at: "fixture", seq: 0), receivedAt: now)
    let later = notices(state: reconnected, now: now.addingTimeInterval(301), landingFailures: false).first { $0.id.hasPrefix("unreachable:") }!
    expect(later.id != first.id, "real contact creates next unreachable occurrence")
}

func reconnectTests(now: Date) throws {
    let fresh = RunnerState(now: now)
    expect(fresh.startedAt == now, "never connected uses this launch as origin")
    expect(notices(state: fresh, now: now.addingTimeInterval(299), landingFailures: false).isEmpty, "never connected has five minutes from launch")
    expect(statusPresentation(state: fresh, now: now.addingTimeInterval(300)).needsAttention, "never connected eventually unreachable")
    let oldContact = now.addingTimeInterval(-1000)
    var state = RunnerState(now: now, lastContact: oldContact, cursor: 7)
    expect(state.lastContact == oldContact, "launch preserves persisted contact provenance")
    expect(!statusPresentation(state: state, now: now.addingTimeInterval(59)).needsAttention, "persisted silence suppressed during launch grace")
    expect(notices(state: state, now: now.addingTimeInterval(59), landingFailures: false).isEmpty, "launch grace suppresses unreachable proposal")
    expect(statusPresentation(state: state, now: now.addingTimeInterval(60)).needsAttention, "launch grace expires at sixty seconds")
    let lines = try String(contentsOfFile: "macos/fixtures/lifecycle.jsonl", encoding: .utf8).split(separator: "\n").map(String.init)
    state.consume(.snapshot(try runningReleaseSnapshot(lines: lines)), receivedAt: now)
    let wake = now.addingTimeInterval(1000)
    let cursor = state.cursor
    let snapshot = state.snapshot
    var backlog = NoticeBacklog()
    let event = Notice(id: "event:pending:1:failed", title: "Failure", body: "fixture", operationId: "pending", occurredAt: now)
    backlog.update([event], accepted: [], now: now)
    state.reconnect(now: wake)
    expect(state.cursor == cursor && state.snapshot == snapshot && state.lastContact == now, "wake preserves cursor, work and successful contact")
    expect(state.connection == "connecting", "wake starts connecting")
    expect(!statusPresentation(state: state, now: wake.addingTimeInterval(59)).needsAttention, "wake running work gets grace")
    let proposals = notices(state: state, now: wake.addingTimeInterval(59), landingFailures: false)
    expect(!proposals.contains { $0.id.hasPrefix("silent:") || $0.id.hasPrefix("unreachable:") }, "wake grace suppresses both silence notices")
    backlog.update(proposals, accepted: [], now: now)
    expect(backlog.pending.contains(event), "wake retains pending event notices")
    expect(notices(state: state, now: wake.addingTimeInterval(60), landingFailures: false).contains { $0.id.hasPrefix("silent:") }, "running work silence returns when grace expires")
    let recovery = wake.addingTimeInterval(61)
    state.consume(.heartbeat(at: "old payload", seq: cursor), receivedAt: recovery)
    expect(state.lastContact == recovery, "recovery records receipt time")
    expect(!statusPresentation(state: state, now: recovery).needsAttention, "recovery clears silence attention")
    expect(!notices(state: state, now: recovery, landingFailures: false).contains { $0.id.hasPrefix("silent:") || $0.id.hasPrefix("unreachable:") }, "recovery clears silence proposals")
}

func deployedNoticeTests(now: Date) throws {
    var state = RunnerState(now: now)
    let release = Operation(id: "release", kind: "release", repo: "fixture", commitId: "candidate-alpha", submittedBy: "owner", status: "released", stage: "publishing", submittedAt: "fixture", lastSeq: 1, result: .object(["type": .string("released"), "deploy": .string("deploy"), "result": .object(["merge": .string("merge-alpha"), "candidate": .string("candidate-alpha")])]))
    state.operations[release.id] = release
    let event = StoredEvent(seq: 2, operationId: "deploy", at: "fixture", event: .object(["type": .string("deployed"), "record": .object(["environment": .string("production"), "commitId": .string("fallback-commit")])]))
    state.consume(.event(event), receivedAt: now)
    let linked = notices(state: state, now: now, landingFailures: false).first!
    expect(linked.body.contains("Merge: merge-alpha") && linked.body.contains("Candidates shipped: candidate-al"), "deployed notice uses typed linked release merge and candidate")
    state.operations.removeValue(forKey: "release")
    let unavailable = notices(state: state, now: now, landingFailures: false).first!
    expect(unavailable.body.contains("Merge: fallback-com") && unavailable.body.contains("Candidates shipped: unavailable"), "deployed notice preserves commit with explicit missing candidate evidence")
}

func runningReleaseSnapshot(lines: [String]) throws -> Snapshot {
    for line in lines {
        if case .snapshot(let snapshot) = try JSONDecoder().decode(WatchEnvelope.self, from: Data(line.utf8)),
           snapshot.lanes.serial.contains(where: { $0.id == "release-1" && $0.status == "running" }) { return snapshot }
    }
    fatalError("generated lifecycle must include a running release snapshot")
}
