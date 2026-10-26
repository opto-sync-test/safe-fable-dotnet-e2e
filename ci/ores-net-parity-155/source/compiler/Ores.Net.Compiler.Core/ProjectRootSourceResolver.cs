using System.Text;

namespace Ores.Net.Compiler;

/// <summary>
/// Bounded package-root resolution substrate. The bootstrap parser still rejects
/// imports: this does not implement graph identity, CIL linking, or parity.
/// </summary>
public static class ProjectRootSourceResolver
{
    public static string Resolve(string packageDirectory, string specifier)
    {
        ArgumentNullException.ThrowIfNull(packageDirectory);
        ArgumentNullException.ThrowIfNull(specifier);
        if (!specifier.StartsWith("+/", StringComparison.Ordinal))
            throw new FormatException("expected canonical +/ source import");
        if (Encoding.UTF8.GetByteCount(specifier) > 4096)
            throw new FormatException("rooted import length exceeds 4096 bytes");
        var suffix = specifier.AsSpan(2);
        if (suffix.IsEmpty)
            throw new FormatException("empty project-root import");
        foreach (var c in suffix)
            if (char.IsControl(c) || c == '\\' || c == ':')
                throw new FormatException("invalid root import separator or control byte");
        var segments = specifier[2..].Split('/');
        foreach (var part in segments)
            if (part.Length == 0 || part is "." or "..")
                throw new FormatException("noncanonical project-root import component");

        var root = Path.GetFullPath(packageDirectory);
        CheckNotReparsePoint(root);
        var manifest = Path.Combine(root, ".ores.pkg.toml");
        if (!File.Exists(manifest))
            throw new FormatException("verified project manifest required");
        CheckNotReparsePoint(manifest);
        var rootSetting = RequireV1Manifest(manifest);
        string selectedRoot = root;
        if (rootSetting != ".")
        {
            foreach (var component in rootSetting.Split('/'))
            {
                selectedRoot = Path.Combine(selectedRoot, component);
                if (!Directory.Exists(selectedRoot))
                    throw new FormatException("project.root directory not found");
                CheckNotReparsePoint(selectedRoot);
                // Independently nested packages along an intermediate root
                // component must not inherit the parent package's +/ identity.
                foreach (var name in new[] { ".ores.pkg.toml", ".oreslangc.cfg.toml" })
                    if (MarkerExistsNoFollow(Path.Combine(selectedRoot, name)))
                        throw new FormatException("project.root crosses nested project manifest");
            }
        }
        selectedRoot = Path.GetFullPath(selectedRoot);
        var selectedRelative = Path.GetRelativePath(root, selectedRoot);
        if (selectedRelative is ".." ||
            selectedRelative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            Path.IsPathRooted(selectedRelative))
            throw new FormatException("project.root escapes physical package directory");

        // Reject every symlink/reparse component inside the chosen package.
        // This is deliberately stricter than the Java resolver until a
        // descriptor-relative, race-safe identity mechanism exists.
        var current = selectedRoot;
        foreach (var segment in segments)
        {
            current = Path.Combine(current, segment);
            if (File.Exists(current) || Directory.Exists(current))
                CheckNotReparsePoint(current);
        }
        var candidate = Path.GetFullPath(Path.Combine(selectedRoot, Path.Combine(segments)));
        var relative = Path.GetRelativePath(selectedRoot, candidate);
        if (relative is ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar,
                StringComparison.Ordinal) || Path.IsPathRooted(relative))
            throw new FormatException("project-root source escapes package");
        if (Path.GetExtension(candidate).Length == 0) candidate += ".ores";
        if (Path.GetExtension(candidate) != ".ores")
            throw new FormatException("non-Oreslang sources unsupported in .NET bootstrap");
        if (!File.Exists(candidate))
            throw new FormatException("project-root source not found");
        CheckNotReparsePoint(candidate);
        ValidateSourcePath(selectedRoot, candidate);
        return candidate;
    }

    // Host-only explicit ./ and ../ resolution. The caller must supply an
    // already-authorized package source root; no CWD or ambient search roots.
    // This does NOT link imported .NET functions into CIL.
    public static string ResolveRelative(string importer, string specifier, string sourceRoot)
    {
        ArgumentNullException.ThrowIfNull(importer);
        ArgumentNullException.ThrowIfNull(specifier);
        ArgumentNullException.ThrowIfNull(sourceRoot);
        if (!(specifier.StartsWith("./", StringComparison.Ordinal) ||
              specifier.StartsWith("../", StringComparison.Ordinal)) ||
            Encoding.UTF8.GetByteCount(specifier) > 4096)
            throw new FormatException("expected explicit ./ or ../ source import");
        if (specifier.Length == 0 || specifier.EndsWith("/", StringComparison.Ordinal) ||
            specifier.Contains("//", StringComparison.Ordinal) ||
            specifier.Any(c => char.IsControl(c) || c is '\\' or ':'))
            throw new FormatException("invalid relative source path");
        string root = Path.GetFullPath(sourceRoot);
        string owner = Path.GetFullPath(importer);
        if (!Directory.Exists(root) || !File.Exists(owner) ||
            Path.GetExtension(owner) != ".ores")
            throw new FormatException("relative importer must exist inside source root");
        CheckNotReparsePoint(root);
        ValidateSourcePath(root, owner);
        string candidate = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(owner)!, specifier));
        if (Path.GetExtension(candidate).Length == 0) candidate += ".ores";
        if (Path.GetExtension(candidate) != ".ores" || !File.Exists(candidate))
            throw new FormatException("relative source file not found or unsupported extension");
        if (string.Equals(owner, candidate, OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new FormatException("relative source cannot import itself");
        ValidateSourcePath(root, candidate);
        return candidate;
    }

    // Detect both modern and legacy nested-package markers, not just the
    // configured project's root. Deny symlink/reparse components in either
    // the importer or import target, including intermediate directories.
    private static void ValidateSourcePath(string root, string path)
    {
        string relative = Path.GetRelativePath(root, path);
        if (relative == ".." ||
            relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            Path.IsPathRooted(relative) || relative == ".")
            throw new FormatException("relative source escapes owning package");
        var components = relative.Split(Path.DirectorySeparatorChar);
        string current = root;
        for (int i = 0; i < components.Length; i++)
        {
            current = Path.Combine(current, components[i]);
            if (i < components.Length - 1)
            {
                foreach (var marker in new[] { ".ores.pkg.toml", ".oreslangc.cfg.toml" })
                {
                    string candidateMarker = Path.Combine(current, marker);
                    if (MarkerExistsNoFollow(candidateMarker))
                        throw new FormatException("source import crosses nested package boundary");
                }
            }
            if (File.Exists(current) || Directory.Exists(current))
                CheckNotReparsePoint(current);
        }
    }

    // Restricted bootstrap marker check, not a full TOML parser.
    // Read through one opened descriptor with a strict byte budget. This does
    // not make path lookup or reparse-point checks race-free.
    private static string RequireV1Manifest(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var bytes = new byte[65_537];
        int length = 0;
        while (length < bytes.Length)
        {
            int read = stream.Read(bytes, length, bytes.Length - length);
            if (read == 0) break;
            length += read;
        }
        if (length > 65_536)
            throw new FormatException("project manifest exceeds 64 KiB");
        string contents;
        try { contents = new UTF8Encoding(false, true).GetString(bytes, 0, length); }
        catch (DecoderFallbackException ex)
        {
            throw new FormatException("project manifest must be valid UTF-8", ex);
        }
        // TOML accepts LF or CRLF, not a standalone CR. In particular a
        // CR following a '#' comment must never hide a [project] table
        // or a second root declaration from this intentionally small parser.
        for (int i = 0; i < contents.Length; i++)
            if (contents[i] == '\r' &&
                (i + 1 == contents.Length || contents[i + 1] != '\n'))
                throw new FormatException("bare carriage return in project manifest");
        if (contents.Contains('\0') || contents.Contains("\"\"\"", StringComparison.Ordinal) ||
            contents.Contains("'''", StringComparison.Ordinal))
            throw new FormatException("unsupported project manifest literal");
        bool inRoot = true;
        bool inProject = false;
        bool sawProjectTable = false;
        bool sawProjectRoot = false;
        string projectRoot = ".";
        int versionCount = 0;
        foreach (var rawLine in contents.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r').TrimStart(' ', '\t');
            if (line.StartsWith("[", StringComparison.Ordinal))
            {
                inRoot = false;
                inProject = line == "[project]" ||
                    line.StartsWith("[project]#", StringComparison.Ordinal) ||
                    line.StartsWith("[project] #", StringComparison.Ordinal);
                if (!inProject && line.Contains("project", StringComparison.Ordinal))
                    throw new FormatException("unsupported project manifest table form");
                if (inProject && sawProjectTable)
                    throw new FormatException("duplicate [project] table");
                if (inProject) sawProjectTable = true;
                continue;
            }
            int equals = line.IndexOf('=');
            if (equals < 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            var key = line[..equals].TrimEnd(' ', '\t');
            var value = line[(equals + 1)..].Trim();
            if (inRoot && key is ("schema_version" or "\"schema_version\"" or "'schema_version'"))
            {
                if (!value.StartsWith("\"1\"", StringComparison.Ordinal) ||
                    (value.Length > 3 && !string.IsNullOrEmpty(value[3..].Trim()) &&
                     !value[3..].TrimStart().StartsWith("#", StringComparison.Ordinal)))
                    throw new FormatException("project manifest requires schema_version = 1");
                versionCount++;
            }
            if (inRoot && key == "project.root")
                throw new FormatException("unsupported dotted project.root declaration");
            if (inProject && key is ("root" or "\"root\"" or "'root'"))
            {
                if (sawProjectRoot) throw new FormatException("duplicate project.root");
                // Intentionally restricted to simple quoted forward-slash paths;
                // complex TOML strings require a real manifest parser.
                if (key != "root" || value.Length < 3 || value[0] != '"' ||
                    value.LastIndexOf('"') <= 1)
                    throw new FormatException("unsupported project.root value");
                int end = value.IndexOf('"', 1);
                var rest = value[(end + 1)..].Trim();
                if (rest.Length != 0 && !rest.StartsWith("#", StringComparison.Ordinal))
                    throw new FormatException("unsupported project.root trailing content");
                projectRoot = value[1..end];
                sawProjectRoot = true;
            }
        }
        if (versionCount != 1)
            throw new FormatException("project manifest requires exactly one schema_version = 1");
        if (projectRoot.Length > 1024 || projectRoot.Length == 0 ||
            Path.IsPathRooted(projectRoot) || projectRoot.Contains('\\') ||
            projectRoot.Contains(':') || projectRoot.Any(char.IsControl))
            throw new FormatException("invalid project.root");
        if (projectRoot != "." && projectRoot.Split('/')
            .Any(segment => segment.Length == 0 || segment is "." or ".."))
            throw new FormatException("project.root escapes manifest directory");
        return projectRoot;
    }

    // File.Exists and Directory.Exists both return false for some dangling
    // symlinks and inaccessible marker nodes. Nested package ownership is
    // decided by marker presence, not by successful target traversal.
    private static bool MarkerExistsNoFollow(string path)
    {
        try
        {
            _ = File.GetAttributes(path);
            return true;
        }
        catch (FileNotFoundException)
        {
            return false;
        }
        catch (DirectoryNotFoundException)
        {
            return false;
        }
        catch (IOException error)
        {
            throw new FormatException("cannot verify nested project manifest marker", error);
        }
        catch (UnauthorizedAccessException error)
        {
            throw new FormatException("cannot verify nested project manifest marker", error);
        }
    }

    private static void CheckNotReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new FormatException("project-root source symlink/reparse point denied");
    }
}
