/**
 * What Buddy says when /vibe is not set up in Claude Code.
 *
 * Buddy writes no agent configuration (src-tauri/src/mcp_setup.rs is
 * read-only). The one real install is the terminal package's own:
 * `npx slashvibe-mcp setup` — it adds /vibe to Claude Code, opens GitHub to
 * sign in, and installs the hooks that bring a message to you while you work.
 * Bare `npx slashvibe-mcp` only starts the server; there is no `vibe init`.
 */

export const SETUP_COMMAND = 'npx slashvibe-mcp setup';

export interface SetupStatus {
  installed: boolean;
  /** The `vibe` MCP server is in Claude Code's config. Absent on older answers. */
  server?: boolean;
  /** The arrival hook is in Claude Code's settings. Absent on older answers. */
  hooks?: boolean;
  npx_available: boolean;
}

/** The banner line, or null when there is nothing to say. Pure. */
export function setupLine(status: SetupStatus | null): { text: string; needsNode: boolean } | null {
  if (!status || status.installed) return null;
  if (!status.npx_available) {
    return { text: `/vibe in Claude Code needs Node.js — install it, then run ${SETUP_COMMAND}`, needsNode: true };
  }
  if (status.server && status.hooks === false) {
    return {
      text: `/vibe is in Claude Code without the hooks that bring messages to you while you work — run ${SETUP_COMMAND} in a terminal`,
      needsNode: false,
    };
  }
  return {
    text: `to use /vibe in Claude Code, run ${SETUP_COMMAND} in a terminal — it adds /vibe, signs you in with GitHub, and installs the hooks that bring messages to you while you work`,
    needsNode: false,
  };
}
