/** What gets appended to ~/.bashrc / ~/.zshrc (shown in the confirmation; see rookery-core actions.rs). */
export const SHELL_INTEGRATION_PREVIEW = `# rook-shell-integration-v2 — lets Rookery follow your folder and notice finished commands
__rook_osc7() { local e=$?; printf '\\033]133;D;%s\\007\\033]7;file://%s%s\\033\\\\' "$e" "\${HOSTNAME:-$(hostname)}" "$PWD"; return $e; }
(zsh: added to precmd_functions · bash: added to PROMPT_COMMAND, once)`;
