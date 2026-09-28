//! The HOME an fx worker runs under. fx reads provider connections only from
//! `$HOME/.fx/settings.json` and has no flag or variable that names another
//! settings file, so pointing a worker at its own usage relay means giving it
//! its own HOME. The same boundary closes the packet: fx loads every skill it
//! finds under `~/.fx`, `~/.claude`, `~/.codex`, `~/.agents` and
//! `~/.config/opencode` (fx 0.0.11 `skill_runtime.zig`), none of which a closed
//! task packet asked for.
//!
//! Everything else in the operator's HOME is linked in, because the worker's
//! shell inherits this HOME: git identity, npm and toolchain caches, and
//! version managers keep resolving to the real files.

const std = @import("std");
const Io = std.Io;

/// Top-level HOME entries fx scans for skills or reads as its own profile.
const withheld = [_][]const u8{ ".fx", ".claude", ".codex", ".agents" };
/// Entries under `~/.config` fx scans for skills.
const withheld_config = [_][]const u8{"opencode"};

fn isWithheld(name: []const u8, list: []const []const u8) bool {
    for (list) |entry| if (std.mem.eql(u8, entry, name)) return true;
    return false;
}

/// Links every entry of `from` into `to` except `list` and `rebuilt`.
fn linkEntries(arena: std.mem.Allocator, io: Io, from: []const u8, to: []const u8, list: []const []const u8, rebuilt: ?[]const u8) !void {
    var dir = Io.Dir.openDirAbsolute(io, from, .{ .iterate = true }) catch |err| switch (err) {
        // An operator without `~/.config` has nothing to link from it.
        error.FileNotFound => return,
        else => return err,
    };
    defer dir.close(io);
    var entries = dir.iterate();
    while (try entries.next(io)) |entry| {
        if (isWithheld(entry.name, list)) continue;
        if (rebuilt) |name| if (std.mem.eql(u8, entry.name, name)) continue;
        const target = try std.fs.path.join(arena, &.{ from, entry.name });
        const link = try std.fs.path.join(arena, &.{ to, entry.name });
        try Io.Dir.symLinkAbsolute(io, target, link, .{});
    }
}

/// Fill `home`, an empty directory the caller owns and removes, with links to
/// `real_home` and the fx settings document `settings`.
pub fn prepare(arena: std.mem.Allocator, io: Io, real_home: []const u8, home: []const u8, settings: []const u8) !void {
    try linkEntries(arena, io, real_home, home, &withheld, ".config");
    const config = try std.fs.path.join(arena, &.{ home, ".config" });
    try Io.Dir.cwd().createDirPath(io, config);
    try linkEntries(arena, io, try std.fs.path.join(arena, &.{ real_home, ".config" }), config, &withheld_config, null);
    // fx on Linux refuses a profile directory others can read
    // (`private_state_permissions_unsupported`); macOS did not check.
    const fx_dir = try std.fs.path.join(arena, &.{ home, ".fx" });
    _ = try Io.Dir.cwd().createDirPathStatus(io, fx_dir, .fromMode(0o700));
    var dir = try Io.Dir.openDirAbsolute(io, fx_dir, .{});
    defer dir.close(io);
    try dir.writeFile(io, .{ .sub_path = "settings.json", .data = settings, .flags = .{ .permissions = .fromMode(0o600) } });
}

test "the worker HOME withholds every skill root and links the rest" {
    const io = std.testing.io;
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [4096]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];
    for ([_][]const u8{ "real/.fx", "real/.claude", "real/.codex", "real/.agents", "real/.npm", "real/.config/opencode", "real/.config/git", "home" }) |sub| {
        try tmp.dir.createDirPath(io, sub);
    }
    const real = try std.fs.path.join(arena, &.{ root, "real" });
    const home = try std.fs.path.join(arena, &.{ root, "home" });
    try prepare(arena, io, real, home, "{\"provider\":\"faberun\"}\n");
    for ([_][]const u8{ "home/.claude", "home/.codex", "home/.agents", "home/.config/opencode" }) |sub| {
        try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, sub, .{}));
    }
    var link_buf: [4096]u8 = undefined;
    const npm = link_buf[0..try tmp.dir.readLink(io, "home/.npm", &link_buf)];
    try std.testing.expectEqualStrings(try std.fs.path.join(arena, &.{ real, ".npm" }), npm);
    const git = link_buf[0..try tmp.dir.readLink(io, "home/.config/git", &link_buf)];
    try std.testing.expectEqualStrings(try std.fs.path.join(arena, &.{ real, ".config", "git" }), git);
    const settings = try tmp.dir.readFileAlloc(io, "home/.fx/settings.json", arena, .unlimited);
    try std.testing.expectEqualStrings("{\"provider\":\"faberun\"}\n", settings);
}
