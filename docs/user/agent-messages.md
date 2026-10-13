# Agent Messages

A message another agent or an automation sends to a thread appears as a left-aligned row with a rule beside it, not as one of your bubbles. It carries no "You" heading. When the sending thread is available in this environment, its title links to that thread. Other senders appear as text, using their saved name or "another agent"; their environment appears beside it.

The sender header the `t3-thread` CLI adds, with the thread id and the reply command, is hidden behind **Details**. Long messages stay clamped on web and desktop with **Show full message**.

Steer and interrupt sends keep your own look, because they act with your authority.

An agent can end a message with a `T3_NOTIFY: quiet` or `T3_NOTIFY: attention` line to steer notifications. That line is routing, not content, so it is not shown, previewed or copied; the stored message keeps it and notifications behave as before. A marker line you type yourself, or one inside a code block, stays visible.
