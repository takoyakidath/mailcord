# Privacy Policy — mailcord

Last updated: 2026-11-19

mailcord is a personal tool that forwards email notifications to a Discord
server that the user administers. This policy describes what data the
application accesses and how it is used.

## Data the application accesses

When a user connects a Gmail account with `/mail bind-gmail`, mailcord
accesses the account through the Gmail API using the
`https://www.googleapis.com/auth/gmail.metadata` scope. With this scope the
application can only retrieve message metadata:

- Subject line
- Sender address
- Date and other header information
- A link to the message in Gmail

The application does **not** access, download, or store email bodies or
attachments. The metadata-only scope makes such access technically
impossible for the application.

For email received through Resend on domains the user owns, message content
is processed only to deliver it to the Discord channel the user configured.

## How the data is used

- Metadata of new messages is forwarded to the Discord channel designated
  by the user.
- OAuth refresh tokens are stored encrypted in the application's local
  database, solely to keep the connection working.
- Data is never sold, shared with third parties for marketing, or used for
  advertising.

## Data retention and removal

A user can disconnect a Gmail account at any time with the unbind command
in Discord, which deletes the stored tokens and stops all access. Revoking
access from the Google Account permissions page also immediately stops the
application.

## Contact

For questions about this policy, contact the repository owner via
[GitHub](https://github.com/takoyakidath/mailcord).
