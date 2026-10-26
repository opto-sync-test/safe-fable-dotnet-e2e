use std::env;
use std::fs;
use std::path::Path;
use std::process::{self, Command};

fn forbidden_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".py")
        || p.ends_with(".pyi")
        || p.ends_with(".ipynb")
        || p.ends_with("/requirements.txt")
        || p == "requirements.txt"
        || p.ends_with("/pipfile")
        || p == "pipfile"
        || p.ends_with("/poetry.lock")
        || p == "poetry.lock"
        || p.ends_with("/pyproject.toml")
        || p == "pyproject.toml"
        || p.ends_with("/uv.lock")
        || p == "uv.lock"
        || p.ends_with("/setup.py")
        || p == "setup.py"
}

fn forbidden_execution(line: &str) -> bool {
    let text = line.trim().to_ascii_lowercase();
    if text.starts_with('#') {
        return false;
    }
    [
        "actions/setup-python@",
        "python -m ",
        "python3 -m ",
        "python -c ",
        "python3 -c ",
        "python ",
        "python3 ",
        "pip install",
        "pip3 install",
        "pytest ",
        "poetry run ",
        "uv run ",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn main() {
    let root = env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let output = Command::new("git")
        .args(["-C", &root, "ls-files", "-z"])
        .output()
        .unwrap_or_else(|error| {
            eprintln!("cannot list tracked files: {error}");
            process::exit(2);
        });
    if !output.status.success() {
        eprintln!("git ls-files failed");
        process::exit(2);
    }

    let mut violations = 0usize;
    for bytes in output.stdout.split(|byte| *byte == 0).filter(|bytes| !bytes.is_empty()) {
        let path = String::from_utf8_lossy(bytes);
        if forbidden_path(&path) {
            eprintln!("{path}: Python file or dependency manifest is prohibited");
            violations += 1;
            continue;
        }

        let lowercase = path.to_ascii_lowercase();
        let executable_text = (lowercase.starts_with(".github/workflows/")
            && (lowercase.ends_with(".yml") || lowercase.ends_with(".yaml")))
            || lowercase.ends_with(".sh")
            || lowercase == "makefile"
            || lowercase.ends_with("/makefile");
        if !executable_text {
            continue;
        }

        let file = Path::new(&root).join(path.as_ref());
        let body = fs::read_to_string(&file).unwrap_or_default();
        for (index, line) in body.lines().enumerate() {
            if forbidden_execution(line) {
                eprintln!("{path}:{}: Python execution is prohibited", index + 1);
                violations += 1;
            }
        }
    }

    if violations != 0 {
        eprintln!("{violations} no-Python policy violation(s)");
        process::exit(1);
    }
    println!("no-Python policy: PASS");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_python_assets() {
        assert!(forbidden_path("scripts/x.py"));
        assert!(forbidden_path("tests/x.ipynb"));
        assert!(forbidden_path("pyproject.toml"));
        assert!(!forbidden_path("src/compiler.mjs"));
        assert!(!forbidden_path("tools/check.rs"));
    }

    #[test]
    fn detects_python_execution() {
        assert!(forbidden_execution("- run: python3 scripts/x.py"));
        assert!(forbidden_execution("- uses: actions/setup-python@v5"));
        assert!(forbidden_execution("pytest -q"));
        assert!(!forbidden_execution("- run: cargo test"));
        assert!(!forbidden_execution("- run: npm test"));
    }
}
