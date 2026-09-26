//! Faberun's fx client: one prompt on stdin, one JSONL transcript on stdout,
//! no interactive surface. It replaces the Node client (`../runner.mjs`) with
//! the same transcript, so the adapter and the controller cannot tell them
//! apart; measured 2026-09-24, that Node process peaked at 83 MB resident
//! beside a 9 MB `fx acp`, most of an fx worker's footprint.
//!
//! Why ACP instead of `fx ask --json`: `ask` prints its JSON once, at exit, and
//! its only permission choices are "everything" or "let the model review
//! itself". `fx acp` streams every tool call as it happens and, in `ask` mode,
//! sends each shell command and file mutation to this client as
//! `session/request_permission`, so the contract's sandbox is decided here.
//!
//! Transcript, the only thing this process writes to stdout:
//!   {"type":"fx.started","sessionId":string}
//!   {"type":"fx.tool","name":string,"target":string|null}      one per tool call
//!   {"type":"fx.request","status":number,"usage":Usage|null}   one per provider request
//!   {"type":"fx.message","text":string}                        one per non-empty assistant message
//!   {"type":"fx.completed","sessionId":string,"result":string,"usage":Usage|null}
//!   {"type":"fx.failed","sessionId":string|null,"kind":string,"error":{...},"usage":Usage|null}

const std = @import("std");
const Io = std.Io;
const home = @import("home.zig");
const permissions = @import("permissions.zig");
const relay_mod = @import("relay.zig");
const Usage = @import("usage.zig").Usage;

/// The provider name the generated settings give the relay connection.
const provider = "faberun";
/// fx's built-in ChatGPT-subscription provider, and the Responses endpoint it
/// posts to; the runner's relay stands in for the host.
const codex_provider = "codex";
const codex_upstream = "https://chatgpt.com/backend-api/codex";

/// Which of fx's provider paths the worker takes. `openai_compatible` is a
/// custom Chat Completions connection (DeepSeek, Z.ai) authenticated by a key
/// in the environment; `codex` is fx's ChatGPT login, which fx-faberun reads
/// from the operator's real profile through `FX_AUTH_HOME`.
const ProviderKind = enum { openai_compatible, codex };
/// Measured: DeepSeek's `max_tokens` ceiling on deepseek-flash; fx needs a declared value.
const max_output_tokens = 8192;

const Options = struct {
    fx: []const u8 = "fx",
    model: []const u8 = "",
    sandbox: []const u8 = "workspace-write",
    provider_kind: ProviderKind = .openai_compatible,
    base_url: ?[]const u8 = null,
    key_env: []const u8 = "DEEPSEEK_API_KEY",
    context_window: u64 = 1_000_000,
};

const ProviderFailure = struct {
    status: u16,
    body: []const u8,
    retry_after_ms: ?u64,
};

/// State the relay threads and the ACP loop share.
const Shared = struct {
    io: Io,
    gpa: std.mem.Allocator,
    mutex: Io.Mutex = .init,
    usage: Usage = .{},
    saw_usage: bool = false,
    last_failure: ?ProviderFailure = null,

    /// Whole-line writes to fd 1 under one lock, so relay threads and the ACP
    /// loop never interleave a record.
    fn emit(self: *Shared, event: anytype) void {
        var buffer: std.Io.Writer.Allocating = .init(self.gpa);
        defer buffer.deinit();
        std.json.Stringify.value(event, .{}, &buffer.writer) catch return;
        buffer.writer.writeByte('\n') catch return;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        Io.File.stdout().writeStreamingAll(self.io, buffer.written()) catch {};
    }

    fn onRequest(context: *anyopaque, request: relay_mod.Relayed) void {
        const self: *Shared = @ptrCast(@alignCast(context));
        {
            self.mutex.lockUncancelable(self.io);
            defer self.mutex.unlock(self.io);
            if (request.usage) |found| {
                self.usage.add(found);
                self.saw_usage = true;
            }
            if (self.last_failure) |old| self.gpa.free(old.body);
            self.last_failure = null;
            if (request.status >= 400) {
                const body = self.gpa.dupe(u8, request.error_body orelse "") catch "";
                self.last_failure = .{ .status = request.status, .body = body, .retry_after_ms = request.retry_after_ms };
            }
        }
        self.emit(.{ .type = "fx.request", .status = request.status, .usage = request.usage });
    }
};

