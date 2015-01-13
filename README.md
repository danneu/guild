
# Guild

Work in progress

## Setup and Install

The Guild is a Node.js app (v0.11.x) that talks to a Postgres database.

- You'll specifically need the latest version of Node v0.11.x (unstable) for your system: http://blog.nodejs.org/2014/09/24/node-v0-11-14-unstable/. The Guild won't run on Node v0.10.x (stable).

- The Guild depends on the `plv8` Postgres extension. Postgres on Linux/OSX comes with it, but so far Windows users have had to either manually install plv8 or just comment out `CREATE EXTENSION IF NOT EXISTS plv8;` and most of the trigger functions in `server/schema.sql` to get the reset-db command to work.

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
- Add `:user/invisible?` -> `users.is_ghost` to migration
