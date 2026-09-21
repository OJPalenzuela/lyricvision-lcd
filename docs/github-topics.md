# Recommended GitHub topics

Apply these in the repository **About** section (web UI), or with the
GitHub CLI. Do NOT run the command from automation — repository topic
changes are remote mutations and require the owner to run them.

Recommended topics (max 20 on GitHub; 11 used):

`spotify`, `lyrics`, `synced-lyrics`, `lcd`, `usb-lcd`, `thermalright`,
`vision-max`, `electron`, `python`, `windows`, `lrclib`

## Exact command (owner runs it)

```bash
gh repo edit <OWNER>/lyricvision-lcd --add-topic spotify --add-topic lyrics --add-topic synced-lyrics --add-topic lcd --add-topic usb-lcd --add-topic thermalright --add-topic vision-max --add-topic electron --add-topic python --add-topic windows --add-topic lrclib
```

Replace `<OWNER>` with the GitHub username or organization that owns the repo.

These topics mirror the `keywords` array in `package.json`.