fn parseArgs(args: []const [:0]const u8) !Options {
    var options: Options = .{};
    var index: usize = 0;
    while (index < args.len) : (index += 2) {
        const flag = args[index];
        if (index + 1 >= args.len) return fatal("{s} needs a value", .{flag});
        const value: []const u8 = args[index + 1];
        if (std.mem.eql(u8, flag, "--fx")) options.fx = value else if (std.mem.eql(u8, flag, "--model")) options.model = value else if (std.mem.eql(u8, flag, "--sandbox")) options.sandbox = value else if (std.mem.eql(u8, flag, "--provider")) options.provider_kind = parseProviderKind(value) orelse return fatal("unknown provider: {s}", .{value}) else if (std.mem.eql(u8, flag, "--base-url")) options.base_url = value else if (std.mem.eql(u8, flag, "--key-env")) options.key_env = value else if (std.mem.eql(u8, flag, "--context-window")) options.context_window = try std.fmt.parseInt(u64, value, 10) else return fatal("unknown argument: {s}", .{flag});
    }
    if (options.model.len == 0) return fatal("--model is required", .{});
    return options;
}

fn parseProviderKind(value: []const u8) ?ProviderKind {
    if (std.mem.eql(u8, value, "openai-compatible")) return .openai_compatible;
    if (std.mem.eql(u8, value, "codex")) return .codex;
    return null;
}

fn fatal(comptime format: []const u8, args: anytype) error{Usage} {
    std.debug.print(format ++ "\n", args);
    return error.Usage;
}

/// The failure a provider status means. 402 is DeepSeek's "Insufficient
/// Balance" and 429 its rate limit; both name the exhaustion the declared
/// failover edge exists for.
fn providerCode(arena: std.mem.Allocator, status: u16) ![]const u8 {
    return switch (status) {
        429 => "RATE_LIMIT",
        402 => "QUOTA",
        else => try std.fmt.allocPrint(arena, "http_{d}", .{status}),
    };
}

const Runner = struct {
    arena: std.mem.Allocator,
    io: Io,
    shared: *Shared,
    options: Options,
    workspace: []const u8,
    home_dir: []const u8,
    relay: *relay_mod.Relay,
    child: *std.process.Child,
    session_id: ?[]const u8 = null,
    segment: std.ArrayList(u8) = .empty,
    last_text: []const u8 = "",

    fn send(self: *Runner, message: anytype) !void {
        var buffer: std.Io.Writer.Allocating = .init(self.arena);
        try std.json.Stringify.value(message, .{ .emit_null_optional_fields = false }, &buffer.writer);
        try buffer.writer.writeByte('\n');
        try self.child.stdin.?.writeStreamingAll(self.io, buffer.written());
    }

    fn flushSegment(self: *Runner) void {
        if (std.mem.trim(u8, self.segment.items, " \t\r\n").len == 0) return;
        const text = self.arena.dupe(u8, self.segment.items) catch return;
        self.last_text = text;
        self.shared.emit(.{ .type = "fx.message", .text = text });
        self.segment.clearRetainingCapacity();
    }

    fn usageOrNull(self: *Runner) ?Usage {
        self.shared.mutex.lockUncancelable(self.io);
        defer self.shared.mutex.unlock(self.io);
        return if (self.shared.saw_usage) self.shared.usage else null;
    }

    fn cleanup(self: *Runner) void {
        self.child.kill(self.io);
        self.relay.stop();
        Io.Dir.cwd().deleteTree(self.io, self.home_dir) catch {};
    }

    fn complete(self: *Runner) noreturn {
        self.flushSegment();
        self.shared.emit(.{ .type = "fx.completed", .sessionId = self.session_id, .result = self.last_text, .usage = self.usageOrNull() });
        self.cleanup();
        std.process.exit(0);
    }

    /// A provider status beats fx's prose about it: it is the fact failover keys on.
    fn fail(self: *Runner, kind: []const u8, code: []const u8, message: []const u8) noreturn {
        self.flushSegment();
        const failure = blk: {
            self.shared.mutex.lockUncancelable(self.io);
            defer self.shared.mutex.unlock(self.io);
            break :blk self.shared.last_failure;
        };
        const Error = struct { code: []const u8, message: []const u8, retryAfterMs: ?u64 = null };
        const err: Error = if (failure) |f| .{
            .code = providerCode(self.arena, f.status) catch "http_error",
            .message = std.fmt.allocPrint(self.arena, "{d} {s}", .{ f.status, f.body[0..@min(f.body.len, 500)] }) catch "provider error",
            .retryAfterMs = f.retry_after_ms,
        } else .{ .code = code, .message = message };
        self.shared.emit(.{
            .type = "fx.failed",
            .sessionId = self.session_id,
            .kind = if (failure != null) "error" else kind,
            .@"error" = err,
            .usage = self.usageOrNull(),
        });
        self.cleanup();
        std.process.exit(1);
    }

    fn onPermission(self: *Runner, id: std.json.Value, params: std.json.ObjectMap) !void {
        const tool_call = objectField(params, "toolCall");
        const kind = if (tool_call) |call| stringField(call, "kind") orelse "other" else "other";
        const path = if (tool_call) |call| if (objectField(call, "rawInput")) |input| stringField(input, "path") else null else null;
        const decision = try permissions.verdict(self.arena, self.options.sandbox, self.workspace, kind, path);
        const wanted = if (decision.allow) "allow_once" else "reject_once";
        if (!decision.allow) {
            const title = if (tool_call) |call| stringField(call, "title") orelse "a tool call" else "a tool call";
            std.debug.print("faberun denied {s}: {s}\n", .{ title, decision.reason orelse "" });
        }
        var option_id: ?[]const u8 = null;
        if (params.get("options")) |options| if (options == .array) for (options.array.items) |option| {
            if (option != .object) continue;
            const option_kind = stringField(option.object, "kind") orelse continue;
            if (std.mem.eql(u8, option_kind, wanted)) option_id = stringField(option.object, "optionId");
        };
        const Selected = struct { outcome: []const u8, optionId: ?[]const u8 = null };
        try self.send(.{ .jsonrpc = "2.0", .id = id, .result = .{
            .outcome = if (option_id) |value| Selected{ .outcome = "selected", .optionId = value } else Selected{ .outcome = "cancelled" },
        } });
    }

    fn onUpdate(self: *Runner, update: std.json.ObjectMap) !void {
        const kind = stringField(update, "sessionUpdate") orelse return;
        if (std.mem.eql(u8, kind, "agent_message_chunk")) {
            if (objectField(update, "content")) |content| if (stringField(content, "text")) |text| {
                try self.segment.appendSlice(self.arena, text);
            };
        } else if (std.mem.eql(u8, kind, "tool_call")) {
            // A tool call ends the message before it, the boundary a judge's
            // verdicts are counted on.
            self.flushSegment();
            self.shared.emit(.{ .type = "fx.tool", .name = stringField(update, "kind") orelse "tool", .target = toolTarget(update) });
        }
    }
};

