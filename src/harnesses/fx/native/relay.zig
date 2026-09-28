//! A loopback relay between one fx worker and its OpenAI-compatible provider.
//! fx 0.0.11 keeps only prompt and completion totals from a Chat Completions
//! response, so the cache counters the provider returns never reach its JSON
//! or its ACP usage. The relay forwards every byte unchanged and reads the
//! `usage` object on the way back: measured 2026-09-24 over 24 fx requests to
//! api.deepseek.com, 268,288 of 283,372 input tokens (94.7%) were cache hits
//! that fx reported as ordinary input. It also sees the HTTP status fx turns
//! into prose, which is the only reliable quota and rate-limit signal.
//!
//! One relay per runner, bound to 127.0.0.1 on an ephemeral port, so parallel
//! workers never share a meter. One thread per connection: fx keeps a
//! connection alive between requests and may open another beside it.

const std = @import("std");
const Io = std.Io;
const usage = @import("usage.zig");

/// Bytes of an error body kept for classification; the rest is the provider's prose.
const error_body_limit = 2048;

pub const Relayed = struct {
    status: u16,
    usage: ?usage.Usage,
    /// Owned by the relay's allocator; the callback copies what it keeps.
    error_body: ?[]const u8,
    retry_after_ms: ?u64,
};

pub const Callback = struct {
    context: *anyopaque,
    function: *const fn (context: *anyopaque, request: Relayed) void,
};

pub const Relay = struct {
    gpa: std.mem.Allocator,
    io: Io,
    upstream: []const u8,
    client: std.http.Client,
    server: Io.net.Server,
    callback: Callback,

    pub fn port(self: *const Relay) u16 {
        return self.server.socket.address.getPort();
    }

    /// Closing the listening socket ends the accept loop; connection threads
    /// die with the process.
    pub fn stop(self: *Relay) void {
        self.server.deinit(self.io);
    }
};

/// Listen on an ephemeral loopback port and serve on a detached thread.
pub fn start(gpa: std.mem.Allocator, io: Io, upstream: []const u8, callback: Callback) !*Relay {
    const relay = try gpa.create(Relay);
    const address = try Io.net.IpAddress.parse("127.0.0.1", 0);
    relay.* = .{
        .gpa = gpa,
        .io = io,
        .upstream = std.mem.trimEnd(u8, upstream, "/"),
        .client = .{ .allocator = gpa, .io = io },
        .server = try address.listen(io, .{ .reuse_address = true }),
        .callback = callback,
    };
    const thread = try std.Thread.spawn(.{}, acceptLoop, .{relay});
    thread.detach();
    return relay;
}

fn acceptLoop(relay: *Relay) void {
    while (true) {
        const stream = relay.server.accept(relay.io) catch return;
        const thread = std.Thread.spawn(.{}, serveConnection, .{ relay, stream }) catch {
            stream.close(relay.io);
            continue;
        };
        thread.detach();
    }
}

fn serveConnection(relay: *Relay, stream: Io.net.Stream) void {
    defer stream.close(relay.io);
    var receive_buffer: [64 * 1024]u8 = undefined;
    var send_buffer: [16 * 1024]u8 = undefined;
    var reader = stream.reader(relay.io, &receive_buffer);
    var writer = stream.writer(relay.io, &send_buffer);
    var server = std.http.Server.init(&reader.interface, &writer.interface);
    while (true) {
        var request = server.receiveHead() catch return;
        var arena_state = std.heap.ArenaAllocator.init(relay.gpa);
        defer arena_state.deinit();
        const relayed = relayOne(relay, arena_state.allocator(), &request) catch |err| {
            // The provider was unreachable or the stream broke mid-body; fx
            // sees the connection drop and the meter records a 502.
            relay.callback.function(relay.callback.context, .{ .status = 502, .usage = null, .error_body = @errorName(err), .retry_after_ms = null });
            return;
        };
        relay.callback.function(relay.callback.context, relayed);
        if (!request.head.keep_alive) return;
    }
}

