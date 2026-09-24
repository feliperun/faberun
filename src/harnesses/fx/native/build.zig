//! Builds `faberun-fx-runner`, the native fx client the fx adapter spawns.
//! `zig build` installs it to `zig-out/bin/`; `zig build test` runs the unit
//! tests of every module.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // ReleaseSafe unless told otherwise: the runner ships to operators, and
    // Debug is 4x the binary for no runtime check ReleaseSafe drops.
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "Optimization mode (default ReleaseSafe)") orelse .ReleaseSafe;
    const module = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });
    b.installArtifact(b.addExecutable(.{ .name = "faberun-fx-runner", .root_module = module }));
    const tests = b.addTest(.{ .root_module = module });
    b.step("test", "Run the runner's unit tests").dependOn(&b.addRunArtifact(tests).step);
}
