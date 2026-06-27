// 3rd
import assert from "assert";
// 1st
import * as config from "../config";

////////////////////////////////////////////////////////////

// Returns Promise<boolean>
export async function checkComment({
  userIp,
  userAgent,
  commentType,
  commentAuthor,
  commentAuthorEmail,
  commentContent,
}: {
  userIp: string;
  userAgent: string;
  commentType: string;
  commentAuthor: string;
  commentAuthorEmail: string;
  commentContent: string;
}) {
  if (!config.AKISMET_KEY) {
    throw new Error("[checkComment] AKISMET_KEY must be set");
  }

  assert(userIp);
  assert(userAgent);
  assert(commentAuthor);
  assert(commentContent);
  assert(
    [
      "comment", // blog comment
      "forum-post", // top-level forum post
      "reply", // reply to top-level forum post
      "blog-post",
      "contact-form",
      "signup", // new user account
      "message", // message sent between just a few users
    ].includes(commentType),
  );

  const url = `https://${
    config.AKISMET_KEY
  }.rest.akismet.com/1.1/comment-check`;

  const form = new FormData();
  form.append("blog", "https://roleplayerguild.com");
  form.append("user_ip", userIp);
  form.append("user_agent", userAgent);
  form.append("comment_author", commentAuthor);
  form.append("comment_type", commentType);
  form.append("blog_lang", "en");
  form.append("blog_charset", "UTF-8");

  if (config.NODE_ENV !== "production") {
    form.append("is_test", "true");
  }

  // Optional

  if (commentContent) {
    form.append("comment_content", commentContent);
  }
  if (commentAuthorEmail) {
    form.append("comment_author_email", commentAuthorEmail);
  }

  const res = await fetch(url, { method: "POST", body: form });

  // Akismet signals account/request problems via response headers, NOT the
  // HTTP status. A suspended or invalid key still returns 200 with a body of
  // "false" (i.e. "not spam"), which would silently disable spam filtering --
  // every post sails through as ham and nobody notices. Surface these loudly
  // so a dead subscription screams in the logs instead of failing open in
  // silence. (Seen in the wild: x-akismet-error: suspended / alert code 10402
  // when the Akismet subscription lapses.)
  const akismetError = res.headers.get("x-akismet-error");
  const debugHelp = res.headers.get("x-akismet-debug-help");
  if (akismetError || debugHelp) {
    console.error("[checkComment] Akismet returned an error response", {
      error: akismetError,
      alertCode: res.headers.get("x-akismet-alert-code"),
      alertMsg: res.headers.get("x-akismet-alert-msg"),
      debugHelp,
    });
  }

  // "true" => spam. Anything else (incl. "invalid", or "false" returned
  // alongside an error header) is treated as not-spam: fail open.
  const text = await res.text();
  return text === "true";
}
