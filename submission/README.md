# Registry submission

The plugin is listed in the DSH in-app market (`dshmarket`) through
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
which serves `https://awesome-dsh-plugin.com/plugins.json` to the harness.

- **Entry file:** [`awesome-dsh-plugin.yml`](./awesome-dsh-plugin.yml)
- **Target path in the registry:** `data/plugins/Jisiyong-A__dsh-plugin-background-compaction.yml`
- **Pull request:** [#11197](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11197)
- **Install shape:** `tarball:` (prebuilt `.tgz` attached to the `v2.0.1` GitHub
  Release), because the package is not on npm yet.

## Rules that shaped this entry

| Rule | What we did |
| --- | --- |
| One file per plugin, at `data/plugins/<owner>__<repo>.yml` | Exactly one file, +7 lines |
| `category` must be from the fixed list | `session` — where every other compaction/context plugin sits |
| Description states function, no superlatives | Claims map 1:1 onto `src/engine/engine.ts` |
| `dsh.bundle` must be declared in `package.json` | `dsh.bundle.patch` → `./cordis.patch.yml` |
| Repo must carry the `dsh-plugin` topic | Set |
| `@deepseek-ai/*` must be `peerDependencies` | Both peers declared, optional, `>=0.2.1-rc.5 <0.3.0-0` |
| `tarball:` must be a pinned tag when it carries the version | `releases/download/v2.0.1/...`, not `latest/download/` |

## When npm publication happens

Publishing to npm is a pure upgrade for users (prebuilt, no `allowBuilds`
approval) and does not invalidate this entry. To switch the listing over, add an
`npm:` line for `dsh-plugin-background-compaction` in a follow-up pull request;
`tarball:` can stay as the fallback.

## Reproducing the pull request

```powershell
$env:HTTP_PROXY  = "http://127.0.0.1:7897"   # required on this machine
$env:HTTPS_PROXY = "http://127.0.0.1:7897"

# fork, then add the entry on a branch off upstream main
# POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks
# POST /repos/<fork>/git/refs                      {ref, sha}
# PUT  /repos/<fork>/contents/data/plugins/<owner>__<repo>.yml
# POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls
```

The registry CI (`check`) validates schema, locale parity, date derivation and
templates; it must report `success` before a maintainer review.
