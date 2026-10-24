# Cosmos conversation dashboard

An Operate interface for profile intake. Preserve the warm cream background, green actions, restrained serif headings, native sans-serif controls, visible labels and keyboard focus.

Connections sit above a two-column workspace: clickable saved/Gmail conversations and spreadsheet settings on the left; selected thread, recipient reply count, outgoing count out of five, full history, preview and profile details on the right. Search filters the loaded list. On mobile the sidebar stacks above the thread. Earlier messages use expandable native details elements.

A new conversation uses Generate intro / Send intro. Existing threads use Generate reply / Send reply, including proactive continuations explicitly requested by the operator. New sessions default to review mode. Automatic replies are an explicit per-thread option. The dashboard contains no freeform composer or random schedule controls.

Message text is rendered with textContent. Status, error, loading, unavailable-connection and disabled-action states are implemented. User data and external images are not rendered as HTML. No remote fonts/scripts/assets are loaded.

Source review and mechanical checks support functional assessment. Rendered desktop/mobile, computed contrast and keyboard verification remain pending while browser execution is unavailable.
