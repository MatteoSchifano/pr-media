# pr-media-cleanup

Composite GitHub Action that removes the artifacts left behind by
[`pr-media`](../) once a pull request is closed:

- the hidden git ref `refs/uploads/pr/<number>` (used by the `hidden-ref` upload strategy)
- the prerelease tagged `pr-<number>-media`, including its git tag (used by the `release` upload strategy)

Both deletions are best-effort: if an artifact doesn't exist (404), the step
logs it and continues rather than failing the job.

## Usage

```yaml
name: pr-media cleanup

on:
  pull_request:
    types: [closed]

permissions:
  contents: write

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/pr-media/action-cleanup@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Name           | Required | Default                | Description                                                        |
| -------------- | -------- | ----------------------- | -------------------------------------------------------------------- |
| `github-token` | no       | `${{ github.token }}`   | Token used to call the GitHub API. Needs `contents: write` scope.    |

## Notes

- Requires the `gh` CLI, which is preinstalled on GitHub-hosted runners.
- Only acts on `pull_request` / `pull_request_target` events where
  `github.event.action == 'closed'`; any other trigger is a no-op, so it's
  safe to reuse this action inside a broader workflow.
