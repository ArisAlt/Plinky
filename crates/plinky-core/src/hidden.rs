//! Child processes that must not open a console window.
//!
//! Thyrion is a windowed program, so on Windows every console program it
//! starts gets a console window of its own unless it is told not to: the
//! SFTP pane showed a blank `psftp` window for the length of every listing
//! and transfer, and PATH lookups and `plink -V` flashed one. Terminal tabs
//! are not affected; plink runs in a pseudo-console there. A no-op elsewhere.

/// CREATE_NO_WINDOW, from the Windows process-creation flags.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn std_command(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn tokio_command(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
