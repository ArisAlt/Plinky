use serde::{Deserialize, Serialize};

/// Represents a parsed file entry from psftp's `ls -l` / `dir` output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub permissions: String,
    pub owner: String,
    pub group: String,
    pub modified: String,
}

/// Parses a single line of `psftp` directory listing.
/// 
/// Format example:
/// `-rw-r--r--   1 user     group        1250 Sep 22 19:40 package.json`
/// `drwxr-xr-x   2 user     group        4096 Sep 22 20:10 build`
/// `-rw-r--r--   1 user     group      342000 Sep 22 20:14 my long file with spaces.txt`
/// `lrwxrwxrwx   1 user     group          11 Sep 22 20:15 link_target -> real_file`
pub fn parse_psftp_ls_line(line: &str) -> Option<SftpFileEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() 
        || trimmed.starts_with("Listing directory") 
        || trimmed.starts_with("psftp>")
        || trimmed.starts_with("Remote directory") 
    {
        return None;
    }

    let first_char = trimmed.chars().next()?;
    if !matches!(first_char, '-' | 'd' | 'l' | 'c' | 'b' | 'p' | 's') {
        return None;
    }

    // Find the 9th column (the filename start) using token boundary scanner
    let mut in_token = false;
    let mut token_count = 0;
    let mut filename_start = 0;

    for (idx, ch) in trimmed.char_indices() {
        if ch.is_whitespace() {
            in_token = false;
        } else if !in_token {
            in_token = true;
            token_count += 1;
            if token_count == 9 {
                filename_start = idx;
                break;
            }
        }
    }

    if token_count < 9 || filename_start == 0 {
        return None;
    }

    let prefix = &trimmed[..filename_start];
    let parts: Vec<&str> = prefix.split_whitespace().collect();
    if parts.len() < 8 {
        return None;
    }

    let perms = parts[0];
    if perms.len() < 10 {
        return None;
    }

    let is_dir = perms.starts_with('d');
    let is_symlink = perms.starts_with('l');
    let owner = parts[2].to_string();
    let group = parts[3].to_string();
    let size = parts[4].parse::<u64>().unwrap_or(0);
    let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);

    let mut name = trimmed[filename_start..].trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }

    // Security check: reject filenames containing control characters or newlines
    if name.chars().any(|c| c.is_control()) {
        return None;
    }

    // In case of symlinks, psftp may show `symlink -> target` or just `symlink`
    if is_symlink && name.contains(" -> ") {
        if let Some((link_name, _)) = name.split_once(" -> ") {
            name = link_name.trim();
        }
    }

    Some(SftpFileEntry {
        name: name.to_string(),
        is_dir,
        is_symlink,
        size,
        permissions: perms.to_string(),
        owner,
        group,
        modified,
    })
}

/// Parses an entire multi-line output block from a `psftp` `ls -l` command.
pub fn parse_psftp_ls_output(output: &str) -> Vec<SftpFileEntry> {
    output.lines().filter_map(parse_psftp_ls_line).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_regular_file_and_directory() {
        let output = r#"
Listing directory /var/www
drwxr-xr-x   2 www-data www-data     4096 Sep 22 20:10 html
-rw-r--r--   1 www-data www-data     1250 Sep 22 19:40 index.html
-rw-r--r--   1 root     root       342000 Aug 15 2023 backup.sql
psftp>
"#;
        let files = parse_psftp_ls_output(output);
        assert_eq!(files.len(), 3);

        assert_eq!(files[0].name, "html");
        assert!(files[0].is_dir);
        assert!(!files[0].is_symlink);
        assert_eq!(files[0].size, 4096);
        assert_eq!(files[0].owner, "www-data");

        assert_eq!(files[1].name, "index.html");
        assert!(!files[1].is_dir);
        assert_eq!(files[1].size, 1250);

        assert_eq!(files[2].name, "backup.sql");
        assert_eq!(files[2].modified, "Aug 15 2023");
    }

    #[test]
    fn test_parse_filenames_with_spaces_and_symlinks() {
        let output = r#"
-rw-r--r--   1 user group 5242880 Sep 22 20:14 My Document With Spaces.pdf
lrwxrwxrwx   1 user group      15 Sep 22 20:15 current_link -> /var/www/html
drwxr-xr-x   3 user group    4096 Sep 22 20:16 Project Alpha (Staging)
"#;
        let files = parse_psftp_ls_output(output);
        assert_eq!(files.len(), 3);

        assert_eq!(files[0].name, "My Document With Spaces.pdf");
        assert_eq!(files[0].size, 5242880);

        assert_eq!(files[1].name, "current_link");
        assert!(files[1].is_symlink);

        assert_eq!(files[2].name, "Project Alpha (Staging)");
        assert!(files[2].is_dir);
    }

    #[test]
    fn test_filter_dot_and_dotdot() {
        let output = r#"
drwxr-xr-x   2 user group 4096 Sep 22 20:00 .
drwxr-xr-x   4 user group 4096 Sep 22 19:00 ..
-rw-r--r--   1 user group  100 Sep 22 20:01 real_file.txt
"#;
        let files = parse_psftp_ls_output(output);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "real_file.txt");
    }

    #[test]
    fn test_reject_filenames_with_control_characters() {
        let output = "-rw-r--r--   1 user group  100 Sep 22 20:01 hostile\x07file.txt\n";
        let files = parse_psftp_ls_output(output);
        assert_eq!(files.len(), 0);
    }
}