fn relayOne(relay: *Relay, arena: std.mem.Allocator, request: *std.http.Server.Request) !Relayed {
    // Head strings are invalidated once the body reader starts; copy first.
    const method = request.head.method;
    const url = try std.mem.concat(arena, u8, &.{ relay.upstream, request.head.target });
    var authorization: ?[]const u8 = null;
    const content_type: ?[]const u8 = if (request.head.content_type) |value| try arena.dupe(u8, value) else null;
    // Every other header goes through as sent: the Codex endpoint needs
    // `chatgpt-account-id`, `originator` and its session ids, and a relay that
    // picks headers by name breaks the first provider it did not know.
    var extra: std.ArrayList(std.http.Header) = .empty;
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "authorization")) {
            authorization = try arena.dupe(u8, header.value);
        } else if (!isTransportHeader(header.name)) {
            try extra.append(arena, .{ .name = try arena.dupe(u8, header.name), .value = try arena.dupe(u8, header.value) });
        }
    }
    var body_buffer: [8 * 1024]u8 = undefined;
    const body_reader = try request.readerExpectContinue(&body_buffer);
    const body = try body_reader.allocRemaining(arena, .unlimited);

    var upstream = try relay.client.request(method, try std.Uri.parse(url), .{
        .redirect_behavior = .unhandled,
        .headers = .{
            .authorization = if (authorization) |value| .{ .override = value } else .omit,
            .content_type = if (content_type) |value| .{ .override = value } else .omit,
            // Identity, so the relay can read the usage frame it forwards.
            .accept_encoding = .{ .override = "identity" },
        },
        .extra_headers = extra.items,
    });
    defer upstream.deinit();
    if (method.requestHasBody()) {
        upstream.transfer_encoding = .{ .content_length = body.len };
        try upstream.sendBodyComplete(body);
    } else {
        try upstream.sendBodiless();
    }
    var response = try upstream.receiveHead(&.{});

    const status: u16 = @intFromEnum(response.head.status);
    const response_type: ?[]const u8 = if (response.head.content_type) |value| try arena.dupe(u8, value) else null;
    var retry_after: ?[]const u8 = null;
    var response_headers = response.head.iterateHeaders();
    while (response_headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "retry-after")) retry_after = try arena.dupe(u8, header.value);
    }
    var forwarded: [2]std.http.Header = undefined;
    var forwarded_len: usize = 0;
    if (response_type) |value| {
        forwarded[forwarded_len] = .{ .name = "content-type", .value = value };
        forwarded_len += 1;
    }
    if (retry_after) |value| {
        forwarded[forwarded_len] = .{ .name = "retry-after", .value = value };
        forwarded_len += 1;
    }

    var reply_buffer: [16 * 1024]u8 = undefined;
    var reply = try request.respondStreaming(&reply_buffer, .{ .respond_options = .{
        .status = response.head.status,
        .extra_headers = forwarded[0..forwarded_len],
    } });
    var transfer_buffer: [64 * 1024]u8 = undefined;
    const source = response.reader(&transfer_buffer);
    // Measured 2026-09-26: the Codex endpoint streams SSE with no
    // content-type at all, so a missing header is decided by the first bytes.
    var streaming = if (response_type) |value| std.mem.indexOf(u8, value, "text/event-stream") != null else false;
    var sniffed = response_type != null;
    const ok = status < 400;
    var pending: std.ArrayList(u8) = .empty;
    var whole: std.ArrayList(u8) = .empty;
    var metered: ?usage.Usage = null;
    while (true) {
        const data = source.peekGreedy(1) catch |err| switch (err) {
            error.EndOfStream => break,
            error.ReadFailed => return response.bodyErr() orelse err,
        };
        try reply.writer.writeAll(data);
        try reply.writer.flush();
        try reply.flush();
        if (!sniffed) {
            sniffed = true;
            streaming = looksLikeEventStream(data);
        }
        if (streaming) {
            try pending.appendSlice(arena, data);
            while (std.mem.indexOfScalar(u8, pending.items, '\n')) |newline| {
                if (usage.fromStreamLine(arena, pending.items[0..newline])) |found| metered = found;
                pending.replaceRangeAssumeCapacity(0, newline + 1, &.{});
            }
        } else if (ok or whole.items.len < error_body_limit) {
            try whole.appendSlice(arena, data);
        }
        source.toss(data.len);
    }
    try reply.end();
    if (streaming) {
        if (usage.fromStreamLine(arena, pending.items)) |found| metered = found;
    } else if (ok) {
        metered = usage.fromDocument(arena, whole.items);
    }
    return .{
        .status = status,
        .usage = metered,
        .error_body = if (ok) null else whole.items[0..@min(whole.items.len, error_body_limit)],
        .retry_after_ms = if (retry_after) |value| retryAfterMs(value) else null,
    };
}

/// Whether a body with no content-type starts as a server-sent event stream.
fn looksLikeEventStream(bytes: []const u8) bool {
    const head = std.mem.trimStart(u8, bytes, " \t\r\n");
    return std.mem.startsWith(u8, head, "data:") or std.mem.startsWith(u8, head, "event:") or std.mem.startsWith(u8, head, ":");
}

/// Headers the relay's own connections own, plus the two it sets itself.
fn isTransportHeader(name: []const u8) bool {
    const owned = [_][]const u8{ "host", "connection", "keep-alive", "content-length", "transfer-encoding", "accept-encoding", "expect", "te", "upgrade", "content-type" };
    for (owned) |candidate| {
        if (std.ascii.eqlIgnoreCase(name, candidate)) return true;
    }
    return false;
}

/// Seconds form only; the HTTP-date form carries no reset the controller
/// could not also get from waiting out its failover edge.
fn retryAfterMs(value: []const u8) ?u64 {
    const seconds = std.fmt.parseInt(u64, std.mem.trim(u8, value, " "), 10) catch return null;
    return if (seconds > 0) seconds * 1000 else null;
}

test "transport headers stay with the relay and provider headers pass through" {
    try std.testing.expect(isTransportHeader("Content-Length"));
    try std.testing.expect(isTransportHeader("accept-encoding"));
    try std.testing.expect(!isTransportHeader("chatgpt-account-id"));
    try std.testing.expect(!isTransportHeader("accept"));
}

test "a body without content-type is sniffed as SSE or JSON" {
    try std.testing.expect(looksLikeEventStream("event: response.created\ndata: {}"));
    try std.testing.expect(looksLikeEventStream("\ndata: {}"));
    try std.testing.expect(!looksLikeEventStream("{\"usage\":{}}"));
}

test "retry-after in seconds becomes milliseconds" {
    try std.testing.expectEqual(@as(?u64, 30_000), retryAfterMs("30"));
    try std.testing.expectEqual(@as(?u64, null), retryAfterMs("0"));
    try std.testing.expectEqual(@as(?u64, null), retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"));
}
