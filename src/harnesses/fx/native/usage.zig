//! Provider usage in the ledger's shape, where `inputTokens` excludes the
//! cached prefix. DeepSeek reports the split directly
//! (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`); OpenAI, vLLM and
//! Z.ai report `prompt_tokens_details.cached_tokens` inside `prompt_tokens`;
//! the Responses API reports `input_tokens_details.cached_tokens` inside
//! `input_tokens`.
//! fx 0.0.11 keeps neither, which is why the relay reads them itself.

const std = @import("std");

pub const Usage = struct {
    inputTokens: u64 = 0,
    outputTokens: u64 = 0,
    cacheReadInputTokens: u64 = 0,

    pub fn add(self: *Usage, other: Usage) void {
        self.inputTokens += other.inputTokens;
        self.outputTokens += other.outputTokens;
        self.cacheReadInputTokens += other.cacheReadInputTokens;
    }
};

fn count(object: std.json.ObjectMap, key: []const u8) ?u64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .integer => |n| if (n >= 0) @intCast(n) else null,
        else => null,
    };
}

/// The usage a Chat Completions body or stream frame carries, or null.
pub fn fromUsageObject(value: std.json.Value) ?Usage {
    const object = switch (value) {
        .object => |o| o,
        else => return null,
    };
    // The Responses API (fx's Codex provider) names the same counters
    // `input_tokens`, `output_tokens` and `input_tokens_details.cached_tokens`.
    if (count(object, "input_tokens")) |input| {
        var cached: u64 = 0;
        if (object.get("input_tokens_details")) |details| switch (details) {
            .object => |d| cached = count(d, "cached_tokens") orelse 0,
            else => {},
        };
        return .{ .inputTokens = input -| cached, .outputTokens = count(object, "output_tokens") orelse 0, .cacheReadInputTokens = cached };
    }
    const prompt = count(object, "prompt_tokens");
    const miss = count(object, "prompt_cache_miss_tokens");
    if (prompt == null and miss == null) return null;
    var hit = count(object, "prompt_cache_hit_tokens");
    if (hit == null) {
        if (object.get("prompt_tokens_details")) |details| switch (details) {
            .object => |d| hit = count(d, "cached_tokens"),
            else => {},
        };
    }
    const cached = hit orelse 0;
    return .{
        .inputTokens = miss orelse (prompt orelse 0) -| cached,
        .outputTokens = count(object, "completion_tokens") orelse 0,
        .cacheReadInputTokens = cached,
    };
}

/// The usage in one JSON document (a whole response body or one SSE payload).
pub fn fromDocument(arena: std.mem.Allocator, text: []const u8) ?Usage {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, text, .{}) catch return null;
    const object = switch (parsed) {
        .object => |o| o,
        else => return null,
    };
    if (object.get("usage")) |found| return fromUsageObject(found);
    // A Responses stream reports usage once, on `response.completed`, inside
    // the response object.
    const response = switch (object.get("response") orelse return null) {
        .object => |o| o,
        else => return null,
    };
    return fromUsageObject(response.get("usage") orelse return null);
}

/// The usage in one SSE line, or null for any other line.
pub fn fromStreamLine(arena: std.mem.Allocator, line: []const u8) ?Usage {
    const trimmed = std.mem.trim(u8, line, " \t\r");
    if (!std.mem.startsWith(u8, trimmed, "data:")) return null;
    const payload = std.mem.trim(u8, trimmed[5..], " \t");
    if (std.mem.eql(u8, payload, "[DONE]")) return null;
    return fromDocument(arena, payload);
}

test "both provider shapes become the ledger's shape" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    try std.testing.expectEqual(Usage{ .inputTokens = 100, .outputTokens = 50, .cacheReadInputTokens = 900 }, fromStreamLine(arena,
        \\data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":100}}
    ).?);
    try std.testing.expectEqual(Usage{ .inputTokens = 400, .outputTokens = 50, .cacheReadInputTokens = 600 }, fromDocument(arena,
        \\{"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":600}}}
    ).?);
    try std.testing.expectEqual(Usage{ .inputTokens = 10, .outputTokens = 2 }, fromDocument(arena,
        \\{"usage":{"prompt_tokens":10,"completion_tokens":2}}
    ).?);
    try std.testing.expectEqual(Usage{ .inputTokens = 300, .outputTokens = 40, .cacheReadInputTokens = 700 }, fromStreamLine(arena,
        \\data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":700},"output_tokens":40}}}
    ).?);
    try std.testing.expectEqual(@as(?Usage, null), fromStreamLine(arena, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}"));
    try std.testing.expectEqual(@as(?Usage, null), fromStreamLine(arena, "data: [DONE]"));
    try std.testing.expectEqual(@as(?Usage, null), fromStreamLine(arena, "data: {\"choices\":[{\"delta\":{}}]}"));
    try std.testing.expectEqual(@as(?Usage, null), fromStreamLine(arena, ": keep-alive"));
    try std.testing.expectEqual(@as(?Usage, null), fromDocument(arena, "{\"usage\":{\"completion_tokens\":2}}"));
}
