# Tumblr for Flare

A [Flare](https://github.com/flaresocialapp/Flare) plugin for Tumblr, using the official
Tumblr API v2 with your own Tumblr app.

## Features

| Feature | Notes |
| --- | --- |
| Timelines | Dashboard (default), Likes |
| Posts | Full Neue Post Format rendering: formatting, headings, lists, quotes, images with alt text, GIFs, video, audio, links, polls (read-only), asks, tags |
| Reblog trails | Shown as a thread above the post, like the Tumblr dashboard. Plain reblogs show "*blog* reblogged" over the original. |
| Actions | Like/unlike, reblog, delete posts on your own blogs |
| Replies | The thread view shows replies and reblogs-with-comment from the post's notes. Replying from Flare reblogs the post with your comment, since Tumblr has no public reply API. |
| Profiles | Blog pages with posts, follow/unfollow |
| Notifications | Likes, replies, reblogs, follows, mentions, asks; All / Mentions / Comments / Likes filters |
| Compose | Text (blank lines start new paragraphs), images with alt text, video. A last line of only `#tags` becomes the post's tags. Posts go to your primary blog. |

Tumblr doesn't say when each reblog-trail entry was written, so trail entries show the
reblog's time.

## Finding Tumblr when adding an account

Tumblr won't appear in the suggested server boxes on Flare's add-account screen, and
typing part of the name (like `tum`) won't find it. Flare only shows its
built-in platforms there; plugins can't add suggestions. Type the full address
**`api.tumblr.com`** in the server box and Tumblr will appear.

## Sign in

Flare's in-app OAuth uses a different callback address for every sign-in, and Tumblr
only accepts pre-registered callbacks, so you authorize your own app once:

1. Register an app at <https://www.tumblr.com/oauth/apps>. Any website and description
   is fine. Set the **OAuth2 redirect URLs** field to `http://localhost:8765/callback`.
2. Run `python3 tools/get_refresh_token.py`, enter the app's OAuth consumer key and
   secret, and approve the app in the browser window that opens.
3. In Flare, add an account and type `api.tumblr.com` as the server (the full address;
   Flare doesn't suggest plugin platforms from partial text). Tumblr appears; pick **Import Tumblr app tokens**, and paste the consumer key, consumer
   secret and refresh token.

Access tokens last about 40 minutes; the plugin renews them automatically and saves
the new refresh token Tumblr issues each time.

## Install

In Flare, open **Settings → Plugins → Add → Install from GitHub**, enter
`https://github.com/Blazeape595692/flare-plugin-tumblr`, review the permissions and confirm.
Flare checks this repository for new tagged versions.
