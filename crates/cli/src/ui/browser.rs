//! Open only the server-generated loopback URL with the system browser.
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    process::{Command, Stdio},
};

pub(super) fn open(
    addr: SocketAddr,
    ticket: &str,
    executable: Option<&Path>,
) -> std::io::Result<()> {
    if addr.ip() != Ipv4Addr::LOCALHOST
        || ticket.len() != 64
        || !ticket.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(std::io::Error::other("invalid browser launch address"));
    }
    let url = format!("http://{addr}/#ticket={ticket}");
    let mut child = executable
        .map_or_else(system_browser, Command::new)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn system_browser() -> Command {
    #[cfg(target_os = "macos")]
    return Command::new("/usr/bin/open");
    #[cfg(all(unix, not(target_os = "macos")))]
    return Command::new("xdg-open");
    #[cfg(windows)]
    {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    }
}
