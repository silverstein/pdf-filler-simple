# PDF Tools folder-scope threat model

## Scope and decision

This model covers local PDF file access through the PDF Tools MCP server in
Claude Desktop, generic stdio hosts, and Agent Plugin hosts such as ChatGPT and
Codex. It covers direct tool reads and writes plus host-mediated import into the
private plugin workspace. It does not claim to constrain a desktop host running
with broader operating-system permission.

A fresh Agent Plugin install uses `${PLUGIN_DATA}/workspace`. Optional direct
folders replace that workspace through an operator-edited configuration. PDF
Tools never treats host access to another file as permission to open that source
path directly.

## Assets and trust boundaries

- User PDFs and output files, including sensitive document content.
- `${PLUGIN_DATA}/config.json`, which controls direct folder access.
- The private import workspace and saved PDF Tools state.
- The boundary between the desktop host and the PDF Tools MCP process.
- The boundary between tool output and the selected host/model provider.

The host is trusted to enforce the filesystem mode the user selected. PDF Tools
is trusted to enforce its own canonical path policy. Neither control substitutes
for the other. Content returned through MCP may leave the local process under
the host or model provider's data terms.

## Attacker capabilities and non-capabilities

Untrusted PDF content may influence model suggestions but cannot edit the
allowed-folder configuration through a PDF Tools tool. A caller may supply
paths, create files in an already allowed directory, and attempt symlink or path
alias attacks. A Full Access host may read an outside file and copy it into the
workspace; PDF Tools cannot and does not claim to prevent that host-authorized
operation. An unprivileged caller is not assumed able to alter the server code
or operating-system permissions.

## Abuse paths and mitigations

| Abuse path | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| PDF Tools directly opens a path outside its active scope | Medium | High | Canonical path checks on every file operation; default Agent Plugin scope is only the private workspace |
| A workspace symlink redirects access outside `PLUGIN_DATA` | Medium | High | Require a physical directory and a canonical path strictly below canonical `PLUGIN_DATA`; use mode 0700 on POSIX and the inherited plugin-data ACL on Windows; otherwise allow nothing |
| A tool rewrites its own folder policy | Low | High | Keep config outside the workspace; refuse any configured set that reaches its config; expose only a read-only scope-reporting tool |
| A Full Access host imports an outside file despite PDF Tools' scope | High when Full Access is selected | Medium to high | Describe this as host-authorized import, not a bypass of direct tool scope; make host permission and provider handling visible to users |
| A malformed or unresolved configuration broadens access | Medium | High | Fail closed; never fall back to implicit home folders or merge precedence layers |
| Sensitive content leaves through tool output | Medium | High | State that local file operations do not imply zero egress; host and provider data terms govern returned content |

## Security invariants and validation

- No implicit direct grant to the home directory, Documents, Downloads, or
  Desktop in Agent Plugin mode.
- The private workspace never includes its sibling config file.
- Explicit layers replace rather than union with lower-precedence layers.
- Malformed configuration and workspace path drift fail closed.
- Tests must cover outside-path denial, self-configuration denial, POSIX
  workspace mode, symlink escape, and honest `plugin_workspace` reporting.

## Residual risks

The application host and the PDF Tools process normally run as the same user.
This design is defense in depth and a clear tool contract, not process isolation
against a malicious or fully authorized host. Stronger source confidentiality
requires reducing the host's operating-system access, not adding another PDF
Tools allowlist entry.
