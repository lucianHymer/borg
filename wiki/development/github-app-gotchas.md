# GitHub App Gotchas

## App Token Cannot Approve Its Own PRs

When using `gh pr review --approve`, the GitHub App installation token cannot approve PRs created by the same token. GitHub returns an error.

**Workaround:** Use `gh pr review --comment` instead. The Reviewer leaves a comment rather than a formal approval.

Affects the dev-team workflow: Reviewer role can't use `--approve` if the Worker opened the PR with the same GitHub App credentials.

See: `.claude/skills/workflows/dev-team.md`
