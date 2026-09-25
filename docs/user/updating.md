# Updating T3 Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A restart also stops agents' monitors and background agents. With this setting
on, each affected agent is told what stopped and restarts what it still needs;
anything they would have reported during the restart is missed.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Linux fork server updates

The Linux headless updater waits while threads have active or queued work,
including approval and input requests. A deferred update retries after work ends;
you do not need to close completed thread conversations. The app’s remote update
request uses this same idle check.

To deliberately interrupt active work, run this command on the Linux host:

```sh
~/.local/bin/t3code-headless-upgrade --force
```

Normal scheduled checks never use that override. To inspect readiness without
installing anything, use `~/.local/bin/t3code-headless-upgrade --check-idle`.

## Restart the desktop app when agents finish

When a desktop update is downloaded and agents on this computer are working,
the restart button offers **Restart when agents finish**. T3 Code then waits
until no local agent is working, monitoring, or holding queued messages, stays
idle for 15 seconds, and restarts to install the update. With **Continue threads
after restarts** on, it does not wait for agents that are only monitoring,
since they resume after the restart. Hover the button to see
how many agents it is waiting for; click it again to cancel.

Unlike the Linux server updater, this does not wait for agents paused on an
approval or a question: those prompts end with the restart, and you can reply
in the thread afterwards. Agents on other machines keep running and never delay
the restart.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                              |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server with `npx` rather than an installed `t3`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
