// 3rd party
import nodemailer from "nodemailer";
import assert from "assert";
import nunjucks from "nunjucks";
import createDebug from "debug";
const debug = createDebug("app:emailer");
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
// 1st party
import * as belt from "./belt";
import * as config from "./config";

const FROM = "Mahz <mahz@roleplayerguild.com>";

function getTransporter() {
  assert(config.AWS_KEY, "AWS_KEY must be set to send emails");
  assert(config.AWS_SECRET, "AWS_SECRET must be set to send emails");

  const sesClient = new SESv2Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: config.AWS_KEY,
      secretAccessKey: config.AWS_SECRET,
    },
  });

  const transporter = nodemailer.createTransport({
    SES: { sesClient, SendEmailCommand },
  });

  return transporter;
}

var templates = {
  resetToken: nunjucks.compile(`
<p>Hello {{ uname }},</p>

<p>This link will take you to a form that will let you type in a new password:</p>

<a href="{{ resetPasswordUrl }}">
  {{ resetPasswordUrl }}
</a>

<p>If you did not expect this email, you can ignore it and nothing will happen.</p>
  `),
};

export async function sendResetTokenEmail(
  toUname: string,
  toEmail: string,
  token: string,
): Promise<void> {
  debug("[sendResetTokenEmail]");
  assert(config.HOST, "HOST must be set to send emails");
  assert(URL.canParse(config.HOST), "HOST must be a valid URL to send emails");
  assert(typeof toUname === "string");
  assert(typeof toEmail === "string");
  assert(belt.isValidUuid(token));

  const resetPasswordUrl = new URL(config.HOST);
  resetPasswordUrl.pathname = "/reset-password";
  resetPasswordUrl.searchParams.set("token", token);

  await getTransporter()
    .sendMail({
      from: FROM,
      to: toEmail,
      subject: "Password Reset Token - RoleplayerGuild.com",
      html: templates.resetToken.render({
        uname: toUname,
        resetPasswordUrl,
      }),
    })
    .catch((err) => {
      console.error(`Failed to send reset token email to ${toUname}`, err);
      throw err;
    });
}

// Return promise
export const sendAutoNukeEmail = (() => {
  const template = nunjucks.compile(`
    <p>
      Akismet detected spammer:
      <a href="{{ userUrl }}">{{ slug }}</a>
    </p>
    <blockquote>
      {{ markup }}
    </blockquote>
  `);

  return (slug: string, markup: string) => {
    assert(config.HOST, "HOST must be set to send emails");
    assert(
      URL.canParse(config.HOST),
      "HOST must be a valid URL to send emails",
    );

    const userUrl = new URL(config.HOST);
    userUrl.pathname = `/users/${slug}`;

    return getTransporter()
      .sendMail({
        from: FROM,
        to: "danrodneu@gmail.com",
        subject: `Guild Auto-Nuke: ${slug}`,
        html: template.render({ userUrl: userUrl.toString(), slug, markup }),
      })
      .catch((err) => {
        console.error(`Failed to send auto-nuke email`, err);
        throw err;
      });
  };
})();

const NEW_CONVO_TEMPLATE = nunjucks.compile(`
<p>Hello {{ toUname }},</p>

<p>{{ fromUname }} started a new convo with you: <a href="{{ convoUrl }}">{{ convoTitle }}</a></p>

<p>They said:</p>

<blockquote>
{{ messagePreview }}
</blockquote>

<p>* * *</p>

<p><a href="{{ convoUrl }}">View the convo</a></p>

<hr/>

<p>You are receiving this because you opted in to email notifications.</p>
<p><a href="{{ notificationSettingsUrl }}">Manage notifications</a></p>

<p>
 &lt;3 GuildBot from <a href="https://roleplayerguild.com">RoleplayerGuild.com</a>
</p>
`);

function renderNewConvoEmail({
  fromUname,
  toUname,
  messagePreview,
  convoTitle,
  convoUrl,
  notificationSettingsUrl,
}: {
  fromUname: string;
  toUname: string;
  messagePreview: string;
  convoTitle: string;
  convoUrl: URL;
  notificationSettingsUrl: URL;
}): string {
  return NEW_CONVO_TEMPLATE.render({
    fromUname,
    toUname,
    messagePreview,
    convoTitle,
    convoUrl: convoUrl.toString(),
    notificationSettingsUrl: notificationSettingsUrl.toString(),
  });
}

export async function sendNewConvoEmails({
  senderUname,
  recipients, // Array of {email, uname} objects
  convoTitle,
  convoId,
  messageMarkup,
  previewLength = 1000,
}: {
  senderUname: string;
  recipients: Array<{ email: string; uname: string }>;
  convoTitle: string;
  convoId: number;
  messageMarkup: string;
  previewLength?: number;
}): Promise<void> {
  const transporter = getTransporter();

  // example.com/convos/123
  const convoUrl = new URL(config.HOST);
  convoUrl.pathname = `/convos/${convoId}`;

  // example.com/me/edit#email
  const notificationSettingsUrl = new URL(config.HOST);
  notificationSettingsUrl.pathname = "/me/edit";
  notificationSettingsUrl.hash = "email";

  // Truncate title to 20 characters
  const TITLE_LENGTH = 20;
  const truncatedTitle =
    convoTitle.slice(0, TITLE_LENGTH) +
    (convoTitle.length > TITLE_LENGTH ? "..." : "");

  // Send individual emails to each recipient
  const promises = recipients.map((recipient) => {
    return transporter
      .sendMail({
        from: FROM,
        to: recipient.email, // Direct to each person
        subject: `${senderUname} started a new convo with you: ${truncatedTitle}`,
        html: renderNewConvoEmail({
          fromUname: senderUname,
          toUname: recipient.uname,
          messagePreview:
            messageMarkup.slice(0, previewLength) +
            (messageMarkup.length > previewLength ? "..." : ""),
          convoTitle,
          convoUrl,
          notificationSettingsUrl,
        }),
      })
      .catch((err) => {
        console.error(`Failed to send email to ${recipient.email}:`, err);
        // Don't throw - let other emails continue
      });
  });

  await Promise.all(promises);
}

////////////////////////////////////////////////////////////
// Verify Email

const VERIFY_EMAIL_TEMPLATE = nunjucks.compile(`
<p>Hi {{ uname }},</p>

<p>To verify that this is the email address of your roleplayerguild.com account, click the following link:</p>

<a href="{{ verifyEmailUrl }}">
  {{ verifyEmailUrl }}
</a>

<p>This lets you receive email notifications when other forum members send you messages.</p>

<p>If you weren't expecting this email, you can safely delete it. It's possible that someone made a mistake while typing their email address.</p>

<p>
- @Mahz <mahz@roleplayerguild.com>
</p>
`);

export async function sendEmailVerificationLinkEmail({
  toUname,
  toEmail,
  token,
}: {
  toUname: string;
  toEmail: string;
  token: string;
}): Promise<void> {
  const transporter = getTransporter();

  const verifyEmailUrl = new URL(config.HOST);
  verifyEmailUrl.pathname = "/verify-email";
  verifyEmailUrl.searchParams.set("token", token);
  verifyEmailUrl.searchParams.set("email", toEmail);

  await transporter.sendMail({
    from: FROM,
    to: toEmail,
    subject: "Verify your email address to enable email notifications",
    html: VERIFY_EMAIL_TEMPLATE.render({ uname: toUname, verifyEmailUrl }),
  });
}
