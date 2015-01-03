
# Guild

Work in progress

## Setup and Install

The Guild is a Node.js app (v0.11.x) that talks to a Postgres database.

- Download the repository and enter the directory that it created:

        git clone git@github.com:danneu/guild.git
        cd guild

- Enter the `guild` directory and install its dependencies:

        npm install

- Launch Postgres (by default it will run on `http://localhost:5432`) and create an empty database named `guild`.

- The Guild comes with a command that rebuilds the database with tables and fills them with some data to play with:

        npm run-script reset-db

- Now you can launch the server:

        npm start
        > Listening on http://localhost:3000

## Config and Environment Variables

The Guild is configured with environment variable listed in [server/config.js](https://github.com/danneu/guild/blob/master/server/config.js).

It will run with the default variables, but some features are turned off until they are configured:

- Email-sending system requires `AWS_KEY` and `AWS_SECRET` (your http://aws.amazon.com/ API creds)
- User registration system requires `RECAPTCHA_SITEKEY` and `RECAPTCHA_SITESECRET` (your https://www.google.com/recaptcha/intro/index.html API creds)

## TODO

- Add tests for authorization abstraction
- Consider merging post and pm logic (db fns, routes, views)
