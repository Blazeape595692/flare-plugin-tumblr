// Tumblr adapter for Flare Social Plugin API v1.
//
// Uses the Tumblr API v2 (https://api.tumblr.com) with Neue Post Format (NPF).
// Flare's OAuth callback URL changes on every sign-in and Tumblr only accepts
// pre-registered redirect URLs, so the in-app OAuth flow can't be used. Instead you
// import your own app's consumer key/secret and an OAuth 2 refresh token (see
// tools/get_refresh_token.py). Access tokens (~40 min) are renewed automatically.
//
// Reblog trails are shown as Flare "inline parents" above the post, like the
// Tumblr dashboard. Tumblr does not report when each trail entry was written, so
// those entries carry the reblog's timestamp.

var API = "https://api.tumblr.com";

var TUMBLR_CAPABILITIES = {
  "flare.datasource.timeline/v1": ["page"],
  "flare.datasource.profile/v1": ["byId", "byHandle", "timeline"],
  "flare.datasource.post/v1": ["detail", "context", "delete", "mutate"],
  "flare.datasource.relation/v1": ["state", "mutate"],
  "flare.datasource.notification/v1": ["page"],
  "flare.datasource.compose/v1": ["publish"],
};

var NOTIFICATION_TYPES = {
  mention: ["mention_in_reply", "mention_in_post"],
  comment: ["reply", "reblog_with_content", "conversational_note"],
  like: ["like"],
};

