use std::path::PathBuf;

use agentmender_provider_api::filesystem::read_bounded;
use axum::body::Bytes;
use sha2::{Digest, Sha256};

const CLAWD_HASH: [u8; 32] = [
    0xe9, 0x13, 0x51, 0x2e, 0xb3, 0xf8, 0xfe, 0xed, 0x18, 0x67, 0x3e, 0xe3, 0x73, 0xe6, 0xae, 0x1b,
    0xf2, 0x4d, 0x4c, 0x55, 0x8f, 0x6a, 0xdd, 0x37, 0xa2, 0x9e, 0x64, 0x5b, 0x33, 0x11, 0x91, 0x56,
];
const CODEX_HASH: [u8; 32] = [
    0x79, 0xd1, 0x54, 0xb5, 0x38, 0x34, 0xef, 0xb7, 0xde, 0x54, 0x98, 0xa4, 0x61, 0xd7, 0x8c, 0xf4,
    0x80, 0x41, 0x8d, 0x00, 0x9d, 0xfc, 0xaa, 0xc6, 0xc7, 0x28, 0x66, 0x98, 0x48, 0x2d, 0xcf, 0x86,
];

pub(super) struct LocalModels {
    clawd: Option<Bytes>,
    codex: Option<Bytes>,
}

impl LocalModels {
    pub(super) fn load() -> Self {
        Self {
            clawd: load("SESSIONMENDER_CLAWD_GLB", 191_740, &CLAWD_HASH),
            codex: load("SESSIONMENDER_CODEX_GLB", 1_388_604, &CODEX_HASH),
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

fn load(variable: &str, size: u32, hash: &[u8; 32]) -> Option<Bytes> {
    let path = PathBuf::from(std::env::var_os(variable)?);
    let bytes = read_bounded(path.parent()?, &path, size as usize).ok()?;
    validate(bytes, size, hash)
}

fn validate(bytes: Vec<u8>, size: u32, hash: &[u8; 32]) -> Option<Bytes> {
    // The pinned digest verifies the inspected, self-contained payload after the GLB header.
    (bytes.len() == size as usize
        && bytes.starts_with(b"glTF\x02\0\0\0")
        && bytes.get(8..12) == Some(&size.to_le_bytes())
        && bytes.get(16..20) == Some(b"JSON")
        && Sha256::digest(&bytes).as_slice() == hash)
        .then(|| Bytes::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_matching_glb_header_size_and_digest() {
        let glb = b"glTF\x02\0\0\0\x18\0\0\0\x04\0\0\0JSON{}  ";
        let size = glb.len() as u32;
        let hash = Sha256::digest(glb).into();
        assert_eq!(
            validate(glb.to_vec(), size, &hash).as_deref(),
            Some(glb.as_slice())
        );
        assert!(validate(glb.to_vec(), size, &[0; 32]).is_none());
        assert!(validate(glb.to_vec(), size + 1, &hash).is_none());

        let mut wrong_version = glb.to_vec();
        wrong_version[4] = 1;
        let wrong_hash = Sha256::digest(&wrong_version).into();
        assert!(validate(wrong_version, size, &wrong_hash).is_none());
    }
}
