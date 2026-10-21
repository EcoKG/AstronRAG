Source-URL: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
Checked-At: 2026-10-21

| Model ID | Prompt tier | Input | Cache write 5m | Cache write 1h | Cache read | Output |
|---|---|---|---|---|---|---|
| claude-fable-5-1 | all | 10 | 12.5 | 20 | 0.25 | 50 |
| claude-opus-5-5 | all | 4 | 5 | 8 | 0.2 | 20 |
| claude-sonnet-5-5 | all | 2 | 2.5 | 4 | 0.1 | 10 |
| claude-haiku-5-5 | <=100000 | 0.1 | 0.125 | 0.2 | 0.01 | 0.5 |
| claude-haiku-5-5 | >100000 | 0.5 | 0.625 | 1 | 0.05 | 2.5 |