defineFlareSocialPlugin({
  login: {
    token: {
      async begin(request, context) {
        var origin = requireTumblrOrigin(context.origin);
        var v = request.values || {};
        var cred = {
          clientId: need(v.consumerKey, "Enter your app's OAuth consumer key"),
          clientSecret: need(v.consumerSecret, "Enter your app's OAuth consumer secret"),
          refreshToken: need(v.refreshToken, "Enter a refresh token"),
        };
        var token = await requestToken(cred);
        cred.accessToken = token.accessToken;
        cred.expiresAt = token.expiresAt;
        if (token.refreshToken) cred.refreshToken = token.refreshToken;

        var info = await rawApi(cred.accessToken, "GET", "/v2/user/info", {}, false);
        var user = obj(info && info.user, "user");
        var blogs = asArray(user.blogs).filter(function (b) { return b && b.name; });
        var primary = blogs.filter(function (b) { return b.primary === true; })[0] || blogs[0];
        if (!primary) validationError("This Tumblr account has no blog");
        cred.primaryBlog = String(primary.name);
        cred.blogs = blogs.map(function (b) { return String(b.name); }).slice(0, 50);

        var profile = mapBlog(primary, origin);
        return {
          type: "success",
          value: {
            accountId: profile.key.id,
            origin: origin,
            credential: cred,
            profile: profile,
            capabilities: TUMBLR_CAPABILITIES,
          },
        };
      },
    },
  },

  capabilities: {
    timeline: {
      async page(request, context) {
        var env = await environment(context);
        if (request.timelineId === "dashboard") {
          return postPage(env, "/v2/user/dashboard", request.page, { npf: "true", reblog_info: "true" }, "posts");
        }
        if (request.timelineId === "likes") {
          return postPage(env, "/v2/user/likes", request.page, { npf: "true" }, "liked_posts");
        }
        unsupported("Unknown Tumblr timeline");
      },
    },

    profile: {
      async byId(request, context) {
        var env = await environment(context);
        return fetchBlog(env, request.key.id);
      },
      async byHandle(request, context) {
        var env = await environment(context);
        var name = String(request.handle || "").trim().replace(/^@/, "").replace(/\.tumblr\.com$/i, "").split("@")[0];
        return fetchBlog(env, need(name, "Blog name is missing"));
      },
      async timeline(request, context) {
        var env = await environment(context);
        var path = "/v2/blog/" + encodeURIComponent(blogName(request.profile.id)) + "/posts";
        return postPage(env, path, request.page, { npf: "true", reblog_info: "true" }, "posts");
      },
    },

    post: {
      async detail(request, context) {
        var env = await environment(context);
        var item = mapPostItem(await fetchRawPost(env, request.key.id), env);
        return item.presentation ? { post: item.post, presentation: item.presentation } : { post: item.post };
      },
      async context(request, context) {
        var env = await environment(context);
        var ref = splitKey(request.key.id);
        var raw = await fetchRawPost(env, request.key.id);
        var items = [mapPostItem(raw, env)];
        var notes = await api(env, "GET", "/v2/blog/" + encodeURIComponent(ref.blog) + "/notes", {
          query: { id: ref.id, mode: "conversation" },
        });
        // Tumblr returns notes newest first; show the conversation oldest first.
        asArray(notes && notes.notes).slice().reverse().forEach(function (note) {
          var mapped = mapNote(note, request.key, env);
          if (mapped && items.length < 200) items.push(mapped);
        });
        return { items: items, endReached: true };
      },
      async delete(request, context) {
        var env = await environment(context);
        var ref = splitKey(request.key.id);
        if (!env.ownBlogs[ref.blog]) validationError("You can only delete posts on your own blogs");
        await api(env, "POST", "/v2/blog/" + encodeURIComponent(ref.blog) + "/post/delete", { form: { id: ref.id } });
        return { type: "deleted" };
      },
      async mutate(request, context) {
        var env = await environment(context);
        var ref = splitKey(request.key.id);
        var token = parseActionToken(request.actionToken);
        if (!token) {
          var raw = await fetchRawPost(env, request.key.id);
          token = { reblogKey: String(raw.reblog_key || ""), uuid: String((raw.blog && raw.blog.uuid) || "") };
        }
        if (request.action === "Favourite" || request.action === "Unfavourite") {
          await api(env, "POST", request.action === "Favourite" ? "/v2/user/like" : "/v2/user/unlike", {
            form: { id: ref.id, reblog_key: need(token.reblogKey, "This post can't be liked") },
          });
        } else if (request.action === "Repost") {
          await createPost(env, [], [], {
            parent_tumblelog_uuid: need(token.uuid, "This post can't be reblogged"),
            parent_post_id: ref.id,
            reblog_key: need(token.reblogKey, "This post can't be reblogged"),
          });
        } else if (request.action === "Delete") {
          if (!env.ownBlogs[ref.blog]) validationError("You can only delete posts on your own blogs");
          await api(env, "POST", "/v2/blog/" + encodeURIComponent(ref.blog) + "/post/delete", { form: { id: ref.id } });
          return { type: "deleted" };
        } else {
          unsupported("Tumblr does not support this action");
        }
        var updated = mapPostItem(await fetchRawPost(env, request.key.id), env);
        return { type: "updatedPost", post: updated.post };
      },
    },

    relation: {
      async state(request, context) {
        var env = await environment(context);
        return relationFor(env, request.key);
      },
      async mutate(request, context) {
        var env = await environment(context);
        var name = blogName(request.key.id);
        if (request.action === "Follow" || request.action === "Unfollow") {
          await api(env, "POST", request.action === "Follow" ? "/v2/user/follow" : "/v2/user/unfollow", {
            form: { url: name + ".tumblr.com" },
          });
        } else {
          unsupported("Tumblr does not support this relationship action");
        }
        return { type: "updatedRelation", relation: await relationFor(env, request.key) };
      },
    },

    notification: {
      async page(request, context) {
        var env = await environment(context);
        var query = {};
        var types = NOTIFICATION_TYPES[request.filterId || "all"];
        if (types) query["types[]"] = types;
        applyCursor(query, request.page);
        var data = await api(env, "GET", "/v2/blog/" + encodeURIComponent(env.cred.primaryBlog) + "/notifications", {
          query: query,
        });
        var list = asArray(data && data.notifications);
        var items = list.map(function (n) { return mapNotification(n, env); }).filter(Boolean);
        var last = list[list.length - 1];
        var cursor = nextCursor(data, last && last.timestamp ? "b:" + Math.floor(Number(last.timestamp)) : null);
        return pageOf(items, list.length ? cursor : null);
      },
    },

    compose: {
      async publish(request, context) {
        var env = await environment(context);
        var blocks = textBlocks(request.text || "");
        var tags = blocks.tags;
        var content = blocks.content;
        var files = [];
        asArray(request.assets).forEach(function (asset, i) {
          var id = "media" + i;
          var mime = String(asset.mimeType || "image/jpeg");
          files.push({ type: "asset", name: id, handle: asset.handle, fileName: asset.fileName || id, contentType: mime });
          if (mime.indexOf("video/") === 0) {
            content.push({ type: "video", media: { type: mime, identifier: id } });
          } else {
            var block = { type: "image", media: [{ type: mime, identifier: id }] };
            if (asset.description) block.alt_text = String(asset.description);
            content.push(block);
          }
        });
        var reblog = null;
        if (request.replyTo) {
          // Tumblr has no public reply API; replying reblogs the post with your comment.
          var parent = await fetchRawPost(env, request.replyTo.id);
          reblog = {
            parent_tumblelog_uuid: need(parent.blog && parent.blog.uuid, "This post can't be reblogged"),
            parent_post_id: splitKey(request.replyTo.id).id,
            reblog_key: need(parent.reblog_key, "This post can't be reblogged"),
          };
        } else if (!content.length) {
          validationError("Write something or attach media");
        }
        var created = await createPost(env, content, files, reblog, tags);
        var id = String((created && (created.id_string || created.id)) || "");
        if (!id) invalidResponse("Tumblr did not return the new post");
        var item = mapPostItem(await fetchRawPost(env, env.cred.primaryBlog + "/" + id), env);
        return { post: item.post };
      },
    },
  },
});

