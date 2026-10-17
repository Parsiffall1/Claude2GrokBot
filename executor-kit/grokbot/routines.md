# Grok Bot routines for Claude2GrokBot

Grok Bot runs routines in the cloud and can start one when a webhook is called
([Grok Bot routines help](https://cursor.com/help/grok-bot/routines)). Claude2GrokBot uses that webhook to wake Grok Bot.

The required wake routine is created by the setup message that `scripts/setup.sh deploy` writes to
`~/.config/claude2grokbot/grok-setup.txt` (the single source of its instructions). Its webhook **POST to** URL and
**key**, shown in Grok Bot's desktop app → Routines → Claude2GrokBot wake, are stored with
`scripts/setup.sh set-wake '<URL>' '<KEY>'` (sent as `Authorization: Bearer <key>`; keep `WAKE_AUTH` = `bearer`).

## Optional: fallback poll routine

Picks up tasks if a wake request was lost. Every routine run uses Grok Bot usage, so keep it infrequent.

```text
Create a routine named "Claude2GrokBot poll" that runs every 4 hours.
Routine instructions:
"Run python3 ~/claude2grokbot/relay.py next. If it prints NO_TASK, end the run immediately without doing anything else.
Otherwise use the claude2grokbot skill to finish the queued tasks."
```

## Notes

- Webhook runs that fail with "Automation run rate limit exceeded" are not retried by Grok Bot. Claude2GrokBot retries
  with backoff (1 min, 5 min, 15 min, 1 h); after that, `wake_executor` (or the poll routine above) picks the task up.
- New webhook key: delete the routine's webhook trigger, add it again, and run `scripts/setup.sh set-wake` with the new values.
