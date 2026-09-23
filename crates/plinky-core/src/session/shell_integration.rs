use serde::{Deserialize, Serialize};

pub const BASH_BOOTSTRAP: &str = r#"# Plinky Shell Integration for Bash (OSC 133 + OSC 7)
if [ -z "$PLINKY_SHELL_INTEGRATION" ]; then
    export PLINKY_SHELL_INTEGRATION=1
    __plinky_prompt_start() {
        local ret=$?
        printf '\033]133;D;%d\007' "$ret"
        printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"
        printf '\033]133;A\007'
    }
    __plinky_preexec() {
        printf '\033]133;C\007'
    }
    if [ -n "$PROMPT_COMMAND" ]; then
        PROMPT_COMMAND="__plinky_prompt_start; $PROMPT_COMMAND"
    else
        PROMPT_COMMAND="__plinky_prompt_start"
    fi
    trap '__plinky_preexec' DEBUG
fi
"#;

pub const ZSH_BOOTSTRAP: &str = r#"# Plinky Shell Integration for Zsh (OSC 133 + OSC 7)
if [[ -z "$PLINKY_SHELL_INTEGRATION" ]]; then
    export PLINKY_SHELL_INTEGRATION=1
    autoload -Uz add-zsh-hook
    __plinky_precmd() {
        local ret=$?
        print -Pn "\e]133;D;%?\a"
        print -Pn "\e]7;file://%m$PWD\a"
        print -Pn "\e]133;A\a"
    }
    __plinky_preexec() {
        print -Pn "\e]133;C\a"
    }
    add-zsh-hook precmd __plinky_precmd
    add-zsh-hook preexec __plinky_preexec
fi
"#;

pub const FISH_BOOTSTRAP: &str = r#"# Plinky Shell Integration for Fish (OSC 133 + OSC 7)
if not set -q PLINKY_SHELL_INTEGRATION
    set -g PLINKY_SHELL_INTEGRATION 1
    function __plinky_precmd --on-event fish_prompt
        set -l ret $status
        printf '\e]133;D;%d\a' $ret
        printf '\e]7;file://%s%s\a' (hostname) $PWD
        printf '\e]133;A\a'
    end
    function __plinky_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end
end
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType {
    Bash,
    Zsh,
    Fish,
}

impl ShellType {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "bash" => Some(ShellType::Bash),
            "zsh" => Some(ShellType::Zsh),
            "fish" => Some(ShellType::Fish),
            _ => None,
        }
    }

    pub fn script(&self) -> &'static str {
        match self {
            ShellType::Bash => BASH_BOOTSTRAP,
            ShellType::Zsh => ZSH_BOOTSTRAP,
            ShellType::Fish => FISH_BOOTSTRAP,
        }
    }
}

pub fn get_bootstrap_script(shell: ShellType) -> &'static str {
    shell.script()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_type_parsing() {
        assert_eq!(ShellType::parse("bash"), Some(ShellType::Bash));
        assert_eq!(ShellType::parse("Bash"), Some(ShellType::Bash));
        assert_eq!(ShellType::parse("zsh"), Some(ShellType::Zsh));
        assert_eq!(ShellType::parse("FISH"), Some(ShellType::Fish));
        assert_eq!(ShellType::parse("powershell"), None);
    }

    #[test]
    fn test_bash_script_has_osc133_and_osc7() {
        let script = get_bootstrap_script(ShellType::Bash);
        assert!(script.contains("133;A"));
        assert!(script.contains("133;C"));
        assert!(script.contains("133;D;%d"));
        assert!(script.contains("]7;file://"));
        assert!(script.contains("PLINKY_SHELL_INTEGRATION"));
    }

    #[test]
    fn test_zsh_script_has_osc133_and_osc7() {
        let script = get_bootstrap_script(ShellType::Zsh);
        assert!(script.contains("133;A"));
        assert!(script.contains("133;C"));
        assert!(script.contains("133;D"));
        assert!(script.contains("]7;file://"));
        assert!(script.contains("add-zsh-hook"));
    }

    #[test]
    fn test_fish_script_has_osc133_and_osc7() {
        let script = get_bootstrap_script(ShellType::Fish);
        assert!(script.contains("133;A"));
        assert!(script.contains("133;C"));
        assert!(script.contains("133;D"));
        assert!(script.contains("]7;file://"));
        assert!(script.contains("fish_prompt"));
    }
}