// ------------------------------------------------------------- credential

function requireTumblrOrigin(origin) {
  if (origin !== "https://www.tumblr.com" && origin !== "https://tumblr.com") {
    validationError("Use https://www.tumblr.com as the server address");
  }
  return origin;
}

async function requestToken(cred) {
  var response = await send({
    method: "POST",
    url: API + "/v2/oauth2/token",
    body: {
      type: "form",
      values: {
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
      },
    },
  });
  if (response.status === 429) throw rateLimited(response);
  var data = parseJson(response.body, true);
  if (response.status === 400 || response.status === 401 || (data && data.error)) {
    fail("AuthenticationRequired", "Tumblr rejected the app credentials or refresh token");
  }
  if (response.status < 200 || response.status >= 300 || !data || !data.access_token) {
    fail("Remote", "Tumblr could not issue an access token");
  }
  var ttl = Number(data.expires_in);
  return {
    accessToken: String(data.access_token),
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
    expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 2400) * 1000,
  };
}

async function environment(context) {
  var cred = await flare.credential.read();
  if (!cred || typeof cred !== "object" || !cred.clientId || !cred.refreshToken || !cred.primaryBlog) {
    fail("AuthenticationRequired", "Import your Tumblr tokens again");
  }
  var own = {};
  asArray(cred.blogs).forEach(function (b) { own[String(b)] = true; });
  own[cred.primaryBlog] = true;
  return { cred: Object.assign({}, cred), host: originHost(context.origin), origin: context.origin, ownBlogs: own };
}

async function renew(env) {
  var token = await requestToken(env.cred);
  var next = Object.assign({}, env.cred, { accessToken: token.accessToken, expiresAt: token.expiresAt });
  if (token.refreshToken) next.refreshToken = token.refreshToken;
  // Tumblr rotates refresh tokens, so persist before using the new access token.
  await flare.credential.replace(next);
  env.cred = next;
}

// ------------------------------------------------------------------- HTTP

/** Calls the Tumblr API, renewing the access token when it is about to expire or is rejected. */
async function api(env, method, path, options) {
  if (!env.cred.accessToken || !env.cred.expiresAt || Number(env.cred.expiresAt) - 60000 < Date.now()) {
    await renew(env);
  }
  var result = await rawApi(env.cred.accessToken, method, path, options || {}, true);
  if (result === AUTH_FAILED) {
    await renew(env);
    result = await rawApi(env.cred.accessToken, method, path, options || {}, false);
  }
  return result;
}

var AUTH_FAILED = { authFailed: true };

async function rawApi(token, method, path, options, allowRetry) {
  var request = {
    method: method,
    url: addQuery(API + path, options.query || {}),
    authorization: { type: "bearer", token: token },
    headers: { Accept: "application/json" },
  };
  if (options.form) request.body = { type: "form", values: options.form };
  if (options.json) request.body = { type: "json", value: options.json };
  if (options.multipart) request.body = { type: "multipart", parts: options.multipart };
  if (options.timeoutMillis) request.timeoutMillis = options.timeoutMillis;
  var response = await send(request);
  if (response.status === 401) {
    if (allowRetry) return AUTH_FAILED;
    fail("AuthenticationRequired", "Tumblr rejected the access token; import your tokens again");
  }
  if (response.status === 404) fail("NotFound", "Not found on Tumblr");
  if (response.status === 429) throw rateLimited(response);
  var data = parseJson(response.body, response.status >= 400);
  if (response.status === 400 || response.status === 403) {
    validationError(errorMessage(data, "Tumblr rejected the request"));
  }
  if (response.status < 200 || response.status >= 300) fail("Remote", errorMessage(data, "Tumblr returned HTTP " + response.status));
  var inner = data && data.response;
  return inner && typeof inner === "object" ? inner : {};
}

async function send(request) {
  try {
    return await flare.http.request(request);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "host.unavailable") {
      fail("Network", "Could not reach Tumblr");
    }
    throw error;
  }
}

function rateLimited(response) {
  var value = Number(header(response.headers, "retry-after"));
  var error = { code: "RateLimited", message: { value: "Tumblr is rate limiting requests" } };
  if (Number.isFinite(value) && value >= 0) error.retryAfterSeconds = Math.min(604800, Math.ceil(value));
  return flare.error(error);
}

