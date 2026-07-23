---
status: accepted
---

# Keep the status service independent of presentation surfaces

The local status service is one background process shared by every presentation
surface. It does not start at login. Opening the future Tauri desktop surface
starts it when necessary, but quitting Tauri leaves it running so the Stream
Deck remains functional. An explicit Stop control in Tauri ends the service,
and it remains stopped until Tauri is opened again. While active, the operating
system restarts it after abnormal exits for the remainder of the login session;
logout or reboot returns it to the stopped state.

The operating system, rather than Tauri or the Stream Deck plugin, owns and
supervises the running process. This preserves one authoritative state owner,
allows the service to survive the lifetime of either consumer, and keeps
process management out of the Elgato plugin. A Tauri-owned child process was
rejected because quitting Tauri would disconnect Stream Deck; a Stream
Deck-owned process was rejected because plugin availability should not govern
the desktop surface.
