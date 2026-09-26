pub mod errors;
pub mod hostkeys;
pub mod ppk;
pub mod registry;
pub mod sessions;

pub use errors::{PuttyCompatError, Result};
pub use hostkeys::{list_host_keys, list_host_keys_from, HostKeyEntry};
pub use ppk::{looks_like_ppk, read_header, PpkHeader};
pub use sessions::{
    delete_session, delete_session_in, escape_session_name, list_sessions, list_sessions_in,
    parse_session_file, read_session, read_session_in, session_dir, set_session_folders,
    set_session_folders_with, unescape_session_name, write_session, write_session_in,
    PuttySession, SessionRef, FOLDER_KEY,
};