function errorMessage(data, fallback) {
  var err = data && asArray(data.errors)[0];
  var detail = err && (err.detail || err.title);
  if (typeof detail === "string" && detail) return detail.slice(0, 500);
  var msg = data && data.meta && data.meta.msg;
  return typeof msg === "string" && msg ? fallback + " (" + msg + ")" : fallback;
}

function parseJson(text, lenient) {
  var body = typeof text === "string" ? text.trim() : "";
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (_) {
    if (lenient) return null;
    invalidResponse("Tumblr did not return JSON");
  }
}

function header(headers, name) {
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name) {
      var v = headers[keys[i]];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ paging

async function postPage(env, path, page, params, field) {
  var query = Object.assign({}, params, { limit: String(clamp(page.limit, 1, 20)) });
  applyCursor(query, page);
  var data = await api(env, "GET", path, { query: query });
  var posts = asArray(data && data[field]);
  var items = posts.map(function (p) { return safeMapPostItem(p, env); }).filter(Boolean);
  if (!posts.length) return { items: items, endReached: true };
  var fallback;
  if (field === "liked_posts") {
    var lastLiked = posts[posts.length - 1];
    fallback = lastLiked && lastLiked.liked_timestamp ? "b:" + Math.floor(Number(lastLiked.liked_timestamp)) : null;
  } else {
    fallback = "o:" + (cursorOffset(page) + posts.length);
  }
  return pageOf(items, nextCursor(data, fallback));
}

/** Prefer Tumblr's own _links.next parameters; otherwise use the given offset/timestamp cursor. */
function nextCursor(data, fallback) {
  var params = data && data._links && data._links.next && data._links.next.query_params;
  if (params && typeof params === "object") {
    var encoded = "q:" + JSON.stringify(params);
    if (encoded.length <= 4000) return encoded;
  }
  return fallback;
}

function applyCursor(query, page) {
  var cursor = page.direction !== "refresh" ? page.cursor : null;
  if (!cursor) return;
  if (cursor.indexOf("q:") === 0) {
    var params = parseJson(cursor.slice(2), true) || {};
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") query[k] = String(v);
      else if (Array.isArray(v)) query[k] = v.map(String);
    });
  } else if (cursor.indexOf("b:") === 0) {
    query.before = cursor.slice(2);
  } else if (cursor.indexOf("o:") === 0) {
    query.offset = cursor.slice(2);
  }
}

function cursorOffset(page) {
  var c = page.direction !== "refresh" && page.cursor;
  return c && c.indexOf("o:") === 0 ? Number(c.slice(2)) || 0 : 0;
}

function pageOf(items, cursor) {
  if (cursor) return { items: items, olderCursor: cursor, endReached: false };
  return { items: items, endReached: true };
}

// ------------------------------------------------------------------ fetch

function splitKey(id) {
  var i = String(id).indexOf("/");
  if (i <= 0 || i === id.length - 1) notFound("Unknown Tumblr post");
  return { blog: id.slice(0, i), id: id.slice(i + 1) };
}

function blogName(id) {
  var name = String(id || "").trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name) && !/^t:[A-Za-z0-9_-]+$/.test(name)) notFound("Unknown Tumblr blog");
  return name;
}

async function fetchRawPost(env, key) {
  var ref = splitKey(key);
  var data = await api(env, "GET", "/v2/blog/" + encodeURIComponent(ref.blog) + "/posts", {
    query: { id: ref.id, npf: "true", reblog_info: "true" },
  });
  var post = asArray(data && data.posts)[0];
  if (!post) notFound("This post was not found on Tumblr");
  return post;
}

async function fetchBlog(env, name) {
  var data = await api(env, "GET", "/v2/blog/" + encodeURIComponent(blogName(name)) + "/info");
  return mapBlog(obj(data && data.blog, "blog"), env.origin);
}

async function relationFor(env, key) {
  var data = await api(env, "GET", "/v2/blog/" + encodeURIComponent(blogName(key.id)) + "/info");
  var blog = obj(data && data.blog, "blog");
  return { profileKey: { id: key.id, host: key.host }, following: blog.followed === true };
}

async function createPost(env, content, files, reblog, tags) {
  var body = { content: content, state: "published" };
  if (reblog) Object.keys(reblog).forEach(function (k) { body[k] = reblog[k]; });
  if (tags && tags.length) body.tags = tags.join(",");
  var path = "/v2/blog/" + encodeURIComponent(env.cred.primaryBlog) + "/posts";
  if (files && files.length) {
    var parts = [{ type: "text", name: "json", value: JSON.stringify(body), contentType: "application/json" }].concat(files);
    return api(env, "POST", path, { multipart: parts, timeoutMillis: 120000 });
  }
  return api(env, "POST", path, { json: body });
}

