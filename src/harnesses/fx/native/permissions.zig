//! The file-effect boundary for an fx worker, decided per ACP permission
//! request. fx in `ask` mode asks its client before every shell command and
//! file mutation, so the contract's `sandbox` value becomes a decision this
//! module makes, not a mode fx is trusted to enforce.

const std = @import("std");

pub const Verdict = struct {
    allow: bool,
    reason: ?[]const u8 = null,
};

/// Shell commands run in every mode, as they do under dsh's
/// `workspace-write`: the worktree, not a shell parser, bounds them. File
/// mutations are decided by path. `reason` is allocated in `arena` when set.
pub fn verdict(arena: std.mem.Allocator, sandbox: []const u8, workspace: []const u8, kind: []const u8, path: ?[]const u8) !Verdict {
    if (std.mem.eql(u8, sandbox, "danger-full-access")) return .{ .allow = true };
    for ([_][]const u8{ "read", "search", "think", "execute" }) |free| {
        if (std.mem.eql(u8, kind, free)) return .{ .allow = true };
    }
    const mutates = std.mem.eql(u8, kind, "edit") or std.mem.eql(u8, kind, "delete") or std.mem.eql(u8, kind, "move");
    if (!mutates) return .{ .allow = false, .reason = try std.fmt.allocPrint(arena, "{s} tools need danger-full-access", .{kind}) };
    if (std.mem.eql(u8, sandbox, "read-only")) return .{ .allow = false, .reason = "the sandbox is read-only" };
    const named = path orelse return .{ .allow = false, .reason = "a file mutation named no path" };
    if (named.len == 0) return .{ .allow = false, .reason = "a file mutation named no path" };
    const resolved = try std.fs.path.resolve(arena, &.{ workspace, named });
    const inside = resolved.len > workspace.len and
        std.mem.startsWith(u8, resolved, workspace) and
        resolved[workspace.len] == std.fs.path.sep;
    if (!inside) return .{ .allow = false, .reason = try std.fmt.allocPrint(arena, "{s} is outside the workspace", .{named}) };
    return .{ .allow = true };
}

test "file mutations are bounded by path and commands run" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const ws = "/work/tree";
    try std.testing.expect((try verdict(arena, "workspace-write", ws, "edit", "src/a.mjs")).allow);
    try std.testing.expect((try verdict(arena, "workspace-write", ws, "edit", "/work/tree/src/a.mjs")).allow);
    try std.testing.expect(!(try verdict(arena, "workspace-write", ws, "edit", "../escape.txt")).allow);
    try std.testing.expect(!(try verdict(arena, "workspace-write", ws, "edit", "/work/treehouse/a")).allow);
    try std.testing.expect(!(try verdict(arena, "workspace-write", ws, "edit", "/etc/hosts")).allow);
    try std.testing.expect(!(try verdict(arena, "workspace-write", ws, "edit", null)).allow);
    try std.testing.expect((try verdict(arena, "workspace-write", ws, "execute", null)).allow);
    try std.testing.expect(!(try verdict(arena, "workspace-write", ws, "fetch", null)).allow);
    try std.testing.expect(!(try verdict(arena, "read-only", ws, "edit", "src/a.mjs")).allow);
    try std.testing.expect((try verdict(arena, "danger-full-access", ws, "edit", "/etc/hosts")).allow);
    const outside = try verdict(arena, "workspace-write", ws, "edit", "../escape.txt");
    try std.testing.expectEqualStrings("../escape.txt is outside the workspace", outside.reason.?);
}
