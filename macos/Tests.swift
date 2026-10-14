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
        expect(state.snapshot?.lanes.serial.first?.timing?.amberAfterMs == 2_000, "runner timing retained")
        expect(state.operations["release-1"]?.kind == "release", "terminal release identity retained")
        expect(state.operations["release-1"]?.status == "released", "terminal result retained")
        expect(state.connection == "connected", "connection decoded")
        expect(state.lastContact == now.addingTimeInterval(5), "contact uses receipt rather than payload time")
        expect(state.lastEvent == nil, "heartbeat and connection clear stale events")
        let lastContact = state.lastContact
        state.consume(.connection(state: "disconnected", cursor: state.cursor), receivedAt: now.addingTimeInterval(500))
        expect(state.lastContact == lastContact, "connection state does not fabricate contact")
        let event = StoredEvent(seq: 10, operationId: "release-1", at: "old", event: .object(["type": .string("failed"), "reason": .string("fixture")]))
        state.consume(.event(event), receivedAt: now)
        expect(state.lastEvent?.seq == 10, "new event admitted")
        state.consume(.event(event), receivedAt: now)
        expect(state.lastEvent == nil, "replayed event not admitted twice")
        try state.consume(line: "{\"version\":1,\"type\":\"future-envelope\"}", receivedAt: now)
        expect(state.lastEvent == nil, "unknown envelope tolerated")
        let future = StoredEvent(seq: 11, operationId: "release-1", at: "old", event: .object(["type": .string("future-kind"), "extra": .array([.bool(true)])]))
        let roundtrip = try JSONDecoder().decode(WatchEnvelope.self, from: JSONEncoder().encode(WatchEnvelope.event(future)))
        expect(roundtrip == .event(future), "future event payload roundtrip")
        var rejected = false
        do { try state.consume(line: "{\"version\":2,\"type\":\"future\"}", receivedAt: now) } catch { rejected = true }
        expect(rejected, "unsupported protocol version rejected")
        var cached = RunnerState(now: now)
        try cached.consume(line: lines[3], receivedAt: now)
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
        try controlTests(now: now)
        try policyTests(now: now)
        print("Runner model and policy tests passed")
    }
}

func policyTests(now: Date) throws {
    let fixture = try String(contentsOfFile: "macos/fixtures/lifecycle.jsonl", encoding: .utf8).split(separator: "\n").map(String.init)
    var state = RunnerState(now: now)
    try state.consume(line: fixture[0], receivedAt: now)
    expect(statusPresentation(state: state, now: now).kind == "idle", "idle presentation")
    try state.consume(line: fixture[3], receivedAt: now)
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
    let eventLines = try String(contentsOfFile: "macos/fixtures/notification-events.jsonl", encoding: .utf8).split(separator: "\n").map(String.init)
    var titles: [String] = []
    for line in eventLines {
        try state.consume(line: line, receivedAt: now)
        for notice in notices(state: state, now: now, landingFailures: false) where delivered.insert(notice.id).inserted { titles.append(notice.title) }
    }
    expect(titles == ["Release verification started", "Release failed", "Release published", "Production deployed", "Production rolled back", "Release combined with a newer candidate", "Release resubmitted as fallback", "Hourly suite failed"], "release notice defaults and explicit future fixtures")
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
    let notice = Notice(id: "event:release:1:published", title: "Published", body: "fixture", operationId: "release")
    let condition = Notice(id: "held:fixture:commit:time", title: "Held", body: "fixture", operationId: nil)
    var backlog = NoticeBacklog()
    backlog.update([notice, condition], accepted: [])
    expect(backlog.pending.count == 2, "event and current condition proposed")
    backlog.update([], accepted: [])
    expect(backlog.pending == [notice], "denied or failed delivery retains event, obsolete condition removed")
    backlog = try JSONDecoder().decode(NoticeBacklog.self, from: JSONEncoder().encode(backlog))
    expect(backlog.pending == [notice], "undelivered event survives restart")
    backlog.accepted(notice.id)
    expect(backlog.pending.isEmpty, "successful OS acceptance clears event")
    backlog.update([notice], accepted: [notice.id])
    expect(backlog.pending.isEmpty, "accepted identity stays deduplicated")
    let contact = now.addingTimeInterval(-400)
    let original = RunnerState(now: now, lastContact: contact, startedAt: now.addingTimeInterval(-500))
    let restored = RunnerState(now: now.addingTimeInterval(10), lastContact: contact, startedAt: original.startedAt)
    let first = notices(state: original, now: now, landingFailures: false).first { $0.id.hasPrefix("unreachable:") }!
    let again = notices(state: restored, now: now, landingFailures: false).first { $0.id.hasPrefix("unreachable:") }!
    expect(first.id == again.id, "unreachable occurrence survives restart")
    var reconnected = restored
    reconnected.consume(.heartbeat(at: "fixture", seq: 0), receivedAt: now)
    let later = notices(state: reconnected, now: now.addingTimeInterval(301), landingFailures: false).first { $0.id.hasPrefix("unreachable:") }!
    expect(later.id != first.id, "real contact creates next unreachable occurrence")
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