// ----------------------------------------------------------------- mapping

function safeMapPostItem(raw, env) {
  // Skip individual malformed posts instead of failing the whole page.
  if (!raw || typeof raw !== "object" || !(raw.id_string || raw.id) || !(raw.blog || raw.blog_name)) return null;
  return mapPostItem(raw, env);
}

function mapPostItem(raw, env) {
  var id = String(raw.id_string || raw.id || "");
  var blog = raw.blog && typeof raw.blog === "object" ? raw.blog : { name: raw.blog_name };
  if (!id || !blog.name) invalidResponse("Tumblr returned an invalid post");
  var key = { id: blog.name + "/" + id, host: env.host };
  var createdAt = fromEpoch(raw.timestamp);
  var poster = mapBlog(blog, env.origin);

  var ownMedia = [];
  var ownHtml = renderNpf(raw.content, raw.layout, key.id, ownMedia);
  var trail = asArray(raw.trail).filter(function (t) { return t && (t.content || t.blog || t.broken_blog_name); });
  var parents = trail.map(function (entry, i) { return mapTrailEntry(entry, i, key, createdAt, env); });

  var post = {
    key: key,
    createdAt: createdAt,
    content: { format: "html", value: ownHtml + tagsHtml(raw.tags) },
    media: ownMedia.slice(0, 100),
    visibility: raw.state === "private" ? "followers" : "public",
    actions: postActions(raw, env),
  };
  var url = httpsUrl(raw.post_url);
  if (url) post.url = url;
  var likes = count(raw.like_count);
  var reblogs = count(raw.reblog_count);
  var replies = count(raw.reply_count);
  if (likes) post.favouritesCount = likes;
  if (reblogs) post.repostsCount = reblogs;
  if (replies) post.repliesCount = replies;

  var isNakedReblog = !ownHtml && !ownMedia.length && parents.length > 0;
  if (isNakedReblog) {
    // Show the newest trail entry as the post body, credited to its author,
    // with "<poster> reblogged" above it. Actions still target this reblog.
    var top = parents.pop();
    post.author = top.post.author;
    post.content = { format: "html", value: top.post.content.value + tagsHtml(raw.tags) };
    post.media = top.post.media;
    var presentation = {
      message: { key: { id: "reblog:" + key.id, host: env.host }, createdAt: createdAt, actor: poster, kind: "Repost" },
    };
    if (parents.length) presentation.inlineParents = parents;
    return { type: "post", post: post, presentation: presentation };
  }
  post.author = poster;
  var item = { type: "post", post: post };
  if (parents.length) item.presentation = { inlineParents: parents };
  return item;
}

function mapTrailEntry(entry, index, parentKey, createdAt, env) {
  var blog = entry.blog && entry.blog.name ? entry.blog : { name: entry.broken_blog_name || "unknown" };
  var postId = entry.post && (entry.post.id_string || entry.post.id);
  var media = [];
  var html = renderNpf(entry.content, entry.layout, parentKey.id + "-t" + index, media);
  var post = {
    key: { id: postId ? blog.name + "/" + String(postId) : parentKey.id + "#trail" + index, host: env.host },
    author: mapBlog(blog, env.origin),
    createdAt: createdAt,
    content: { format: "html", value: html },
    media: media.slice(0, 100),
  };
  // Broken trail entries have no post to open.
  if (!postId) post.detailType = "tumblr-trail";
  else if (blog.url) {
    var url = httpsUrl(String(blog.url).replace(/\/$/, "") + "/" + postId);
    if (url) post.url = url;
  }
  return { post: post };
}

function postActions(raw, env) {
  var token = actionToken(raw);
  var liked = raw.liked === true;
  var canReblog = raw.can_reblog !== false && !!token;
  var actions = [
    { action: "Reply", enabled: canReblog },
    { action: "Repost", enabled: canReblog, actionToken: token || undefined },
    { action: liked ? "Unfavourite" : "Favourite", active: liked, enabled: raw.can_like !== false && !!token, actionToken: token || undefined },
  ];
  var blogName_ = (raw.blog && raw.blog.name) || raw.blog_name;
  if (blogName_ && env.ownBlogs[blogName_]) actions.push({ action: "Delete" });
  return actions.map(stripUndefined);
}

function actionToken(raw) {
  if (!raw.reblog_key) return null;
  return JSON.stringify({ k: String(raw.reblog_key), u: String((raw.blog && raw.blog.uuid) || "") });
}

function parseActionToken(value) {
  if (!value) return null;
  var parsed = parseJson(value, true);
  if (!parsed || !parsed.k || !parsed.u) return null;
  return { reblogKey: String(parsed.k), uuid: String(parsed.u) };
}

