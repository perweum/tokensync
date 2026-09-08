# Setting up a GitHub token for Token Sync

Token Sync needs a GitHub Personal Access Token (PAT) to read and write your
token repository and open Pull Requests. This walks through creating a
**fine-grained token** scoped to only that one repository, instead of a
classic token that can typically reach everything in your account.

## Why fine-grained, not classic

A classic PAT's `repo` scope grants read/write access to every repository you
can access — private and public, this one and every other. A fine-grained
token can be limited to exactly one repository and exactly the permissions
Token Sync actually uses. If it's ever exposed, the blast radius is one repo,
not your entire account.

## What Token Sync actually needs

Checked directly against the GitHub API calls the plugin makes
(`plugin/src/ui/hooks/useGitHub.ts`):

| Permission | Access | Why |
|---|---|---|
| **Contents** | Read and write | Reading token files, listing branches, creating a branch, reading/writing file contents for the PR |
| **Pull requests** | Read and write | Opening the Pull Request itself |
| **Metadata** | Read-only | Required baseline for every fine-grained token — GitHub adds this automatically |

Nothing else. Token Sync never touches Issues, Actions, Packages, Webhooks,
or any other permission category — don't grant them.

## Steps

1. Go to **github.com → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token**.
2. Give it a name that identifies what it's for (e.g. `token-sync-<your-repo-name>`).
3. Set an expiration. GitHub allows up to a year for fine-grained tokens (or
   no expiration, if your organization permits it) — shorter is safer;
   you'll just need to generate a new one and update the plugin when it
   expires.
4. Under **Repository access**, choose **Only select repositories** and pick
   the one repository holding your tokens. Do not choose "All repositories."
5. Under **Permissions → Repository permissions**, set:
   - **Contents**: Read and write
   - **Pull requests**: Read and write
   - Leave everything else at "No access."
6. Generate the token and copy it immediately — GitHub only shows it once.
7. Paste it into Token Sync's project setup (**GitHub Personal Access
   Token** field). It's stored locally via Figma's `clientStorage`, scoped to
   your Figma account — see `PRIVACY.md` for exactly how it's used.

## If your organization requires approval

Organizations can require an admin to approve fine-grained tokens before
they can access org-owned repositories. If the plugin's "Test connection"
step fails with an authorization error immediately after creating the token,
check whether it's pending approval under the organization's **Settings →
Personal access tokens** page.

## Rotating or revoking

Delete or regenerate the token from the same GitHub settings page at any
time — this immediately cuts the plugin's access. Update the project in
Token Sync with the new token, or remove the project if you no longer need
the connection.