fn objectField(object: std.json.ObjectMap, key: []const u8) ?std.json.ObjectMap {
    const value = object.get(key) orelse return null;
    return if (value == .object) value.object else null;
}

fn stringField(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return if (value == .string) value.string else null;
}

fn toolTarget(update: std.json.ObjectMap) ?[]const u8 {
    const input = objectField(update, "rawInput") orelse return null;
    for ([_][]const u8{ "path", "command", "pattern", "url" }) |key| {
        if (stringField(input, key)) |value| return value[0..@min(value.len, 200)];
    }
    return null;
}

var child_pid = std.atomic.Value(i32).init(0);

/// The controller cancels a worker with SIGTERM; fx must not outlive it.
fn onSignal(signal: std.posix.SIG) callconv(.c) void {
    const pid = child_pid.load(.monotonic);
    if (pid > 0) std.posix.kill(pid, .TERM) catch {};
    std.process.exit(@truncate(128 + @as(u32, @intFromEnum(signal))));
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    const options = parseArgs(args[1..]) catch std.process.exit(2);

    var stdin_buffer: [64 * 1024]u8 = undefined;
    var stdin = Io.File.stdin().readerStreaming(io, &stdin_buffer);
    const prompt = try stdin.interface.allocRemaining(arena, .unlimited);

    var cwd_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = cwd_buffer[0..try std.process.currentPath(io, &cwd_buffer)];
    const workspace = try Io.Dir.realPathFileAbsoluteAlloc(io, cwd, arena);

    var shared: Shared = .{ .io = io, .gpa = gpa };
    const upstream = options.base_url orelse switch (options.provider_kind) {
        .openai_compatible => "https://api.deepseek.com",
        .codex => codex_upstream,
    };
    const relay = try relay_mod.start(gpa, io, upstream, .{ .context = &shared, .function = Shared.onRequest });

    const real_home = init.environ_map.get("HOME") orelse return error.HomeNotSet;
    const tmp_root = init.environ_map.get("TMPDIR") orelse "/tmp";
    var nonce: [8]u8 = undefined;
    io.random(&nonce);
    const home_dir = try std.fmt.allocPrint(arena, "{s}/faberun-fx-home-{x}", .{ std.mem.trimEnd(u8, tmp_root, "/"), nonce });
    try Io.Dir.cwd().createDirPath(io, home_dir);

    const base_url = try std.fmt.allocPrint(arena, "http://127.0.0.1:{d}", .{relay.port()});
    var settings: std.Io.Writer.Allocating = .init(arena);
    switch (options.provider_kind) {
        .openai_compatible => {
            var json: std.json.Stringify = .{ .writer = &settings.writer, .options = .{ .whitespace = .indent_2 } };
            try json.beginObject();
            try json.objectField("provider");
            try json.write(provider);
            try json.objectField("models");
            try json.beginObject();
            try json.objectField(provider);
            try json.write(options.model);
            try json.endObject();
            try json.objectField("permission_mode");
            try json.write("ask");
            try json.objectField("providers");
            try json.beginObject();
            try json.objectField(provider);
            try json.beginObject();
            try json.objectField("protocol");
            try json.write("openai-chat-completions");
            try json.objectField("base_url");
            try json.write(base_url);
            try json.objectField("auth");
            try json.write(.{ .type = "bearer", .env = options.key_env });
            try json.objectField("model_metadata");
            try json.beginObject();
            try json.objectField(options.model);
            try json.write(.{ .context_window = options.context_window, .max_output_tokens = max_output_tokens, .supports_tool_use = true });
            try json.endObject();
            try json.endObject();
            try json.endObject();
            try json.endObject();
            try settings.writer.writeByte('\n');
        },
        .codex => {
            var json: std.json.Stringify = .{ .writer = &settings.writer, .options = .{ .whitespace = .indent_2 } };
            try json.beginObject();
            try json.objectField("provider");
            try json.write(codex_provider);
            try json.objectField("models");
            try json.beginObject();
            try json.objectField(codex_provider);
            try json.write(options.model);
            try json.endObject();
            try json.objectField("permission_mode");
            try json.write("ask");
            try json.endObject();
            try settings.writer.writeByte('\n');
        },
    }
    const settings_text = settings.written();
    try home.prepare(arena, io, real_home, home_dir, settings_text);

    var environ = try init.environ_map.clone(arena);
    try environ.put("HOME", home_dir);
    switch (options.provider_kind) {
        .openai_compatible => try environ.put("FX_PROVIDER", provider),
        .codex => {
            try environ.put("FX_PROVIDER", codex_provider);
            // The ChatGPT session stays in the operator's profile: a copy
            // would diverge on the first token refresh (fx-faberun only).
            try environ.put("FX_AUTH_HOME", real_home);
            // fx accepts a loopback override of the Responses endpoint, which
            // is how the relay meters this provider as it does the others.
            try environ.put("FX_E2E_OPENAI_CODEX_RESPONSES_URL", try std.fmt.allocPrint(arena, "{s}/responses", .{base_url}));
        },
    }
    try environ.put("FX_PERMISSION_MODE", "ask");
    try environ.put("FX_AUTO_UPGRADE", "0");
    // fx plays a sound on every send and response, which a detached campaign
    // of parallel workers turns into noise on the operator's machine.
    try environ.put("FX_SOUND", "0");

    var child = std.process.spawn(io, .{
        .argv = &.{ options.fx, "acp" },
        .environ_map = &environ,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .inherit,
    }) catch |err| {
        Io.Dir.cwd().deleteTree(io, home_dir) catch {};
        shared.emit(.{ .type = "fx.failed", .sessionId = @as(?[]const u8, null), .kind = "harness_exit", .@"error" = .{
            .code = "harness_exit",
            .message = try std.fmt.allocPrint(arena, "cannot start {s}: {s}", .{ options.fx, @errorName(err) }),
        }, .usage = @as(?Usage, null) });
        std.process.exit(1);
    };
    if (child.id) |pid| child_pid.store(@intCast(pid), .monotonic);
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = onSignal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.TERM, &action, null);
    std.posix.sigaction(.INT, &action, null);

    var runner: Runner = .{
        .arena = arena,
        .io = io,
        .shared = &shared,
        .options = options,
        .workspace = workspace,
        .home_dir = home_dir,
        .relay = relay,
        .child = &child,
    };

    try runner.send(.{ .jsonrpc = "2.0", .id = 1, .method = "initialize", .params = .{
        .protocolVersion = 1,
        .clientCapabilities = .{ .fs = .{ .readTextFile = false, .writeTextFile = false }, .terminal = false },
    } });

    var read_buffer: [64 * 1024]u8 = undefined;
    var from_fx = child.stdout.?.readerStreaming(io, &read_buffer);
    var line: std.Io.Writer.Allocating = .init(gpa);
    defer line.deinit();
    while (true) {
        line.clearRetainingCapacity();
        _ = from_fx.interface.streamDelimiter(&line.writer, '\n') catch |err| switch (err) {
            error.EndOfStream => runner.fail("harness_exit", "harness_exit", "fx exited before the turn ended"),
            else => runner.fail("harness_exit", "harness_exit", @errorName(err)),
        };
        from_fx.interface.toss(1);
        if (std.mem.trim(u8, line.written(), " \t\r").len == 0) continue;
        var message_arena = std.heap.ArenaAllocator.init(gpa);
        defer message_arena.deinit();
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, message_arena.allocator(), line.written(), .{}) catch {
            // stdout carries the JSON-RPC transport only; a non-JSON line is a
            // harness defect, not provider prose, and must not be dropped.
            runner.fail("invalid_protocol", "invalid_protocol", try std.fmt.allocPrint(arena, "fx wrote a non-JSON line: {s}", .{line.written()[0..@min(line.written().len, 200)]}));
        };
        if (parsed != .object) continue;
        const message = parsed.object;
        const method = stringField(message, "method");
        const id = message.get("id");
        if (method != null and id != null) {
            if (std.mem.eql(u8, method.?, "session/request_permission")) {
                try runner.onPermission(id.?, objectField(message, "params") orelse continue);
            } else {
                try runner.send(.{ .jsonrpc = "2.0", .id = id.?, .@"error" = .{ .code = -32601, .message = "faberun does not serve this method" } });
            }
            continue;
        }
        if (method) |name| {
            if (std.mem.eql(u8, name, "session/update")) {
                if (objectField(message, "params")) |params| if (objectField(params, "update")) |update| try runner.onUpdate(update);
            }
            continue;
        }
        const reply_id = if (id) |value| if (value == .integer) value.integer else continue else continue;
        if (message.get("error")) |err| {
            const text = try std.fmt.allocPrint(arena, "{f}", .{std.json.fmt(err, .{})});
            switch (reply_id) {
                1 => runner.fail("initialize_failed", "initialize_failed", text),
                2 => runner.fail("session_failed", "session_failed", text),
                else => runner.fail("prompt_failed", "prompt_failed", text),
            }
        }
        const result = objectField(message, "result") orelse continue;
        switch (reply_id) {
            1 => try runner.send(.{ .jsonrpc = "2.0", .id = 2, .method = "session/new", .params = .{ .cwd = workspace, .mcpServers = [_]u32{} } }),
            2 => {
                const session = stringField(result, "sessionId") orelse runner.fail("session_failed", "session_failed", "session/new returned no sessionId");
                runner.session_id = try arena.dupe(u8, session);
                shared.emit(.{ .type = "fx.started", .sessionId = runner.session_id });
                try runner.send(.{ .jsonrpc = "2.0", .id = 3, .method = "session/prompt", .params = .{
                    .sessionId = runner.session_id.?,
                    .prompt = [_]struct { type: []const u8, text: []const u8 }{.{ .type = "text", .text = prompt }},
                } });
            },
            3 => {
                const stop = stringField(result, "stopReason") orelse "unknown";
                if (!std.mem.eql(u8, stop, "end_turn")) {
                    const text = try std.fmt.allocPrint(arena, "the turn ended: {s}", .{stop});
                    runner.fail(if (std.mem.eql(u8, stop, "cancelled")) "aborted" else try arena.dupe(u8, stop), try arena.dupe(u8, stop), text);
                }
                if (runner.usageOrNull() == null) {
                    // No request reached the relay with usage; fx's own totals
                    // are the fallback, without the cache split it cannot report.
                    if (objectField(result, "usage")) |reported| {
                        shared.mutex.lockUncancelable(io);
                        defer shared.mutex.unlock(io);
                        const input = reported.get("inputTokens");
                        const output = reported.get("outputTokens");
                        shared.usage.inputTokens = if (input) |v| if (v == .integer and v.integer >= 0) @intCast(v.integer) else 0 else 0;
                        shared.usage.outputTokens = if (output) |v| if (v == .integer and v.integer >= 0) @intCast(v.integer) else 0 else 0;
                        shared.saw_usage = true;
                    }
                }
                runner.complete();
            },
            else => {},
        }
    }
}

test {
    _ = home;
    _ = permissions;
    _ = relay_mod;
    _ = @import("usage.zig");
}