function mapBlog(blog, origin) {
  var name = String(blog.name);
  var profile = {
    key: { id: name, host: originHost(origin) },
    handle: "@" + name,
    displayName: String(blog.title && String(blog.title).trim() ? blog.title : name),
    avatarUrl: avatarFor(blog),
  };
  var url = httpsUrl(blog.url) || "https://" + name + ".tumblr.com/";
  profile.url = url;
  if (blog.description) profile.description = { format: "html", value: String(blog.description) };
  if (typeof blog.posts === "number") profile.postsCount = count(blog.posts);
  var header = blog.theme && httpsUrl(blog.theme.header_image_focused || blog.theme.header_image);
  if (header) profile.bannerUrl = header;
  return profile;
}

function avatarFor(blog) {
  var list = asArray(blog.avatar).filter(function (a) { return a && httpsUrl(a.url); });
  list.sort(function (a, b) { return Math.abs((a.width || 0) - 128) - Math.abs((b.width || 0) - 128); });
  if (list[0]) return httpsUrl(list[0].url);
  return API + "/v2/blog/" + encodeURIComponent(blog.name) + "/avatar/128";
}

function minimalBlog(name, env) {
  return mapBlog({ name: name }, env.origin);
}

function mapNote(note, parentKey, env) {
  if (!note || !note.blog_name) return null;
  var author = minimalBlog(String(note.blog_name), env);
  var createdAt = fromEpoch(note.timestamp);
  if (note.type === "reply") {
    var text = String(note.reply_text || note.added_text || "");
    return {
      type: "post",
      post: {
        key: { id: parentKey.id + "#reply-" + note.blog_name + "-" + note.timestamp, host: env.host },
        author: author,
        createdAt: createdAt,
        content: { format: "html", value: formatText(text, note.formatting) },
        replyTo: parentKey,
        // Replies are notes, not posts, so there is no detail page to open.
        detailType: "tumblr-note",
      },
    };
  }
  if (note.type === "reblog" && note.post_id) {
    var added = String(note.added_text || "");
    var reblog = {
      type: "post",
      post: {
        key: { id: note.blog_name + "/" + String(note.post_id), host: env.host },
        author: author,
        createdAt: createdAt,
        content: { format: "html", value: added ? "<p>" + esc(added) + "</p>" : "" },
        replyTo: parentKey,
      },
    };
    if (!added) {
      reblog.presentation = {
        message: { key: { id: "note:" + note.blog_name + "/" + note.post_id, host: env.host }, createdAt: createdAt, actor: author, kind: "Repost" },
      };
    }
    return reblog;
  }
  return null;
}

function mapNotification(n, env) {
  if (!n || !n.type) return null;
  var host = env.host;
  var createdAt = fromEpoch(n.timestamp);
  var actorName = n.from_tumblelog_name;
  var message = { key: { id: "n:" + String(n.id || n.type + "-" + n.timestamp + "-" + actorName), host: host }, createdAt: createdAt };
  if (actorName) message.actor = minimalBlog(String(actorName), env);
  var said = String(n.reply_text || n.added_text || "").trim();
  var short = said.length > 200 ? said.slice(0, 197) + "..." : said;
  var kinds = {
    like: "Favourite",
    reply: "Reply",
    follow: "Follow",
    mention_in_reply: "Mention",
    mention_in_post: "Mention",
    reblog_naked: "Repost",
    reblog_with_content: "Repost",
  };
  if (n.type === "reply" && short) message.text = "replied: “" + short + "”";
  else if (n.type === "reblog_with_content" && short) message.text = "reblogged and added: “" + short + "”";
  else if (n.type === "ask") message.text = "sent you an ask";
  else if (n.type === "answered_ask") message.text = "answered your ask";
  else if (kinds[n.type]) message.kind = kinds[n.type];
  else message.unknownType = String(n.type);

  var targetBlog = n.target_tumblelog_name || env.cred.primaryBlog;
  if (n.type === "reblog_with_content" && n.post_id && actorName) {
    message.target = { type: "post", key: { id: actorName + "/" + String(n.post_id), host: host } };
  } else if (n.target_post_id) {
    message.target = { type: "post", key: { id: targetBlog + "/" + String(n.target_post_id), host: host } };
  } else if (message.actor) {
    message.target = { type: "profile", key: message.actor.key };
  }
  return { type: "message", message: message };
}

// ------------------------------------------------------------ NPF -> HTML

