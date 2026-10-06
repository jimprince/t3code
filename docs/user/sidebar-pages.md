# Sidebar pages

Pin web pages you check often, such as a status board or task tracker, as icons in the sidebar
footer next to Settings and Usage. Clicking one opens the page in the main area.

## Add a page

Open **Settings → General → Sidebar pages**, choose **Add page**, then pick an icon and enter a
name and a full `http://` or `https://` URL. Use the arrows to reorder pages and the trash icon to
remove one. The list is saved to every connected environment, so your other devices show the
same pages.

## When a page will not show inline

- **Desktop app:** pages open in the same browser session as the Browser panel, so a site you
  signed in to there stays signed in, and plain `http://` pages work.
- **Web:** a browser will not show an `http://` page inside T3 Code opened over `https://`; the
  page offers **Open in browser** instead. A site whose login only works as a first-party page may
  not stay signed in inside the frame, and a site that does not allow embedding from your T3 Code
  address shows a blank page. Use **Open in browser** for those.
- **Mobile:** pages are listed under **Settings → App** and open in the in-app browser.

## Page agent

Choose **Agent** in a page's header to open a chat beside it. Each page has its own agent. In the
desktop app it can operate the page you see (open tabs, read what is shown, fill in fields), and
on any surface it can check on or message your threads. On the web the page cannot be operated
from the chat, so the agent only works with your threads. The agent stops whenever you close the
chat or leave the page.

Coming back after 30 minutes starts a fresh conversation; **Resume previous conversation** brings
the last one back. Only the current and previous conversations are kept: starting a new one
permanently deletes the one before the previous, and **Delete conversation** is permanent. A
conversation is never deleted while the agent is working. Conversations are kept per device, and
the agent uses GPT-6.1 Sol on the fast tier when a Codex provider offers it; pick another model
in the chat.
