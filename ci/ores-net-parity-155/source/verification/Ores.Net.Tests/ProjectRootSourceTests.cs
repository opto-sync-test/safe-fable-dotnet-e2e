using Ores.Net.Compiler;

internal static class ProjectRootSourceTests
{
    private static void Check(bool ok, string reason)
    {
        if (!ok) throw new Exception("project-root import contract: " + reason);
    }

    private static void Reject(Action operation, string reason)
    {
        try { operation(); }
        catch (FormatException) { return; }
        throw new Exception("unsafe project-root source admitted: " + reason);
    }

    public static void Run()
    {
        string root = Path.Combine(Path.GetTempPath(), "ores-net-root-" + Guid.NewGuid().ToString("N"));
        try
        {
            string app = Path.Combine(root, "app");
            string source = Path.Combine(app, "src", "answer.ores");
            Directory.CreateDirectory(Path.GetDirectoryName(source)!);
            File.WriteAllText(source, "pub fnc answer():int{return 42;}\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "package root without manifest");
            var manifest = Path.Combine(app, ".ores.pkg.toml");
            File.WriteAllText(manifest, "schema_version = \"2\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "unsupported manifest version");
            File.WriteAllText(manifest, "schema_version = \"1\"\nschema_version = \"1\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "duplicate manifest version");
            File.WriteAllText(manifest, "name = \"demo\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "missing manifest version");
            File.WriteAllText(manifest, "schema_version = \"1\"\n" + new string('\n', 65_536));
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "oversized newline-only manifest");
            File.WriteAllText(manifest, "schema_version = \"1\"\n");
            Check(ProjectRootSourceResolver.Resolve(app, "+/src/answer") == Path.GetFullPath(source),
                  "inferred extension");
            // TOML line endings are LF or CRLF. A bare CR can otherwise
            // conceal [project] or a second root after a # comment.
            File.WriteAllText(manifest,
                "schema_version = \"1\" # comment\r[project]\rroot = \"../other\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "bare CR concealed project root after comment");
            File.WriteAllText(manifest, "schema_version = \"1\"\r");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "bare CR at EOF admitted");
            File.WriteAllText(manifest, "schema_version = \"1\"\r\n");
            Check(ProjectRootSourceResolver.Resolve(app, "+/src/answer") == Path.GetFullPath(source),
                  "legal CRLF manifest was incorrectly rejected");

            string legacyManifest = Path.Combine(app, ".oreslangc.cfg.toml");
            File.WriteAllText(legacyManifest, "schema_version = \"1\"\n");
            File.Delete(manifest);
            Directory.CreateDirectory(manifest);
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "modern directory marker fell back to valid legacy manifest");
            Directory.Delete(manifest);
            try
            {
                File.CreateSymbolicLink(manifest, legacyManifest);
                Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                       "symlinked modern marker inherited legacy authority");
                File.Delete(manifest);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or
                     PlatformNotSupportedException or IOException)
            {
                // Some Windows runners deny test symlink creation; the
                // deterministic directory-marker regression still executes.
                if (File.Exists(manifest)) File.Delete(manifest);
            }
            File.WriteAllText(manifest, "schema_version = \"1\"\n");
            // Host-only explicit relative resolution, never bare .hidden lookup
            // and never authority across a nested legacy package manifest.
            string routes = Path.Combine(app, "src", "routes");
            Directory.CreateDirectory(routes);
            string importer = Path.Combine(routes, "main.ores");
            File.WriteAllText(importer, "fnc main():int{return 42;}\n");
            string local = Path.Combine(routes, "local.ores");
            File.WriteAllText(local, "fnc local():int{return 42;}\n");
            Check(ProjectRootSourceResolver.ResolveRelative(importer, "./local", app) ==
                  Path.GetFullPath(local), "./ did not resolve relative to importer");
            Check(ProjectRootSourceResolver.ResolveRelative(importer, "../answer", app) ==
                  Path.GetFullPath(source), "../ did not resolve relative to importer");
            foreach (var bad in new[] { "local", ".hidden/local", "./", "../",
                                        "./missing", "./local.java", "./main",
                                        "../../../../outside", "./local//alias",
                                        "./local\\\\alias" })
                Reject(() => ProjectRootSourceResolver.ResolveRelative(importer, bad, app),
                       "bad relative import admitted: " + bad);
            var legacyChild = Path.Combine(routes, "child");
            Directory.CreateDirectory(legacyChild);
            File.WriteAllText(Path.Combine(legacyChild, "hidden.ores"),
                              "fnc hidden():int{return 1;}\n");
            File.WriteAllText(Path.Combine(legacyChild, ".oreslangc.cfg.toml"),
                              "legacy marker\n");
            Reject(() => ProjectRootSourceResolver.ResolveRelative(importer, "./child/hidden", app),
                   "relative import crossed nested legacy package");
            // A dangling legacy marker is still authoritative: never treat
            // it as absent and permit a parent's relative import.
            string danglingMarker = Path.Combine(legacyChild, ".oreslangc.cfg.toml");
            File.Delete(danglingMarker);
            bool danglingCreated = false;
            try
            {
                File.CreateSymbolicLink(danglingMarker,
                    Path.Combine(legacyChild, "nonexistent-legacy-config.toml"));
                danglingCreated = true;
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or
                     PlatformNotSupportedException or IOException)
            {
                // Some runner environments prohibit symlink fixtures.
            }
            try
            {
                if (danglingCreated)
                    Reject(() => ProjectRootSourceResolver.ResolveRelative(
                            importer, "./child/hidden", app),
                           "dangling nested legacy marker lost package authority");
            }
            finally
            {
                if (danglingCreated) File.Delete(danglingMarker);
                File.WriteAllText(danglingMarker, "legacy marker\n");
            }
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/routes/child/hidden"),
                   "rooted import crossed nested legacy package");
            // A parent-owned importer must not launder child package
            // ownership through a symlinked *target* in its own directory.
            string targetAlias = Path.Combine(routes, "child-alias.ores");
            bool aliasCreated = false;
            try
            {
                File.CreateSymbolicLink(targetAlias, Path.Combine(legacyChild, "hidden.ores"));
                aliasCreated = true;
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or
                     PlatformNotSupportedException or IOException)
            {
                // Nonprivileged Windows test runners may deny symlink creation.
            }
            if (aliasCreated)
                Reject(() => ProjectRootSourceResolver.ResolveRelative(
                        importer, "./child-alias", app),
                       "relative target symlink bypassed nested legacy package");
            string selectedFile = Path.Combine(app, "appdata", "lib", "answer.ores");
            Directory.CreateDirectory(Path.GetDirectoryName(selectedFile)!);
            File.WriteAllText(selectedFile, "pub fnc answer():int{return 42;}\n");
            File.WriteAllText(manifest,
                "schema_version = \"1\"\n[project]\nroot = \"appdata\"\n");
            Check(ProjectRootSourceResolver.Resolve(app, "+/lib/answer") ==
                  Path.GetFullPath(selectedFile), "explicit project.root ignored");
            string selectedEntry = Path.Combine(app, "appdata", "src", "entry.ores");
            Directory.CreateDirectory(Path.GetDirectoryName(selectedEntry)!);
            File.WriteAllText(selectedEntry, "fnc main():int{return 42;}\n");
            Check(ProjectRootSourceResolver.ResolveRelative(
                    selectedEntry, "../lib/answer", Path.Combine(app, "appdata")) ==
                  Path.GetFullPath(selectedFile),
                  "relative import escaped the configured project root namespace");
            Reject(() => ProjectRootSourceResolver.ResolveRelative(
                    selectedEntry, "../../src/answer", Path.Combine(app, "appdata")),
                   "relative source crossed configured project root boundary");
            string nestedManifest = Path.Combine(app, "appdata", ".ores.pkg.toml");
            File.WriteAllText(nestedManifest, "schema_version = \"1\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                   "nested package manifest must not inherit parent authority");
            File.Delete(nestedManifest);
            string intermediate = Path.Combine(app, "parent", "appdata");
            Directory.CreateDirectory(Path.Combine(intermediate, "lib"));
            File.WriteAllText(Path.Combine(intermediate, "lib", "answer.ores"),
                "pub fnc answer():int{return 42;}\n");
            string intermediateManifest = Path.Combine(app, "parent", ".ores.pkg.toml");
            File.WriteAllText(intermediateManifest, "schema_version = \"1\"\n");
            File.WriteAllText(manifest,
                "schema_version = \"1\"\n[project]\nroot = \"parent/appdata\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                   "intermediate nested package manifest ignored");
            File.Delete(intermediateManifest);
            File.WriteAllText(manifest,
                "schema_version = \"1\"\n[project]\nroot = \"appdata\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/answer"),
                   "manifest directory escaped selected project.root");
            foreach (var invalidRoot in new[] { "../other", "/tmp", "appdata/../src",
                                                 "", "appdata\\other", "appdata//lib", "appdata/", "appdata/." })
            {
                File.WriteAllText(manifest,
                    "schema_version = \"1\"\n[project]\nroot = \"" + invalidRoot + "\"\n");
                Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                       "unsafe project.root accepted: " + invalidRoot);
            }
            File.WriteAllText(manifest,
                "schema_version = \"1\"\n[project]\nroot = \"appdata\"\nroot = \"appdata\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                   "duplicate project.root accepted");
            File.WriteAllText(manifest, "schema_version = \"1\"\n[ project ]\nroot = \"appdata\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                   "unrecognized project table silently ignored");
            File.WriteAllText(manifest, "schema_version = \"1\"\n[project]\n[project]\nroot = \"appdata\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                   "duplicate project table admitted");
            File.WriteAllText(manifest, "schema_version = \"1\"\nproject.root = \"appdata\"\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/lib/answer"),
                   "unsupported dotted root accepted");
            File.WriteAllText(manifest, "schema_version = \"1\"\n");

            Check(ProjectRootSourceResolver.Resolve(app, "+/src/answer.ores") ==
                  Path.GetFullPath(source), "exact extension");
            foreach (var bad in new[] {
                "", "+", "+src/answer", "@/", "@/src/answer", "+/", "+//src/answer",
                "+/src//answer", "+/src/./answer", "+/src/../src/answer",
                "+/src/answer/", "+/src\\answer", "+/src:answer",
                "+/missing", "+/src/answer.java", "+/src/answer\0evil"
            })
                Reject(() => ProjectRootSourceResolver.Resolve(app, bad), bad);
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/" + new string('x', 4096)),
                   "oversized rooted import");

            // Symlinks and Windows reparse points are not silently admitted.
            var outsider = Path.Combine(root, "external.ores");
            File.WriteAllText(outsider, "pub fnc external():int{return 1;}\n");
            var alias = Path.Combine(app, "src", "external.ores");
            try
            {
                File.CreateSymbolicLink(alias, outsider);
                Reject(() => ProjectRootSourceResolver.Resolve(app, "+/src/external"),
                       "foreign source symlink");
            }
            catch (UnauthorizedAccessException) { /* Windows without symlink privilege */ }
            catch (PlatformNotSupportedException) { /* symlink-unavailable host */ }
            catch (IOException) { /* filesystem does not permit symlink creation */ }
            // A sibling file cannot be smuggled via a rooted source prefix.
            var sibling = Path.Combine(root, "other", "answer.ores");
            Directory.CreateDirectory(Path.GetDirectoryName(sibling)!);
            File.WriteAllText(sibling, "pub fnc answer():int{return 0;}\n");
            Reject(() => ProjectRootSourceResolver.Resolve(app, "+/../other/answer"),
                   "sibling package crossing");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