function renderNpf(blocks, layout, idPrefix, media) {
  var list = asArray(blocks);
  if (!list.length) return "";
  var askBlocks = {};
  var askOwner = null;
  asArray(layout).forEach(function (entry) {
    if (entry && entry.type === "ask") {
      asArray(entry.blocks).forEach(function (i) { askBlocks[i] = true; });
      var who = entry.attribution && entry.attribution.blog && entry.attribution.blog.name;
      askOwner = who ? String(who) : "Anonymous";
    }
  });
  var askHtml = [];
  var mainHtml = [];
  var listState = { tag: null };
  list.forEach(function (block, index) {
    var target = askBlocks[index] ? askHtml : mainHtml;
    renderBlock(block, idPrefix + "-" + index, media, target, listState);
  });
  closeList(mainHtml, listState);
  var html = "";
  if (askHtml.length) {
    html += "<blockquote><p><b>" + esc(askOwner || "Anonymous") + "</b> asked:</p>" + askHtml.join("") + "</blockquote>";
  }
  return html + mainHtml.join("");
}

function closeList(out, state) {
  if (state.tag) out.push("</" + state.tag + ">");
  state.tag = null;
}

function renderBlock(block, id, media, out, state) {
  if (!block || typeof block !== "object") return;
  var type = block.type;
  if (type === "text" && typeof block.text === "string") {
    var body = formatText(block.text, block.formatting);
    var sub = block.subtype;
    if (sub === "unordered-list-item" || sub === "ordered-list-item") {
      var tag = sub === "ordered-list-item" ? "ol" : "ul";
      if (state.tag !== tag) {
        closeList(out, state);
        out.push("<" + tag + ">");
        state.tag = tag;
      }
      out.push("<li>" + body + "</li>");
      return;
    }
    closeList(out, state);
    if (sub === "heading1") out.push("<h3>" + body + "</h3>");
    else if (sub === "heading2") out.push("<h4>" + body + "</h4>");
    else if (sub === "quote" || sub === "indented") out.push("<blockquote><p>" + body + "</p></blockquote>");
    else if (sub === "chat") out.push("<p><code>" + body + "</code></p>");
    else out.push("<p>" + body + "</p>");
    return;
  }
  closeList(out, state);
  if (type === "image") {
    var variants = asArray(block.media).filter(function (m) { return m && httpsUrl(m.url); });
    if (!variants.length) return;
    var best = variants[0];
    var preview = variants.filter(function (m) { return (m.width || 0) <= 640; })[0];
    var item = { id: id, type: best.type === "image/gif" ? "gif" : "image", url: httpsUrl(best.url) };
    if (preview && preview !== best && best.type !== "image/gif") item.previewUrl = httpsUrl(preview.url);
    if (block.alt_text) item.description = String(block.alt_text);
    if (positive(best.width)) item.width = best.width;
    if (positive(best.height)) item.height = best.height;
    media.push(item);
    if (block.caption) out.push("<p><small>" + esc(block.caption) + "</small></p>");
  } else if (type === "video") {
    var m = block.media && !Array.isArray(block.media) ? block.media : asArray(block.media)[0];
    var poster = asArray(block.poster)[0];
    if (m && httpsUrl(m.url)) {
      var video = { id: id, type: "video", url: httpsUrl(m.url) };
      if (poster && httpsUrl(poster.url)) video.previewUrl = httpsUrl(poster.url);
      if (positive(m.width)) video.width = m.width;
      if (positive(m.height)) video.height = m.height;
      media.push(video);
    } else if (httpsUrl(block.url)) {
      out.push(linkHtml(block.url, (block.embed_iframe && block.embed_iframe.title) || block.url));
    }
  } else if (type === "audio") {
    var audioUrl = httpsUrl(block.media && !Array.isArray(block.media) ? block.media.url : block.url);
    var label = [block.artist, block.title].filter(function (x) { return typeof x === "string" && x; }).join(" – ");
    if (audioUrl && block.provider === "tumblr") {
      var audio = { id: id, type: "audio", url: audioUrl };
      if (label) audio.description = label;
      media.push(audio);
      if (label) out.push("<p>♫ " + esc(label) + "</p>");
    } else if (audioUrl || httpsUrl(block.url)) {
      out.push(linkHtml(audioUrl || block.url, "♫ " + (label || "Audio")));
    }
  } else if (type === "link" && httpsUrl(block.url)) {
    out.push(linkHtml(block.url, block.title || block.display_url || block.url));
    if (block.description) out.push("<p><small>" + esc(block.description) + "</small></p>");
  } else if (type === "poll" && block.question) {
    var answers = asArray(block.answers).map(function (a) { return "<li>" + esc(a && a.answer_text || "") + "</li>"; });
    out.push("<p><b>" + esc(block.question) + "</b></p><ul>" + answers.join("") + "</ul>");
  }
}

