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

## Process launch early warnings

Open **Settings → Diagnostics** to see the connected server’s launch health.
The server checks once a minute even when Diagnostics is closed. On macOS it
reads `syspolicyd` RSS and CPU through the existing native monitor, with no
sampling subprocesses. macOS may deny access to this system daemon’s metrics
from an unprivileged helper; Diagnostics shows them as unavailable in that
case, and launch-rate warnings still work.

Provisional defaults warn above 1 GiB RSS, more than 300 MiB growth within ten
minutes, or more than 600 T3 process-runner attempts per minute sustained for a
minute. Adjust these thresholds under **Performance Protection** in web or
desktop Settings. Mobile Diagnostics shows each connected server’s health.
Runner counts include attempted launches and spawn failures, including missing
executables; they exclude agent descendants and direct provider SDK spawns.

If warned, reduce active threads. If macOS launches still stall, run
`sudo killall syspolicyd` **once** in a terminal on the server Mac. Repeated kills can make launchd
throttle the daemon and freeze WindowServer. T3 never runs this command.
Minute samples and warnings are recorded in the existing server diagnostics
logs for later investigation; normal log rotation bounds retention.
