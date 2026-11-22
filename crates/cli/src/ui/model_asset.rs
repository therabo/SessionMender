use std::path::PathBuf;

use agentmender_provider_api::filesystem::read_bounded;
use axum::body::Bytes;

const MAX_MODEL_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct LocalModels {
    clawd: Option<Bytes>,
    codex: Option<Bytes>,
}

impl LocalModels {
    pub(super) fn load() -> Self {
        Self {
            clawd: load("SESSIONMENDER_CLAWD_GLB"),
            codex: load("SESSIONMENDER_CODEX_GLB"),
        }
    }

    pub(super) fn get(&self, name: &str) -> Option<&Bytes> {
        match name {
            "Clawd-Animator.glb" => self.clawd.as_ref(),
            "codex.glb" => self.codex.as_ref(),
            _ => None,
        }
    }
}

fn load(variable: &str) -> Option<Bytes> {
    let path = PathBuf::from(std::env::var_os(variable)?);
    let bytes = read_bounded(path.parent()?, &path, MAX_MODEL_BYTES).ok()?;
    validate(bytes)
}

fn validate(bytes: Vec<u8>) -> Option<Bytes> {
    let size = u32::try_from(bytes.len()).ok()?;
    (bytes.starts_with(b"glTF\x02\0\0\0")
        && bytes.get(8..12) == Some(&size.to_le_bytes())
        && bytes.get(16..20) == Some(b"JSON"))
    .then(|| Bytes::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_glb_versions_of_different_sizes_with_consistent_headers() {
        let glb = b"glTF\x02\0\0\0\x18\0\0\0\x04\0\0\0JSON{}  ";
        let larger_glb = b"glTF\x02\0\0\0\x1c\0\0\0\x08\0\0\0JSON{\"a\":1} ";
        assert_eq!(validate(glb.to_vec()).as_deref(), Some(glb.as_slice()));
        assert_eq!(
            validate(larger_glb.to_vec()).as_deref(),
            Some(larger_glb.as_slice())
        );

        let mut wrong_length = glb.to_vec();
        wrong_length[8] = 0x1c;
        assert!(validate(wrong_length).is_none());

        let mut wrong_version = glb.to_vec();
        wrong_version[4] = 1;
        assert!(validate(wrong_version).is_none());
    }
}
