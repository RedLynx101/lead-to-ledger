# Model server failures during scoring

The local model server failed more than once on the machine these runs used. These are in the record because they changed results and because they may recur for anyone running this. The machine has an 8 GB GPU and was short on memory, with another project sharing the same server for part of the day. Times are UTC, on 2026-11-01.

| Time | What happened | Effect |
|---|---|---|
| 16:27:10, 16:34:38, 16:39:52 | The model process crashed with `Error: Channel Error` while two projects were sending requests. The other project's OCR processes faulted within seconds of the first two. | Calls in the first held-out run failed. |
| 16:41:52 | The server process disappeared. | 39 of 137 model calls in the first held-out run never got an answer. That run scored 70.0%, and it stays in `test-final`. |
| 18:19:20 | The server process disappeared during a model download request, with no error in Windows' Application log. | No scoring run was in progress. |

The cause isn't established. Memory pressure fits the crashes during the first held-out run, but that's not proven, and it doesn't explain the failure during the download.

What changed because of this: `scripts/score.ts` now waits and retries when the server fails, and stops if it stays down, so an outage can't be scored as model error. Each run records how many retries it needed. The triage service sends one model call at a time.
