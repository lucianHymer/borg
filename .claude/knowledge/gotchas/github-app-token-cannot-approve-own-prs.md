# GitHub App token cannot approve its own PRs

When using `gh pr review --approve`, the GitHub App installation token used by Borg's credential broker cannot approve PRs that were created by the same token. GitHub returns an error. Use `gh pr review --comment` as a workaround — the Reviewer leaves a comment instead of a formal approval.

This affects the dev-team workflow: the Reviewer role can't use `--approve` if the Worker opened the PR with the same GitHub App credentials. Future reviewers should expect this and skip the approval step.

**Related files:** .claude/skills/workflows/dev-team.md
