use std::{env, fmt::Write, fs, path::PathBuf};

fn main() {
    let dist = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("../../ui/dist");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));
    // The directory watch also covers asset additions and removals. The launcher
    // supplies a content hash so Cargo can detect changes with preserved mtimes.
    println!("cargo:rerun-if-changed={}", dist.display());
    println!("cargo:rerun-if-env-changed=SESSIONMENDER_UI_FINGERPRINT");
    for asset in ["index.html", "app.js", "app.css"] {
        let path = dist.join(asset);
        let contents = fs::read_to_string(&path)
            .unwrap_or_else(|error| missing_asset(&path, &error.to_string()));
        if contents.is_empty() {
            missing_asset(&path, "file is empty");
        }
        fs::write(out.join(asset), contents).expect("write embedded UI asset");
    }

    let assets = dist.join("assets");
    let mut entries = match fs::read_dir(assets) {
        Ok(entries) => entries
            .map(|entry| entry.expect("read UI asset directory").path())
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("read UI assets: {error}"),
    };
    entries.sort_unstable();
    let mut lookup = String::from(
        "fn embedded_asset(name: &str) -> Option<(&'static str, &'static [u8])> {\n    match name {\n",
    );
    for path in entries {
        let content_type = match path.extension().and_then(|extension| extension.to_str()) {
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("woff2") => "font/woff2",
            Some("glb") if path.file_name().is_some_and(|name| name == "codex.glb") => {
                "model/gltf-binary"
            }
            Some("js") => "text/javascript; charset=utf-8",
            _ => continue,
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("UI asset name");
        writeln!(
            lookup,
            "        {name:?} => Some(({content_type:?}, include_bytes!({path:?}))),"
        )
        .expect("generate embedded asset lookup");
    }
    lookup.push_str("        _ => None,\n    }\n}\n");
    fs::write(out.join("embedded_assets.rs"), lookup).expect("write embedded asset lookup");
}

fn missing_asset(path: &std::path::Path, reason: &str) -> ! {
    panic!(
        "Required frontend asset {} is unavailable ({reason}). From the repository root, run `npm ci --prefix ui` and `npm run build --prefix ui`, then retry Cargo. Use `npm start` to build and launch in one step.",
        path.display()
    );
}
