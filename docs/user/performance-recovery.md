# Performance protection and recovery

The macOS desktop app includes an opt-out pressure monitor. It samples host and
per-process CPU every five seconds without launching `ps`, `top`, or a growing
`log stream`. After three consecutive critical samples, it records one bounded
incident snapshot and shows a notification. Notifications are limited to one
per ten minutes.

Open **Settings → Diagnostics → Performance Protection** to enable or disable
the monitor. Clicking **Review Recovery** in a notification opens the same
Diagnostics panel.

## Recovery is always reviewed

T3 Code never kills a process merely because pressure was detected. The
Diagnostics panel asks the server for a fresh preview grouped into:

- idle provider sessions with no active turn
- orphaned provider processes whose parent has exited
- stale diagnostic captures such as `storm-capture.py`, `spindump`, `sample`,
  or `log stream`

Recommended candidates are preselected, but nothing changes until you confirm
and click **Attempt selected recovery**. Execution revalidates each candidate
against the preview. Provider sessions are claimed atomically so a newly
started turn cannot be stopped by an old preview; process candidates must still
have the same PID, parent PID, and command and receive `SIGINT` only.

Active turns are never recovery candidates. T3 Code also never restarts
`syspolicyd`, `trustd`, or another macOS system service, and it never reboots
the computer.

The pressure monitor stores its latest bounded snapshot in the app data
directory as `system-pressure.json`. It does not create a separate rolling log.