function linkHtml(url, label) {
  return '<p><a href="' + esc(httpsUrl(url) || "") + '">' + esc(label) + "</a></p>";
}

/** Applies NPF inline formatting. Ranges are Unicode code point offsets. */
function formatText(text, formatting) {
  var chars = Array.from(String(text));
  var ranges = [];
  asArray(formatting).forEach(function (f) {
    if (!f || typeof f.start !== "number" || typeof f.end !== "number" || f.end <= f.start) return;
    var open = "";
    var close = "";
    if (f.type === "bold") { open = "<b>"; close = "</b>"; }
    else if (f.type === "italic") { open = "<i>"; close = "</i>"; }
    else if (f.type === "strikethrough") { open = "<s>"; close = "</s>"; }
    else if (f.type === "small") { open = "<small>"; close = "</small>"; }
    else if (f.type === "link" && httpsUrl(f.url)) { open = '<a href="' + esc(httpsUrl(f.url)) + '">'; close = "</a>"; }
    else if (f.type === "mention" && f.blog && httpsUrl(f.blog.url)) { open = '<a href="' + esc(httpsUrl(f.blog.url)) + '">'; close = "</a>"; }
    if (open) ranges.push({ start: Math.max(0, f.start), end: Math.min(chars.length, f.end), open: open, close: close });
  });
  if (!ranges.length) return esc(text).replace(/\n/g, "<br>");
  var cuts = [0, chars.length];
  ranges.forEach(function (r) { cuts.push(r.start, r.end); });
  cuts = cuts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
  var html = "";
  for (var i = 0; i < cuts.length - 1; i++) {
    var from = cuts[i];
    var to = cuts[i + 1];
    if (to <= from) continue;
    var segment = esc(chars.slice(from, to).join("")).replace(/\n/g, "<br>");
    ranges.forEach(function (r) {
      if (r.start <= from && r.end >= to) segment = r.open + segment + r.close;
    });
    html += segment;
  }
  return html;
}

function tagsHtml(tags) {
  var list = asArray(tags).filter(function (t) { return typeof t === "string" && t.trim(); });
  if (!list.length) return "";
  return "<p>" + list.map(function (t) {
    return '<a href="https://www.tumblr.com/tagged/' + encodeURIComponent(t) + '">#' + esc(t) + "</a>";
  }).join(" ") + "</p>";
}

/** Splits composer text into NPF text blocks; a last line of only #tags becomes post tags. */
function textBlocks(text) {
  var lines = String(text).replace(/\r\n/g, "\n").split("\n");
  var tags = [];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  var last = lines.length ? lines[lines.length - 1].trim() : "";
  if (last && /^(#[^#]+)+$/.test(last.replace(/\s+#/g, "#"))) {
    tags = last.split("#").map(function (t) { return t.trim(); }).filter(Boolean);
    lines.pop();
  }
  var content = [];
  lines.join("\n").split(/\n{2,}/).forEach(function (para) {
    var trimmed = para.replace(/^\n+|\n+$/g, "");
    if (trimmed.trim()) content.push({ type: "text", text: trimmed });
  });
  return { content: content, tags: tags };
}

// ---------------------------------------------------------------- helpers

function fail(code, message) {
  throw flare.error({ code: code, message: { value: message } });
}
function validationError(message) { fail("Validation", message); }
function invalidResponse(message) { fail("InvalidResponse", message); }
function unsupported(message) { fail("Unsupported", message); }
function notFound(message) { fail("NotFound", message); }

function need(value, message) {
  var text = String(value == null ? "" : value).trim();
  if (!text) validationError(message);
  return text;
}

function obj(value, what) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse("Tumblr returned an invalid " + what);
  return value;
}

function stripUndefined(a) {
  var copy = {};
  Object.keys(a).forEach(function (k) { if (a[k] !== undefined) copy[k] = a[k]; });
  return copy;
}

function originHost(origin) {
  return String(origin).slice("https://".length).toLowerCase();
}

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  var text = value.trim();
  return /^https:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/i.test(text) ? text : null;
}

function addQuery(url, values) {
  var pairs = [];
  Object.keys(values || {}).forEach(function (key) {
    var raw = values[key];
    if (raw == null || raw === "") return;
    (Array.isArray(raw) ? raw : [raw]).forEach(function (item) {
      pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(item)));
    });
  });
  if (!pairs.length) return url;
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + pairs.join("&");
}

function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fromEpoch(seconds) {
  var n = Number(seconds);
  return new Date(Number.isFinite(n) ? n * 1000 : 0).toISOString();
}

function asArray(value) { return Array.isArray(value) ? value : []; }
function positive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function count(value) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function clamp(value, min, max) {
  var n = Number(value);
  if (!Number.isFinite(n)) n = min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
