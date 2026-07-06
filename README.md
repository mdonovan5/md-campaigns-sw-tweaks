# MD Campaigns SW Tweaks

House rules and automation tweaks for the MD Campaigns SWADE/SWPF games (Foundry v14, SWADE 6, Better Rolls 2 stack).

## Install (The Forge)

Install from manifest URL (Bazaar toggle **OFF**):

```
https://github.com/mdonovan5/md-campaigns-sw-tweaks/releases/latest/download/module.json
```

## Release procedure

Every change, even a one-liner:

1. Bump `version` in `module.json` (e.g. `0.1.1`).
2. Commit and push.
3. Tag matching the version and push the tag:

   ```bash
   git tag v0.1.1
   git push origin main v0.1.1
   ```

The `release.yml` workflow verifies the tag matches `module.json`, stamps the tag-pinned `download` URL, builds `module.zip`, and publishes a GitHub Release. The `releases/latest/download/module.json` manifest URL always resolves to the newest release — no `archive/main.zip` cache lag.

On The Forge after a release: uninstall → reinstall from manifest URL, then fully close and reopen the tab.

## Verification snippet (F12 console)

```js
console.log('foundry', game.version, '| swade', game.system.version,
            '| mod', game.modules.get('md-campaigns-sw-tweaks')?.version);
```
